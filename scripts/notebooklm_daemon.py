"""
NotebookLM daemon — aiohttp server on 127.0.0.1:$NOTEBOOKLM_PORT.

Routes:
  POST /ask     — run a NotebookLM query, optionally reusing a warm session
  GET  /list    — list notebooks in the upstream library (Task 5)
  GET  /search  — search library by query (Task 5)
  GET  /health  — readiness + stats
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Awaitable, Callable, Optional

from aiohttp import web

from notebooklm_ask_adapter import AskResult, ask_on_page as default_ask_on_page, ensure_session
from notebooklm_session_pool import PoolConfig, SessionPool

LOG = logging.getLogger("notebooklm-daemon")

STARTED_AT_MONOTONIC = time.monotonic()

ResolveNotebook = Callable[[Optional[str], Optional[str]], Optional[dict[str, Any]]]
AskOnPage = Callable[[Any, str], Awaitable[AskResult]]


def _default_resolve_notebook(nid: Optional[str], url: Optional[str]) -> Optional[dict[str, Any]]:
    """Resolve (id, url) to {id, name, url} using upstream's NotebookLibrary.

    Precedence: id wins if both provided. Falls back to active notebook.
    """
    from notebook_manager import NotebookLibrary  # upstream
    lib = NotebookLibrary()
    if nid:
        nb = lib.get_notebook(nid)
        if nb:
            return {"id": nb["id"], "name": nb.get("name"), "url": nb["url"]}
        return None
    if url:
        return {"id": None, "name": None, "url": url}
    active = lib.get_active_notebook()
    if active:
        return {"id": active["id"], "name": active.get("name"), "url": active["url"]}
    return None


def build_app(
    pool: SessionPool | None = None,
    ask_on_page: AskOnPage | None = None,
    resolve_notebook: ResolveNotebook | None = None,
) -> web.Application:
    if pool is None:
        config = PoolConfig(
            max_warm=int(os.environ.get("NOTEBOOKLM_MAX_WARM", "3")),
            idle_seconds=float(os.environ.get("NOTEBOOKLM_IDLE_SECONDS", "90")),
            warm_enabled=os.environ.get("NOTEBOOKLM_WARM_SESSIONS", "1") != "0",
        )

        async def launcher(url: str):
            return await ensure_session(url)

        pool = SessionPool(config, launcher=launcher)

    app = web.Application()
    app["pool"] = pool
    app["ask_on_page"] = ask_on_page or default_ask_on_page
    app["resolve_notebook"] = resolve_notebook or _default_resolve_notebook
    app["stats"] = {"warm_hits": 0, "warm_misses": 0}
    app.router.add_get("/health", handle_health)
    app.router.add_post("/ask", handle_ask)

    async def _on_startup(app_: web.Application) -> None:
        app_["pool"].start_background_gc()

    async def _on_cleanup(app_: web.Application) -> None:
        await app_["pool"].shutdown()

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)
    return app


async def handle_health(request: web.Request) -> web.Response:
    stats = request.app["stats"]
    pool: SessionPool = request.app["pool"]
    return web.json_response(
        {
            "ok": True,
            "authenticated": _check_auth(),
            "active_notebook": _active_notebook_summary(),
            "warm_sessions": pool.snapshot(),
            "warm_hits": stats["warm_hits"],
            "warm_misses": stats["warm_misses"],
            "uptime_s": int(time.monotonic() - STARTED_AT_MONOTONIC),
        }
    )


async def handle_ask(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"error": "invalid JSON body"}, status=400)

    question = payload.get("question")
    if not isinstance(question, str) or not question.strip():
        return web.json_response({"error": "`question` is required"}, status=400)

    nid = payload.get("notebook_id") or None
    url = payload.get("notebook_url") or None

    resolve = request.app["resolve_notebook"]
    notebook = resolve(nid, url)
    if notebook is None:
        return web.json_response(
            {
                "error": "notebook not found; provide notebook_id or notebook_url, or set an active notebook",
                "hint": "Use notebooklm_list to see available notebooks",
            },
            status=400,
        )

    pool: SessionPool = request.app["pool"]
    ask = request.app["ask_on_page"]
    stats = request.app["stats"]
    nb_url = notebook["url"]

    # First attempt (may be warm hit or cache miss).
    session = await pool.acquire(nb_url)
    try:
        result = await ask(session.page, question)
    except Exception as exc:  # noqa: BLE001
        was_hit = session.hit
        # Broken page — get it out of the cache either way.
        await pool.release(session)
        await pool.evict(nb_url)

        if not was_hit:
            # Initial launch path — spec says no retry; surface immediately.
            return web.json_response(
                {"error": f"ask failed: {exc}", "hint": "check daemon logs"},
                status=500,
            )

        # Reuse failure — one retry with fresh Chromium.
        LOG.warning("Reuse failure on %s: %s — retrying fresh", nb_url, exc)
        retry_session = await pool.acquire(nb_url)
        try:
            result = await ask(retry_session.page, question)
        except Exception as exc2:  # noqa: BLE001
            # Evict before release so we never briefly re-cache a broken session.
            await pool.evict(nb_url)
            await pool.release(retry_session)
            return web.json_response(
                {"error": f"ask failed after retry: {exc2}", "hint": "check daemon logs"},
                status=500,
            )
        # Retry succeeded — release (re-cache) and report as miss.
        stats["warm_misses"] += 1
        await pool.release(retry_session)
        return web.json_response(
            {
                "answer": result.answer,
                "citations": result.citations,
                "notebook": notebook,
                "warm_hit": False,
            }
        )

    # First attempt succeeded.
    if session.hit:
        stats["warm_hits"] += 1
    else:
        stats["warm_misses"] += 1
    await pool.release(session)
    return web.json_response(
        {
            "answer": result.answer,
            "citations": result.citations,
            "notebook": notebook,
            "warm_hit": session.hit,
        }
    )


def _check_auth() -> bool:
    try:
        from auth_manager import AuthManager  # upstream
        return bool(AuthManager().is_authenticated())
    except Exception:  # noqa: BLE001
        return False


def _active_notebook_summary() -> Optional[dict[str, Any]]:
    try:
        from notebook_manager import NotebookLibrary  # upstream
        nb = NotebookLibrary().get_active_notebook()
        if not nb:
            return None
        return {"id": nb["id"], "name": nb.get("name"), "url": nb["url"]}
    except Exception:  # noqa: BLE001
        return None


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("NOTEBOOKLM_LOG_LEVEL", "INFO"),
        format="[NOTEBOOKLM] %(asctime)s %(levelname)s %(message)s",
    )
    port = int(os.environ.get("NOTEBOOKLM_PORT", "11435"))
    app = build_app()
    LOG.info("Starting daemon on 127.0.0.1:%d", port)
    web.run_app(app, host="127.0.0.1", port=port, access_log=None)


if __name__ == "__main__":
    main()
