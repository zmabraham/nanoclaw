"""
NotebookLM daemon — aiohttp server on 127.0.0.1:$NOTEBOOKLM_PORT.

Exposes /ask, /list, /search, /health. Wraps the upstream notebooklm-skill
modules so the per-query browser-spawn cost is amortized by keeping
Python imports warm, while preserving the user preference of a fresh
Chromium per unique-notebook query stream.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any

from aiohttp import web

LOG = logging.getLogger("notebooklm-daemon")

STARTED_AT_MONOTONIC = time.monotonic()


def build_app() -> web.Application:
    app = web.Application()
    app["stats"] = {"warm_hits": 0, "warm_misses": 0}
    app.router.add_get("/health", handle_health)
    return app


async def handle_health(request: web.Request) -> web.Response:
    stats = request.app["stats"]
    return web.json_response(
        {
            "ok": True,
            "authenticated": False,  # populated in Task 5
            "active_notebook": None,
            "warm_sessions": [],     # populated in Task 2 integration
            "warm_hits": stats["warm_hits"],
            "warm_misses": stats["warm_misses"],
            "uptime_s": int(time.monotonic() - STARTED_AT_MONOTONIC),
        }
    )


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
