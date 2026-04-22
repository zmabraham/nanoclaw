# /add-notebooklm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a NanoClaw `/add-notebooklm` installer skill that exposes NotebookLM (private-account, browser-grounded Q&A) to the main-group agent with low per-query latency via a warm-Python host daemon and same-notebook session reuse with fallback.

**Architecture:** Container-side MCP stdio bridge → `host.docker.internal:$NOTEBOOKLM_PORT` → aiohttp daemon on host → upstream skill modules at `~/.claude/skills/notebooklm/` → fresh Chromium per unique-notebook query (reused for same-notebook follow-ups within idle window). State (auth cookies, notebook library, venv) lives host-side. Main group only.

**Tech Stack:** Python 3.10+, aiohttp, patchright (via upstream skill), asyncio locks, TypeScript (MCP SDK), vitest, pytest, launchd (macOS) / systemd user (Linux).

**Spec:** `docs/superpowers/specs/2026-04-22-notebooklm-skill-design.md`

---

## File structure

**New files (under `feature/add-notebooklm-skill` branch):**

```
.claude/skills/add-notebooklm/SKILL.md          # installer skill (Claude Code)
scripts/notebooklm-daemon.py                    # aiohttp server entrypoint
scripts/notebooklm_session_pool.py              # WarmSession, SessionPool
scripts/notebooklm_ask_adapter.py               # ensure_session / ask_on_page split
scripts/requirements-notebooklm.txt             # aiohttp dependency
scripts/notebooklm-watch.sh                     # optional macOS watcher
scripts/tests/__init__.py
scripts/tests/test_session_pool.py
scripts/tests/test_ask_adapter.py
scripts/tests/test_daemon_endpoints.py
scripts/tests/conftest.py                       # pytest fixtures (mock upstream)
launchd/com.nanoclaw.notebooklm.plist           # macOS supervisor template
setup/systemd/nanoclaw-notebooklm.service       # Linux supervisor template
container/agent-runner/src/notebooklm-mcp-stdio.ts   # MCP stdio ↔ HTTP bridge
```

**Modified files:**

```
container/agent-runner/src/index.ts             # conditional MCP registration on isMain
src/container-runner.ts                         # [NOTEBOOKLM] log surfacing + env propagation
.env.example                                    # add NOTEBOOKLM_* env vars
```

Each Python module has a single responsibility:
- `notebooklm-daemon.py` — HTTP routes only (wires components together)
- `notebooklm_session_pool.py` — pool state, lifecycle (no HTTP, no upstream imports beyond patchright types)
- `notebooklm_ask_adapter.py` — the only module that reaches into upstream's `ask_question.py` internals

Each TypeScript file keeps its existing role; the bridge is isolated from `ipc-mcp-stdio.ts` (different MCP server, different env namespace).

---

## Key pre-implementation context

**Upstream skill structure** (`~/.claude/skills/notebooklm/`):
- `scripts/run.py` — wrapper that auto-creates `.venv`, installs deps, then runs the target script. Dependencies already installed after first run.
- `scripts/ask_question.py` — the monolithic query flow we're splitting.
- `scripts/browser_session.py` — existing browser helpers (reuse when possible).
- `scripts/notebook_manager.py` — library CRUD (we expose list+search as read-only MCP tools).
- `scripts/auth_manager.py` — Google login state (never exposed to agent).
- `data/browser_state/` — persistent cookies (host-only).

**Precedent to mirror:** `.claude/skills/add-ollama-tool/SKILL.md` — same host-daemon + container-MCP-stdio + `host.docker.internal` pattern. Reread it before writing the installer.

**Container → host connectivity:** NanoClaw already adds `--add-host=host.docker.internal:host-gateway` on Linux for Ollama. Reuse; no new flag.

**Env propagation into containers:** `src/container-runner.ts` is the gate. See how `OLLAMA_HOST` is forwarded today (after `upstream/skill/ollama-tool` has been merged). For our case we forward `NOTEBOOKLM_PORT` only — the container hostname is always `host.docker.internal`.

**Test frameworks:**
- Node side: `vitest` (root config includes `src/**/*.test.ts` and `setup/**/*.test.ts`). Run with `npm test`.
- Python side: introduce `pytest` with upstream's `.venv` (dev-only dep in `requirements-notebooklm.txt`). Run with `python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/`.

**Project paths:** repo root is `/home/chassidusaicon/code/nanoclaw/.claude/worktrees/unified-cooking-brook/`. All paths in this plan are relative to that root unless they start with `~` or `/`.

---

## Task 1: Scaffold Python daemon with /health endpoint (TDD)

**Goal:** minimal aiohttp server that answers `/health` with `{ok: true}`. Proves wiring before adding logic.

**Files:**
- Create: `scripts/notebooklm-daemon.py`
- Create: `scripts/requirements-notebooklm.txt`
- Create: `scripts/tests/__init__.py`
- Create: `scripts/tests/conftest.py`
- Create: `scripts/tests/test_daemon_endpoints.py`

- [ ] **Step 1.1: Write requirements file**

Create `scripts/requirements-notebooklm.txt`:

```
aiohttp>=3.9,<4
pytest>=8.0
pytest-aiohttp>=1.0
pytest-asyncio>=0.23
```

- [ ] **Step 1.2: Write failing test for /health**

Create `scripts/tests/__init__.py` as an empty file.

Create `scripts/tests/conftest.py`:

```python
"""Shared pytest fixtures for notebooklm daemon tests."""
import sys
from pathlib import Path

# Allow `import notebooklm_daemon` etc. from scripts/
SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))
```

Create `scripts/tests/test_daemon_endpoints.py`:

```python
"""HTTP endpoint tests for the NotebookLM daemon."""
import pytest
from aiohttp.test_utils import TestClient, TestServer

import importlib


@pytest.fixture
async def client():
    module = importlib.import_module('notebooklm-daemon'.replace('-', '_'))
    app = module.build_app()
    async with TestClient(TestServer(app)) as c:
        yield c


async def test_health_returns_ok(client):
    resp = await client.get('/health')
    assert resp.status == 200
    body = await resp.json()
    assert body['ok'] is True
    assert 'authenticated' in body
    assert 'warm_sessions' in body
    assert 'warm_hits' in body
    assert 'warm_misses' in body
    assert 'uptime_s' in body
```

Note: the daemon filename uses a hyphen (`notebooklm-daemon.py`) by convention, but Python imports require an underscore. We'll alias via `scripts/tests/conftest.py`'s `sys.path` and rename the module file to `notebooklm_daemon.py` — cleaner than `importlib` gymnastics. **Rename plan:** use `scripts/notebooklm_daemon.py` (underscore). Launchd/systemd units invoke it by full path anyway.

Revise `scripts/tests/test_daemon_endpoints.py` imports:

```python
"""HTTP endpoint tests for the NotebookLM daemon."""
import pytest
from aiohttp.test_utils import TestClient, TestServer

from notebooklm_daemon import build_app


@pytest.fixture
async def client():
    app = build_app()
    async with TestClient(TestServer(app)) as c:
        yield c


async def test_health_returns_ok(client):
    resp = await client.get('/health')
    assert resp.status == 200
    body = await resp.json()
    assert body['ok'] is True
    assert 'authenticated' in body
    assert 'warm_sessions' in body
    assert 'warm_hits' in body
    assert 'warm_misses' in body
    assert 'uptime_s' in body
```

- [ ] **Step 1.3: Run the test, verify it fails**

```bash
cd /home/chassidusaicon/code/nanoclaw/.claude/worktrees/unified-cooking-brook
python ~/.claude/skills/notebooklm/scripts/run.py -m pip install -r scripts/requirements-notebooklm.txt
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_daemon_endpoints.py -v
```

Expected: `ModuleNotFoundError: No module named 'notebooklm_daemon'` or `ImportError`.

- [ ] **Step 1.4: Write minimal daemon to make /health pass**

Create `scripts/notebooklm_daemon.py`:

```python
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
```

- [ ] **Step 1.5: Run test to verify it passes**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_daemon_endpoints.py -v
```

Expected: `test_health_returns_ok PASSED`.

- [ ] **Step 1.6: Manually smoke-test the daemon**

```bash
# In one terminal:
NOTEBOOKLM_PORT=11435 python ~/.claude/skills/notebooklm/scripts/run.py scripts/notebooklm_daemon.py &
DAEMON_PID=$!
sleep 1

# In another (or same, after backgrounding):
curl -s http://127.0.0.1:11435/health | python -m json.tool
# Expected: {"ok": true, "authenticated": false, "active_notebook": null, "warm_sessions": [], "warm_hits": 0, "warm_misses": 0, "uptime_s": <N>}

kill $DAEMON_PID
```

- [ ] **Step 1.7: Commit**

```bash
git add scripts/requirements-notebooklm.txt \
        scripts/notebooklm_daemon.py \
        scripts/tests/__init__.py \
        scripts/tests/conftest.py \
        scripts/tests/test_daemon_endpoints.py
git commit -m "feat(notebooklm): aiohttp daemon scaffold with /health endpoint"
```

---

## Task 2: Warm-session pool primitives (TDD)

**Goal:** implement `WarmSession` + `SessionPool` with LRU cap, idle GC, feature flag. All patchright calls are mocked at this layer — real browser integration lands in Task 3.

**Files:**
- Create: `scripts/notebooklm_session_pool.py`
- Create: `scripts/tests/test_session_pool.py`

- [ ] **Step 2.1: Write failing tests for the session pool**

Create `scripts/tests/test_session_pool.py`:

```python
"""Tests for SessionPool LRU + idle-GC + feature-flag behavior."""
import asyncio
import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from notebooklm_session_pool import SessionPool, PoolConfig


@pytest.fixture
def fake_clock():
    """Monotonic-clock replacement so we control time in tests."""
    t = {"value": 1000.0}

    def now() -> float:
        return t["value"]

    def advance(seconds: float) -> None:
        t["value"] += seconds

    now.advance = advance  # type: ignore[attr-defined]
    return now


@pytest.fixture
def fake_launcher():
    """Returns a launch() coroutine that returns unique fake sessions."""
    counter = {"n": 0}

    async def launch(notebook_url: str):
        counter["n"] += 1
        browser = MagicMock(name=f"browser{counter['n']}")
        browser.close = AsyncMock()
        context = MagicMock(name=f"context{counter['n']}")
        context.close = AsyncMock()
        page = MagicMock(name=f"page{counter['n']}")
        return browser, context, page

    launch.calls = counter  # type: ignore[attr-defined]
    return launch


async def test_first_acquire_is_cache_miss(fake_clock, fake_launcher):
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=90), launcher=fake_launcher, clock=fake_clock)
    result = await pool.acquire("https://notebooklm.google.com/notebook/abc")
    try:
        assert result.hit is False
        assert fake_launcher.calls["n"] == 1
    finally:
        await pool.release(result)
    await pool.shutdown()


async def test_second_acquire_same_url_is_cache_hit(fake_clock, fake_launcher):
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=90), launcher=fake_launcher, clock=fake_clock)
    r1 = await pool.acquire("https://x/a")
    await pool.release(r1)
    fake_clock.advance(10)
    r2 = await pool.acquire("https://x/a")
    try:
        assert r2.hit is True
        assert fake_launcher.calls["n"] == 1  # no new launch
    finally:
        await pool.release(r2)
    await pool.shutdown()


async def test_idle_session_is_evicted_by_gc(fake_clock, fake_launcher):
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=30), launcher=fake_launcher, clock=fake_clock)
    r1 = await pool.acquire("https://x/a")
    await pool.release(r1)
    fake_clock.advance(31)
    evicted = await pool.run_gc_once()
    assert evicted == 1
    r2 = await pool.acquire("https://x/a")
    try:
        assert r2.hit is False
        assert fake_launcher.calls["n"] == 2
    finally:
        await pool.release(r2)
    await pool.shutdown()


async def test_lru_eviction_when_over_capacity(fake_clock, fake_launcher):
    pool = SessionPool(PoolConfig(max_warm=2, idle_seconds=9999), launcher=fake_launcher, clock=fake_clock)
    await pool.release(await pool.acquire("https://x/a"))
    fake_clock.advance(1)
    await pool.release(await pool.acquire("https://x/b"))
    fake_clock.advance(1)
    # Adding a 3rd evicts 'a' (least recently used)
    await pool.release(await pool.acquire("https://x/c"))
    # 'a' should be miss again
    r = await pool.acquire("https://x/a")
    try:
        assert r.hit is False
    finally:
        await pool.release(r)
    await pool.shutdown()


async def test_feature_flag_disables_warm_reuse(fake_clock, fake_launcher):
    pool = SessionPool(
        PoolConfig(max_warm=3, idle_seconds=90, warm_enabled=False),
        launcher=fake_launcher,
        clock=fake_clock,
    )
    r1 = await pool.acquire("https://x/a")
    await pool.release(r1)
    r2 = await pool.acquire("https://x/a")
    try:
        assert r1.hit is False
        assert r2.hit is False  # flag off → always miss
        assert fake_launcher.calls["n"] == 2
    finally:
        await pool.release(r2)
    await pool.shutdown()


async def test_concurrent_acquires_same_url_serialize(fake_clock, fake_launcher):
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=90), launcher=fake_launcher, clock=fake_clock)
    r1 = await pool.acquire("https://x/a")

    async def second():
        r = await pool.acquire("https://x/a")
        try:
            return r.hit
        finally:
            await pool.release(r)

    task = asyncio.create_task(second())
    await asyncio.sleep(0.01)
    assert not task.done()  # second is waiting on the per-URL lock
    await pool.release(r1)
    hit = await task
    assert hit is True
    await pool.shutdown()


async def test_evict_closes_browser(fake_clock, fake_launcher):
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=9999), launcher=fake_launcher, clock=fake_clock)
    r = await pool.acquire("https://x/a")
    browser = r.browser
    await pool.release(r)
    await pool.evict("https://x/a")
    browser.close.assert_awaited_once()
    # Re-acquiring produces a new launch
    r2 = await pool.acquire("https://x/a")
    try:
        assert r2.hit is False
    finally:
        await pool.release(r2)
    await pool.shutdown()
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_session_pool.py -v
```

Expected: `ModuleNotFoundError: No module named 'notebooklm_session_pool'`.

- [ ] **Step 2.3: Implement the session pool**

Create `scripts/notebooklm_session_pool.py`:

```python
"""
Warm-session pool for NotebookLM queries.

Keeps Python imports and (optionally) browser sessions warm so repeated
queries against the same notebook skip Chromium cold-start.
Fresh Chromium per new notebook; LRU eviction; idle GC.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

LOG = logging.getLogger("notebooklm-daemon.pool")

Launcher = Callable[[str], Awaitable[tuple[Any, Any, Any]]]
Clock = Callable[[], float]


@dataclass
class PoolConfig:
    max_warm: int = 3
    idle_seconds: float = 90.0
    warm_enabled: bool = True


@dataclass
class AcquiredSession:
    notebook_url: str
    browser: Any
    context: Any
    page: Any
    hit: bool
    _pool: "SessionPool" = field(repr=False)


class _Entry:
    __slots__ = ("url", "browser", "context", "page", "last_used_at", "lock")

    def __init__(self, url: str, browser: Any, context: Any, page: Any, now: float) -> None:
        self.url = url
        self.browser = browser
        self.context = context
        self.page = page
        self.last_used_at = now
        self.lock = asyncio.Lock()


class SessionPool:
    def __init__(
        self,
        config: PoolConfig,
        launcher: Launcher,
        clock: Clock | None = None,
    ) -> None:
        self._config = config
        self._launcher = launcher
        self._clock: Clock = clock if clock is not None else time.monotonic
        self._entries: "OrderedDict[str, _Entry]" = OrderedDict()
        self._table_lock = asyncio.Lock()
        self._gc_task: asyncio.Task | None = None

    async def acquire(self, notebook_url: str) -> AcquiredSession:
        if not self._config.warm_enabled:
            browser, context, page = await self._launcher(notebook_url)
            return AcquiredSession(notebook_url, browser, context, page, hit=False, _pool=self)

        # Phase 1: locate-or-reserve under the table lock
        async with self._table_lock:
            entry = self._entries.get(notebook_url)
            if entry is not None:
                # Move to MRU position
                self._entries.move_to_end(notebook_url)

        if entry is not None:
            # Serialize on the per-entry lock so concurrent acquires of the same URL queue
            await entry.lock.acquire()
            # Re-validate after lock: entry may have been evicted between waits
            async with self._table_lock:
                still_there = self._entries.get(notebook_url) is entry
            if still_there:
                entry.last_used_at = self._clock()
                return AcquiredSession(
                    notebook_url, entry.browser, entry.context, entry.page, hit=True, _pool=self
                )
            # Evicted while we waited — release and fall through to launch
            entry.lock.release()

        # Phase 2: launch + insert
        browser, context, page = await self._launcher(notebook_url)
        new_entry = _Entry(notebook_url, browser, context, page, self._clock())
        await new_entry.lock.acquire()

        to_close: list[_Entry] = []
        async with self._table_lock:
            self._entries[notebook_url] = new_entry
            self._entries.move_to_end(notebook_url)
            while len(self._entries) > self._config.max_warm:
                _, evicted = self._entries.popitem(last=False)
                to_close.append(evicted)

        for ev in to_close:
            await self._close_entry(ev)

        return AcquiredSession(notebook_url, browser, context, page, hit=False, _pool=self)

    async def release(self, session: AcquiredSession) -> None:
        if not self._config.warm_enabled:
            # One-shot mode — close immediately, no caching
            await self._close_session(session)
            return
        async with self._table_lock:
            entry = self._entries.get(session.notebook_url)
        if entry is not None and entry.browser is session.browser:
            entry.last_used_at = self._clock()
            if entry.lock.locked():
                entry.lock.release()
        else:
            # Was evicted before release — just close the browser we had
            await self._close_session(session)

    async def evict(self, notebook_url: str) -> bool:
        async with self._table_lock:
            entry = self._entries.pop(notebook_url, None)
        if entry is None:
            return False
        await self._close_entry(entry)
        return True

    async def run_gc_once(self) -> int:
        cutoff = self._clock() - self._config.idle_seconds
        to_close: list[_Entry] = []
        async with self._table_lock:
            stale = [url for url, e in self._entries.items() if e.last_used_at < cutoff]
            for url in stale:
                to_close.append(self._entries.pop(url))
        for e in to_close:
            await self._close_entry(e)
        return len(to_close)

    def start_background_gc(self, interval_s: float = 15.0) -> None:
        if self._gc_task is not None:
            return

        async def _loop() -> None:
            while True:
                try:
                    await asyncio.sleep(interval_s)
                    await self.run_gc_once()
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    LOG.exception("GC loop error: %s", exc)

        self._gc_task = asyncio.create_task(_loop())

    async def shutdown(self) -> None:
        if self._gc_task is not None:
            self._gc_task.cancel()
            try:
                await self._gc_task
            except asyncio.CancelledError:
                pass
            self._gc_task = None
        async with self._table_lock:
            entries = list(self._entries.values())
            self._entries.clear()
        for e in entries:
            await self._close_entry(e)

    def snapshot(self) -> list[dict[str, Any]]:
        return [
            {"notebook_url": e.url, "last_used_at": e.last_used_at}
            for e in self._entries.values()
        ]

    async def _close_entry(self, entry: _Entry) -> None:
        try:
            await entry.browser.close()
        except Exception:  # noqa: BLE001
            LOG.exception("Error closing browser for %s", entry.url)

    async def _close_session(self, session: AcquiredSession) -> None:
        try:
            await session.browser.close()
        except Exception:  # noqa: BLE001
            LOG.exception("Error closing browser for %s", session.notebook_url)
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_session_pool.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/notebooklm_session_pool.py scripts/tests/test_session_pool.py
git commit -m "feat(notebooklm): warm-session pool with LRU + idle GC + feature flag"
```

---

## Task 3: Ask adapter — split upstream's ask_question flow (TDD)

**Goal:** decouple "launch browser + navigate to notebook" from "ask question on existing page". Wrap upstream modules without forking them.

**Files:**
- Create: `scripts/notebooklm_ask_adapter.py`
- Create: `scripts/tests/test_ask_adapter.py`

**Why this task is delicate:** we're reading upstream's `ask_question.py` to extract two reusable functions. Upstream may lay out its internals differently from what this plan assumes. **Before writing `notebooklm_ask_adapter.py`, read `~/.claude/skills/notebooklm/scripts/ask_question.py` end-to-end** and identify:

1. The function(s) that launch patchright + navigate to the notebook URL (captures the ~3–5s Chromium spawn we're trying to amortize).
2. The function(s) that fill the input box, submit, wait for a DOM marker that signals answer-complete, and extract answer text + citations.

If upstream's code is tightly coupled (one big function), this adapter wraps those specific parts via monkey-patched Playwright calls or by calling sub-functions directly if they exist. **Do not fork upstream.** If upstream only exposes a monolithic function, the adapter may need to re-implement the thin orchestration in 30–50 lines while calling upstream's lower-level helpers.

- [ ] **Step 3.1: Read upstream and document what you find**

```bash
cat ~/.claude/skills/notebooklm/scripts/ask_question.py
cat ~/.claude/skills/notebooklm/scripts/browser_session.py
cat ~/.claude/skills/notebooklm/scripts/browser_utils.py
```

Note in a scratch comment which upstream functions will back `ensure_session` and `ask_on_page`. If upstream is already split cleanly, great — just import and re-expose. If not, record the selector strings / DOM markers upstream uses so our wrapper can reuse them exactly.

- [ ] **Step 3.2: Write failing tests for the adapter**

Create `scripts/tests/test_ask_adapter.py`:

```python
"""Tests for the ensure_session / ask_on_page adapter over upstream's flow."""
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from notebooklm_ask_adapter import ask_on_page, ensure_session, AskResult


@pytest.fixture
def fake_patchright(monkeypatch):
    """Replace patchright primitives the adapter uses with mocks."""
    fake_browser = MagicMock(name="browser")
    fake_browser.close = AsyncMock()
    fake_context = MagicMock(name="context")
    fake_context.close = AsyncMock()
    fake_page = MagicMock(name="page")
    fake_page.goto = AsyncMock()
    fake_page.wait_for_selector = AsyncMock()

    launch = AsyncMock(return_value=(fake_browser, fake_context, fake_page))
    monkeypatch.setattr("notebooklm_ask_adapter._launch_browser_on_notebook", launch)
    return {"browser": fake_browser, "context": fake_context, "page": fake_page, "launch": launch}


async def test_ensure_session_launches_and_navigates(fake_patchright):
    browser, context, page = await ensure_session("https://notebooklm.google.com/notebook/abc")
    assert browser is fake_patchright["browser"]
    assert context is fake_patchright["context"]
    assert page is fake_patchright["page"]
    fake_patchright["launch"].assert_awaited_once_with("https://notebooklm.google.com/notebook/abc")


async def test_ask_on_page_returns_structured_answer(monkeypatch):
    page = MagicMock()
    page.fill = AsyncMock()
    page.click = AsyncMock()
    page.wait_for_selector = AsyncMock()

    async def fake_extract(page_, question_):
        assert question_ == "What is NotebookLM?"
        return AskResult(answer="Answer text", citations=[{"source": "doc1", "snippet": "..."}])

    monkeypatch.setattr("notebooklm_ask_adapter._submit_question_and_extract", fake_extract)

    result = await ask_on_page(page, "What is NotebookLM?")
    assert result.answer == "Answer text"
    assert result.citations == [{"source": "doc1", "snippet": "..."}]


async def test_ask_on_page_raises_on_extract_failure(monkeypatch):
    page = MagicMock()
    async def fake_extract(page_, question_):
        raise RuntimeError("selector not found")
    monkeypatch.setattr("notebooklm_ask_adapter._submit_question_and_extract", fake_extract)

    with pytest.raises(RuntimeError, match="selector not found"):
        await ask_on_page(page, "x")
```

- [ ] **Step 3.3: Run tests, verify they fail**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_ask_adapter.py -v
```

Expected: `ModuleNotFoundError: No module named 'notebooklm_ask_adapter'`.

- [ ] **Step 3.4: Implement the adapter**

Create `scripts/notebooklm_ask_adapter.py`. Use upstream's helpers where they exist; the private functions (`_launch_browser_on_notebook`, `_submit_question_and_extract`) exist as the adapter's own seam so tests can patch them regardless of upstream layout.

```python
"""
Adapter that splits upstream's ask_question flow into two reusable phases:

  ensure_session(notebook_url)  -> (browser, context, page) ready to ask on
  ask_on_page(page, question)   -> AskResult(answer, citations)

This lets the daemon reuse a page across same-notebook queries while keeping
the upstream code untouched.  Upstream internals are accessed by adding its
scripts/ dir to sys.path and importing by name — no fork.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

UPSTREAM_SKILL_DIR = Path(os.path.expanduser("~/.claude/skills/notebooklm"))
UPSTREAM_SCRIPTS = UPSTREAM_SKILL_DIR / "scripts"

if str(UPSTREAM_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(UPSTREAM_SCRIPTS))


@dataclass
class AskResult:
    answer: str
    citations: list[dict[str, Any]]


async def ensure_session(notebook_url: str) -> tuple[Any, Any, Any]:
    """Launch patchright, navigate to notebook, return (browser, context, page)."""
    return await _launch_browser_on_notebook(notebook_url)


async def ask_on_page(page: Any, question: str) -> AskResult:
    """Fill the input on an already-loaded notebook page, submit, extract the answer."""
    return await _submit_question_and_extract(page, question)


# ----- seam functions (patched by tests, backed by upstream in prod) --------

async def _launch_browser_on_notebook(notebook_url: str) -> tuple[Any, Any, Any]:
    """
    Thin wrapper over upstream's browser-startup path.

    IMPLEMENTATION NOTE: the exact upstream call depends on what Step 3.1
    revealed. Typical path:

        from browser_session import launch_authenticated_browser

        browser, context = await launch_authenticated_browser()
        page = await context.new_page()
        await page.goto(notebook_url, wait_until="domcontentloaded")
        await page.wait_for_selector(NOTEBOOK_READY_SELECTOR, timeout=30_000)

    Reuse upstream's constants for `NOTEBOOK_READY_SELECTOR` and auth-state
    directory; do not redefine. If upstream only exposes a monolithic
    ask_question() function, either (a) refactor upstream via a small PR
    or (b) inline the equivalent logic here (≤30 lines) using upstream's
    selectors/helpers.
    """
    from browser_session import launch_authenticated_browser  # upstream
    browser, context = await launch_authenticated_browser()
    page = await context.new_page()
    # Upstream likely exposes NOTEBOOK_READY_SELECTOR; import it. If not,
    # document the selector inline as a local constant with a citation
    # (file:line in upstream).
    try:
        from browser_session import NOTEBOOK_READY_SELECTOR  # upstream
    except ImportError:
        NOTEBOOK_READY_SELECTOR = '[data-testid="notebook-ready"]'  # upstream: ask_question.py:L?
    await page.goto(notebook_url, wait_until="domcontentloaded")
    await page.wait_for_selector(NOTEBOOK_READY_SELECTOR, timeout=30_000)
    return browser, context, page


async def _submit_question_and_extract(page: Any, question: str) -> AskResult:
    """
    Fill input, submit, wait for answer-complete DOM marker, extract text.

    Reuse upstream's selector constants and extraction helpers. Example:

        from ask_question import (
            INPUT_SELECTOR, SUBMIT_SELECTOR,
            ANSWER_COMPLETE_SELECTOR, extract_answer_and_citations,
        )
    """
    from ask_question import (  # upstream
        INPUT_SELECTOR, SUBMIT_SELECTOR, ANSWER_COMPLETE_SELECTOR,
        extract_answer_and_citations,
    )
    await page.fill(INPUT_SELECTOR, question)
    await page.click(SUBMIT_SELECTOR)
    await page.wait_for_selector(ANSWER_COMPLETE_SELECTOR, timeout=90_000)
    payload = await extract_answer_and_citations(page)
    return AskResult(answer=payload["answer"], citations=payload.get("citations", []))
```

**Important:** the import names (`launch_authenticated_browser`, `INPUT_SELECTOR`, etc.) are placeholders based on a plausible upstream layout. After Step 3.1 you may need to adjust them to the real names. The tests patch the `_launch_browser_on_notebook` / `_submit_question_and_extract` seam functions directly, so unit tests don't require upstream.

- [ ] **Step 3.5: Run unit tests to verify they pass**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_ask_adapter.py -v
```

Expected: all 3 tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add scripts/notebooklm_ask_adapter.py scripts/tests/test_ask_adapter.py
git commit -m "feat(notebooklm): adapter splits upstream ask flow into ensure_session + ask_on_page"
```

---

## Task 4: Wire /ask endpoint — pool + adapter + retry-with-fresh

**Goal:** daemon's `POST /ask` acquires a session, asks, releases. On `ask_on_page` failure, evict + retry once with fresh Chromium. On launch-failure, surface error immediately (no retry).

**Files:**
- Modify: `scripts/notebooklm_daemon.py`
- Modify: `scripts/tests/test_daemon_endpoints.py`

- [ ] **Step 4.1: Write failing tests for /ask**

Append to `scripts/tests/test_daemon_endpoints.py`:

```python
from unittest.mock import AsyncMock, MagicMock

import pytest

from notebooklm_ask_adapter import AskResult


@pytest.fixture
async def wired_client(monkeypatch):
    """Client with a mocked launcher + ask_on_page so no real browser is spawned."""
    from notebooklm_daemon import build_app
    from notebooklm_session_pool import SessionPool, PoolConfig

    launch_calls = {"n": 0}

    async def fake_launcher(url):
        launch_calls["n"] += 1
        browser = MagicMock(name=f"b{launch_calls['n']}")
        browser.close = AsyncMock()
        context = MagicMock(name=f"c{launch_calls['n']}")
        page = MagicMock(name=f"p{launch_calls['n']}")
        return browser, context, page

    ask_calls = {"n": 0, "raise_on": None}

    async def fake_ask_on_page(page, question):
        ask_calls["n"] += 1
        if ask_calls["raise_on"] == ask_calls["n"]:
            raise RuntimeError("stale page")
        return AskResult(answer=f"answer-{ask_calls['n']}", citations=[])

    app = build_app(
        pool=SessionPool(PoolConfig(), launcher=fake_launcher),
        ask_on_page=fake_ask_on_page,
        resolve_notebook=lambda nid, url: {"id": nid or "nb1", "url": url or "https://x/a", "name": "A"},
    )
    from aiohttp.test_utils import TestClient, TestServer
    async with TestClient(TestServer(app)) as c:
        c.app_stats = {"launches": launch_calls, "asks": ask_calls}
        yield c


async def test_ask_happy_path_miss_then_hit(wired_client):
    r1 = await wired_client.post("/ask", json={"question": "q1", "notebook_url": "https://x/a"})
    body1 = await r1.json()
    assert r1.status == 200
    assert body1["answer"] == "answer-1"
    assert body1["warm_hit"] is False

    r2 = await wired_client.post("/ask", json={"question": "q2", "notebook_url": "https://x/a"})
    body2 = await r2.json()
    assert body2["warm_hit"] is True
    assert body2["answer"] == "answer-2"
    assert wired_client.app_stats["launches"]["n"] == 1


async def test_ask_retry_with_fresh_on_reuse_failure(wired_client):
    # First call succeeds (cache miss, launch #1)
    await wired_client.post("/ask", json={"question": "q1", "notebook_url": "https://x/a"})
    # Second call: reuses session, we force ask_on_page to raise on the 2nd call;
    # daemon should evict + relaunch + succeed on the 3rd call.
    wired_client.app_stats["asks"]["raise_on"] = 2
    r = await wired_client.post("/ask", json={"question": "q2", "notebook_url": "https://x/a"})
    body = await r.json()
    assert r.status == 200
    assert body["answer"] == "answer-3"
    # Launches: 1 (miss) + 1 (retry) = 2
    assert wired_client.app_stats["launches"]["n"] == 2


async def test_ask_400_when_no_notebook_given():
    from notebooklm_daemon import build_app
    from notebooklm_session_pool import SessionPool, PoolConfig

    async def fake_launcher(url):
        raise AssertionError("should not launch")

    async def fake_ask_on_page(page, question):
        raise AssertionError("should not ask")

    def resolver(nid, url):
        return None  # neither id nor url provided nor active notebook

    app = build_app(
        pool=SessionPool(PoolConfig(), launcher=fake_launcher),
        ask_on_page=fake_ask_on_page,
        resolve_notebook=resolver,
    )
    from aiohttp.test_utils import TestClient, TestServer
    async with TestClient(TestServer(app)) as c:
        r = await c.post("/ask", json={"question": "q"})
        assert r.status == 400
        body = await r.json()
        assert "notebook" in body["error"].lower()
```

- [ ] **Step 4.2: Run to confirm they fail**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_daemon_endpoints.py -v
```

Expected: new tests fail; `test_health_returns_ok` still passes.

- [ ] **Step 4.3: Implement /ask in the daemon**

Overwrite `scripts/notebooklm_daemon.py` (keeping the existing `/health` shape):

```python
"""
NotebookLM daemon — aiohttp server on 127.0.0.1:$NOTEBOOKLM_PORT.

Routes:
  POST /ask     — run a NotebookLM query, optionally reusing a warm session
  GET  /list    — list notebooks in the upstream library
  GET  /search  — search library by query
  GET  /health  — readiness + stats
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import asdict
from typing import Any, Awaitable, Callable, Optional

from aiohttp import web

from notebooklm_ask_adapter import AskResult, ask_on_page as default_ask_on_page, ensure_session
from notebooklm_session_pool import PoolConfig, SessionPool

LOG = logging.getLogger("notebooklm-daemon")

STARTED_AT_MONOTONIC = time.monotonic()

ResolveNotebook = Callable[[Optional[str], Optional[str]], Optional[dict[str, Any]]]
AskOnPage = Callable[[Any, str], Awaitable[AskResult]]


def _default_resolve_notebook(nid: Optional[str], url: Optional[str]) -> Optional[dict[str, Any]]:
    """Resolve (id, url) to {id, name, url} using upstream's notebook_manager.

    Precedence: id wins if both provided. Falls back to active notebook.
    """
    from notebook_manager import load_library, get_active_notebook  # upstream
    lib = load_library()
    if nid:
        for nb in lib:
            if nb["id"] == nid:
                return {"id": nb["id"], "name": nb.get("name"), "url": nb["url"]}
        return None
    if url:
        return {"id": None, "name": None, "url": url}
    active = get_active_notebook()
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
    authenticated = _check_auth()
    return web.json_response(
        {
            "ok": True,
            "authenticated": authenticated,
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

    # Acquire + ask, with at most one retry-with-fresh on reuse failure.
    session = await pool.acquire(notebook["url"])
    try:
        result = await ask(session.page, question)
        if session.hit:
            stats["warm_hits"] += 1
        else:
            stats["warm_misses"] += 1
        return web.json_response(
            {
                "answer": result.answer,
                "citations": result.citations,
                "notebook": notebook,
                "warm_hit": session.hit,
            }
        )
    except Exception as exc:  # noqa: BLE001
        if session.hit:
            # Reuse failed — evict and retry once with a fresh session.
            LOG.warning("Reuse failure on %s: %s — retrying fresh", notebook["url"], exc)
            await pool.release(session)
            await pool.evict(notebook["url"])
            session = await pool.acquire(notebook["url"])
            try:
                result = await ask(session.page, question)
                stats["warm_misses"] += 1
                return web.json_response(
                    {
                        "answer": result.answer,
                        "citations": result.citations,
                        "notebook": notebook,
                        "warm_hit": False,
                    }
                )
            except Exception as exc2:  # noqa: BLE001
                return web.json_response(
                    {"error": f"ask failed after retry: {exc2}", "hint": "check daemon logs"},
                    status=500,
                )
        # Initial launch path — surface immediately
        return web.json_response(
            {"error": f"ask failed: {exc}", "hint": "check daemon logs"},
            status=500,
        )
    finally:
        # If the final session is still valid, release it; otherwise already released above.
        try:
            await pool.release(session)
        except Exception:  # noqa: BLE001
            pass


def _check_auth() -> bool:
    try:
        from auth_manager import is_authenticated  # upstream
        return bool(is_authenticated())
    except Exception:  # noqa: BLE001
        return False


def _active_notebook_summary() -> Optional[dict[str, Any]]:
    try:
        from notebook_manager import get_active_notebook  # upstream
        nb = get_active_notebook()
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
```

Note: the retry path releases-then-evicts-then-reacquires; the per-URL lock logic in the pool ensures these calls serialize against concurrent same-URL asks.

- [ ] **Step 4.4: Run full Python test suite**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/ -v
```

Expected: all tests pass (including previously passing ones).

- [ ] **Step 4.5: Commit**

```bash
git add scripts/notebooklm_daemon.py scripts/tests/test_daemon_endpoints.py
git commit -m "feat(notebooklm): /ask endpoint with session reuse + retry-with-fresh"
```

---

## Task 5: Add /list and /search endpoints (TDD)

**Goal:** expose upstream's `notebook_manager.py` read operations so the agent can discover notebooks.

**Files:**
- Modify: `scripts/notebooklm_daemon.py`
- Modify: `scripts/tests/test_daemon_endpoints.py`

- [ ] **Step 5.1: Write failing tests**

Append to `scripts/tests/test_daemon_endpoints.py`:

```python
async def test_list_returns_library(monkeypatch):
    from notebooklm_daemon import build_app
    from notebooklm_session_pool import SessionPool, PoolConfig

    monkeypatch.setattr(
        "notebooklm_daemon._load_library",
        lambda: [
            {"id": "nb1", "name": "Project A", "description": "d", "topics": ["x"], "url": "https://x/a"},
            {"id": "nb2", "name": "Project B", "description": "d", "topics": ["y"], "url": "https://x/b"},
        ],
    )

    async def fake_launcher(url):
        raise AssertionError

    app = build_app(pool=SessionPool(PoolConfig(), launcher=fake_launcher))
    from aiohttp.test_utils import TestClient, TestServer
    async with TestClient(TestServer(app)) as c:
        r = await c.get("/list")
        assert r.status == 200
        body = await r.json()
        assert len(body["notebooks"]) == 2
        assert {n["id"] for n in body["notebooks"]} == {"nb1", "nb2"}


async def test_search_filters_library(monkeypatch):
    from notebooklm_daemon import build_app
    from notebooklm_session_pool import SessionPool, PoolConfig

    monkeypatch.setattr(
        "notebooklm_daemon._search_library",
        lambda q: [{"id": "nb1", "name": "Project A", "description": "about quantum", "topics": ["physics"], "url": "https://x/a"}],
    )

    async def fake_launcher(url):
        raise AssertionError

    app = build_app(pool=SessionPool(PoolConfig(), launcher=fake_launcher))
    from aiohttp.test_utils import TestClient, TestServer
    async with TestClient(TestServer(app)) as c:
        r = await c.get("/search", params={"q": "quantum"})
        assert r.status == 200
        body = await r.json()
        assert body["notebooks"][0]["id"] == "nb1"
```

- [ ] **Step 5.2: Confirm failure**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/test_daemon_endpoints.py -v
```

Expected: two new tests fail.

- [ ] **Step 5.3: Implement /list and /search**

In `scripts/notebooklm_daemon.py` add:

```python
def _load_library() -> list[dict[str, Any]]:
    from notebook_manager import load_library  # upstream
    return list(load_library())


def _search_library(query: str) -> list[dict[str, Any]]:
    from notebook_manager import search_library  # upstream
    return list(search_library(query))


async def handle_list(request: web.Request) -> web.Response:
    try:
        notebooks = _load_library()
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"failed to load library: {exc}"}, status=500)
    return web.json_response({"notebooks": notebooks})


async def handle_search(request: web.Request) -> web.Response:
    q = request.query.get("q", "").strip()
    if not q:
        return web.json_response({"error": "`q` query parameter is required"}, status=400)
    try:
        results = _search_library(q)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"search failed: {exc}"}, status=500)
    return web.json_response({"notebooks": results})
```

And register them in `build_app` after the existing `/ask` route:

```python
app.router.add_get("/list", handle_list)
app.router.add_get("/search", handle_search)
```

- [ ] **Step 5.4: Run tests**

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/ -v
```

Expected: all pass.

- [ ] **Step 5.5: Commit**

```bash
git add scripts/notebooklm_daemon.py scripts/tests/test_daemon_endpoints.py
git commit -m "feat(notebooklm): /list and /search endpoints over upstream library"
```

---

## Task 6: Container-side MCP stdio bridge (TDD)

**Goal:** TypeScript MCP server inside the container that exposes `notebooklm_ask`, `notebooklm_list`, `notebooklm_search` to the agent. Each tool HTTP-calls the host daemon via `host.docker.internal:$NOTEBOOKLM_PORT`.

**Files:**
- Create: `container/agent-runner/src/notebooklm-mcp-stdio.ts`
- Create: `container/agent-runner/src/notebooklm-mcp-stdio.test.ts`

**Caveats:**
- `vitest.config.ts` includes `src/**/*.test.ts` — **not** `container/agent-runner/src/**`. That's fine: container-side agent-runner tests traditionally sit under the repo's top-level test config via its own path, or are run from `container/agent-runner/` if a second vitest config exists. For this plan, we add tests under `container/agent-runner/src/` and update vitest config to include them so `npm test` picks them up.

- [ ] **Step 6.1: Update vitest config to include container agent-runner tests**

Modify `vitest.config.ts`:

```diff
 import { defineConfig } from 'vitest/config';

 export default defineConfig({
   test: {
-    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
+    include: [
+      'src/**/*.test.ts',
+      'setup/**/*.test.ts',
+      'container/agent-runner/src/**/*.test.ts',
+    ],
   },
 });
```

- [ ] **Step 6.2: Write the failing test**

Create `container/agent-runner/src/notebooklm-mcp-stdio.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callAsk, callList, callSearch } from './notebooklm-mcp-stdio';

describe('notebooklm MCP → daemon HTTP calls', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { process.env.NOTEBOOKLM_PORT = '11999'; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('callAsk POSTs to /ask on host.docker.internal', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://host.docker.internal:11999/ask');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.question).toBe('what is X?');
      expect(body.notebook_id).toBe('nb1');
      return new Response(
        JSON.stringify({ answer: 'A', citations: [], notebook: { id: 'nb1' }, warm_hit: true }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const out = await callAsk({ question: 'what is X?', notebook_id: 'nb1' });
    expect(out.answer).toBe('A');
    expect(out.warm_hit).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('callAsk surfaces daemon HTTP errors with hint', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ error: 'notebook not found', hint: 'use notebooklm_list' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    await expect(callAsk({ question: 'q' })).rejects.toMatchObject({
      message: expect.stringContaining('notebook not found'),
    });
  });

  it('callList GETs /list', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('http://host.docker.internal:11999/list');
      return new Response(JSON.stringify({ notebooks: [{ id: 'nb1' }] }), { status: 200 });
    }) as typeof fetch;
    const res = await callList();
    expect(res.notebooks).toHaveLength(1);
  });

  it('callSearch GETs /search with query', async () => {
    globalThis.fetch = (async (url: string) => {
      expect(url).toBe('http://host.docker.internal:11999/search?q=quantum');
      return new Response(JSON.stringify({ notebooks: [] }), { status: 200 });
    }) as typeof fetch;
    await callSearch({ query: 'quantum' });
  });
});
```

- [ ] **Step 6.3: Run test, confirm failure**

```bash
cd /home/chassidusaicon/code/nanoclaw/.claude/worktrees/unified-cooking-brook
npm test -- container/agent-runner/src/notebooklm-mcp-stdio.test.ts
```

Expected: import error (module does not exist).

- [ ] **Step 6.4: Implement the MCP stdio server**

Create `container/agent-runner/src/notebooklm-mcp-stdio.ts`:

```typescript
/**
 * NotebookLM MCP stdio bridge.
 * Runs inside the main-group agent container. Agents get tools:
 *   notebooklm_ask, notebooklm_list, notebooklm_search
 * Each tool POSTs/GETs against the host daemon on
 *   http://host.docker.internal:${NOTEBOOKLM_PORT}
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HOST = process.env.NOTEBOOKLM_HOST || 'host.docker.internal';
const PORT = process.env.NOTEBOOKLM_PORT || '11435';
const BASE = `http://${HOST}:${PORT}`;

class DaemonError extends Error {
  constructor(message: string, public hint?: string) {
    super(hint ? `${message} (hint: ${hint})` : message);
  }
}

async function daemonJson(resp: Response): Promise<unknown> {
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* keep empty */ }
  if (!resp.ok) {
    const err = typeof body.error === 'string' ? body.error : `HTTP ${resp.status}`;
    const hint = typeof body.hint === 'string' ? body.hint : undefined;
    throw new DaemonError(err, hint);
  }
  return body;
}

export interface AskArgs { question: string; notebook_id?: string; notebook_url?: string; }
export interface AskResponse {
  answer: string;
  citations: unknown[];
  notebook: { id?: string; name?: string; url?: string };
  warm_hit: boolean;
}

export async function callAsk(args: AskArgs): Promise<AskResponse> {
  const resp = await fetch(`${BASE}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return (await daemonJson(resp)) as AskResponse;
}

export async function callList(): Promise<{ notebooks: unknown[] }> {
  const resp = await fetch(`${BASE}/list`);
  return (await daemonJson(resp)) as { notebooks: unknown[] };
}

export async function callSearch(args: { query: string }): Promise<{ notebooks: unknown[] }> {
  const url = `${BASE}/search?q=${encodeURIComponent(args.query)}`;
  const resp = await fetch(url);
  return (await daemonJson(resp)) as { notebooks: unknown[] };
}

// --- MCP wiring (only executed when run as the server entrypoint) ---

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = new McpServer({ name: 'notebooklm', version: '1.0.0' });

  server.tool(
    'notebooklm_ask',
    'Ask a question of a private Google NotebookLM notebook. Returns a source-grounded answer with citations. Prefer passing notebook_id over notebook_url when both are known — id wins if both are provided.',
    {
      question: z.string().describe('The question to ask the notebook.'),
      notebook_id: z.string().optional().describe('Notebook id from notebooklm_list.'),
      notebook_url: z.string().optional().describe('Direct NotebookLM URL; used when id is unknown.'),
    },
    async (args) => {
      const out = await callAsk(args);
      const text = [
        out.answer,
        out.citations.length ? `\n\nCitations:\n${JSON.stringify(out.citations, null, 2)}` : '',
        `\n\n(notebook=${out.notebook.name || out.notebook.id || out.notebook.url}, warm_hit=${out.warm_hit})`,
      ].join('');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'notebooklm_list',
    'List notebooks in the local NotebookLM library with their ids, names, descriptions, and topics.',
    {},
    async () => {
      const out = await callList();
      return { content: [{ type: 'text' as const, text: JSON.stringify(out.notebooks, null, 2) }] };
    },
  );

  server.tool(
    'notebooklm_search',
    'Search the local NotebookLM library by topic/keyword. Returns matching notebooks with their metadata.',
    { query: z.string().describe('Search term to match against topics, names, and descriptions.') },
    async (args) => {
      const out = await callSearch(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out.notebooks, null, 2) }] };
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

- [ ] **Step 6.5: Run tests**

```bash
npm test -- container/agent-runner/src/notebooklm-mcp-stdio.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add vitest.config.ts \
        container/agent-runner/src/notebooklm-mcp-stdio.ts \
        container/agent-runner/src/notebooklm-mcp-stdio.test.ts
git commit -m "feat(notebooklm): container-side MCP stdio bridge → host daemon"
```

---

## Task 7: Register MCP server in agent-runner/index.ts (main-group only)

**Goal:** wire the new MCP server so the SDK launches it alongside `nanoclaw` when the group is main. Non-main groups must not see these tools.

**Files:**
- Modify: `container/agent-runner/src/index.ts`

- [ ] **Step 7.1: Locate the `mcpServers` block**

Inside `runQuery` there is a `mcpServers: { nanoclaw: { ... } }` option (around line 416 of current file). We'll add a conditional second entry.

- [ ] **Step 7.2: Extend `allowedTools` conditionally and add the MCP server**

Replace the `allowedTools:` array and `mcpServers:` object inside `runQuery`'s `query({ options: { ... } })` call:

```typescript
      const isMainGroup = containerInput.isMain;
      const notebooklmAllowed = isMainGroup ? ['mcp__notebooklm__*'] : [];
      const notebooklmMcpPath = path.join(__dirname, 'notebooklm-mcp-stdio.js');

      // ...within query() options:
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        ...notebooklmAllowed,
      ],
      // ...
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...(isMainGroup
          ? {
              notebooklm: {
                command: 'node',
                args: [notebooklmMcpPath],
                env: {
                  NOTEBOOKLM_PORT: process.env.NOTEBOOKLM_PORT || '11435',
                  NOTEBOOKLM_HOST: process.env.NOTEBOOKLM_HOST || 'host.docker.internal',
                },
              },
            }
          : {}),
      },
```

The key detail: both `allowedTools` and `mcpServers` are gated on `containerInput.isMain`. Non-main groups get neither the tool pattern nor the MCP server launch.

The `notebooklmMcpPath` variable must be declared once before `runQuery` is called, alongside the existing `mcpServerPath`. Find (around line 489):

```typescript
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
```

Leave that — inside `runQuery` we can compute `notebooklmMcpPath` using the same `__dirname` that's already in lexical scope (it's declared in `main` but we recompute via `fileURLToPath(import.meta.url)` if needed). Simpler: add the second line right after `mcpServerPath` and pass both into `runQuery` as a third parameter, OR recompute inside `runQuery`. Prefer recomputing (keeps `runQuery`'s signature small):

```typescript
async function runQuery(...) {
  // ...existing code...
  const notebooklmMcpPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'notebooklm-mcp-stdio.js',
  );
  // use it inside the mcpServers object
}
```

- [ ] **Step 7.3: Build and typecheck**

```bash
npm run build
npm run typecheck
```

Expected: clean.

- [ ] **Step 7.4: Spot-check by grep**

```bash
grep -n 'notebooklm' container/agent-runner/src/index.ts
```

Expected: 3–5 hits (path computation, allowedTools, mcpServers entry).

- [ ] **Step 7.5: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(notebooklm): register MCP server in agent-runner (main-group only)"
```

---

## Task 8: Host container-runner — log surfacing + env propagation (TDD)

**Goal:** surface `[NOTEBOOKLM]` log lines from the daemon (and the MCP bridge) into `nanoclaw.log`, and pass `NOTEBOOKLM_PORT`/`NOTEBOOKLM_HOST` into the container environment.

**Context:** The existing ollama pattern surfaces `[OLLAMA]`-prefixed log lines. Mirror that. Env propagation is done by container-runner when it builds the `docker run` / `apple-container` command.

**Files:**
- Modify: `src/container-runner.ts`
- Create: `src/container-runner.notebooklm.test.ts`

- [ ] **Step 8.1: Write failing tests**

Create `src/container-runner.notebooklm.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { buildContainerEnvArgs, isNotebooklmLogLine, surfaceNotebooklmLog } from './container-runner';

describe('container-runner NotebookLM integration', () => {
  describe('buildContainerEnvArgs', () => {
    it('propagates NOTEBOOKLM_PORT and NOTEBOOKLM_HOST when set', () => {
      const args = buildContainerEnvArgs({
        NOTEBOOKLM_PORT: '12345',
        NOTEBOOKLM_HOST: 'host.docker.internal',
      });
      expect(args).toContain('NOTEBOOKLM_PORT=12345');
      expect(args).toContain('NOTEBOOKLM_HOST=host.docker.internal');
    });

    it('omits NOTEBOOKLM vars when not set', () => {
      const args = buildContainerEnvArgs({});
      expect(args.some((a) => a.startsWith('NOTEBOOKLM_'))).toBe(false);
    });
  });

  describe('isNotebooklmLogLine', () => {
    it('detects [NOTEBOOKLM] prefix', () => {
      expect(isNotebooklmLogLine('[NOTEBOOKLM] 2026-04-22 INFO ASK start')).toBe(true);
      expect(isNotebooklmLogLine('[OLLAMA] other')).toBe(false);
      expect(isNotebooklmLogLine('normal log')).toBe(false);
    });
  });

  describe('surfaceNotebooklmLog', () => {
    it('writes to the host logger when line is tagged', () => {
      const written: string[] = [];
      surfaceNotebooklmLog('[NOTEBOOKLM] ASK warm=true duration_ms=150', (msg) => written.push(msg));
      expect(written).toEqual(['[NOTEBOOKLM] ASK warm=true duration_ms=150']);
    });

    it('ignores untagged lines', () => {
      const written: string[] = [];
      surfaceNotebooklmLog('plain agent output', (msg) => written.push(msg));
      expect(written).toEqual([]);
    });
  });
});
```

- [ ] **Step 8.2: Confirm failure**

```bash
npm test -- src/container-runner.notebooklm.test.ts
```

Expected: `buildContainerEnvArgs`, `isNotebooklmLogLine`, `surfaceNotebooklmLog` are not exported.

- [ ] **Step 8.3: Add the three helpers and wire them**

In `src/container-runner.ts`:

1. Add near the top, below imports:

```typescript
export function buildContainerEnvArgs(env: Partial<Record<'NOTEBOOKLM_PORT' | 'NOTEBOOKLM_HOST', string>>): string[] {
  const out: string[] = [];
  if (env.NOTEBOOKLM_PORT) out.push(`NOTEBOOKLM_PORT=${env.NOTEBOOKLM_PORT}`);
  if (env.NOTEBOOKLM_HOST) out.push(`NOTEBOOKLM_HOST=${env.NOTEBOOKLM_HOST}`);
  return out;
}

export function isNotebooklmLogLine(line: string): boolean {
  return line.startsWith('[NOTEBOOKLM]');
}

export function surfaceNotebooklmLog(line: string, write: (msg: string) => void): void {
  if (isNotebooklmLogLine(line)) write(line);
}
```

2. **Wire `buildContainerEnvArgs` into the container spawn.** Find where other `-e` (env) flags are passed to `docker run`/`apple-container run`. Add:

```typescript
const notebooklmEnvArgs = buildContainerEnvArgs({
  NOTEBOOKLM_PORT: process.env.NOTEBOOKLM_PORT,
  NOTEBOOKLM_HOST: process.env.NOTEBOOKLM_HOST,
});
// Each env var becomes "-e VAR=VAL" on the spawn argv:
for (const kv of notebooklmEnvArgs) {
  spawnArgs.push('-e', kv);
}
```

(Match the exact variable names used by the existing spawn; this snippet is the shape, not a copy-paste.)

3. **Wire `surfaceNotebooklmLog` into the container stdout/stderr pump.** Find the line-by-line handler that currently surfaces `[OLLAMA]` — if that integration has not landed yet (Ollama skill not merged), add the wiring here:

```typescript
rl.on('line', (line) => {
  // existing nanoclaw logging
  logger.info({ group: group.folder }, line);
  surfaceNotebooklmLog(line, (msg) => logger.info({ group: group.folder, tag: 'notebooklm' }, msg));
});
```

The intent is that the existing per-line handler also checks for `[NOTEBOOKLM]` and emits a tagged log entry; the exact call site mirrors whatever the repo uses for Ollama. If there's no such pattern yet (because Ollama isn't merged in this branch either), just add the `surfaceNotebooklmLog` call.

- [ ] **Step 8.4: Run tests + full suite**

```bash
npm test
```

Expected: new 4 tests pass; no regressions.

- [ ] **Step 8.5: Commit**

```bash
git add src/container-runner.ts src/container-runner.notebooklm.test.ts
git commit -m "feat(notebooklm): container env propagation + [NOTEBOOKLM] log surfacing"
```

---

## Task 9: Supervisor configs (macOS + Linux)

**Goal:** ship templates for launchd (macOS) and systemd user unit (Linux). Installer fills in paths and activates.

**Files:**
- Create: `launchd/com.nanoclaw.notebooklm.plist`
- Create: `setup/systemd/nanoclaw-notebooklm.service`

- [ ] **Step 9.1: Create the launchd plist template**

Create `launchd/com.nanoclaw.notebooklm.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.nanoclaw.notebooklm</string>

  <key>ProgramArguments</key>
  <array>
    <string>__PYTHON__</string>
    <string>__SCRIPT__</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NOTEBOOKLM_PORT</key>
    <string>__PORT__</string>
    <key>NOTEBOOKLM_WARM_SESSIONS</key>
    <string>1</string>
    <key>NOTEBOOKLM_IDLE_SECONDS</key>
    <string>90</string>
    <key>NOTEBOOKLM_MAX_WARM</key>
    <string>3</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>__LOG_DIR__/notebooklm-daemon.log</string>
  <key>StandardErrorPath</key>
  <string>__LOG_DIR__/notebooklm-daemon.log</string>

  <key>WorkingDirectory</key>
  <string>__WORKDIR__</string>
</dict>
</plist>
```

Placeholders (`__PYTHON__`, `__SCRIPT__`, `__PORT__`, `__LOG_DIR__`, `__WORKDIR__`) are substituted by the installer.

- [ ] **Step 9.2: Create the systemd user-unit template**

Create `setup/systemd/nanoclaw-notebooklm.service`:

```ini
[Unit]
Description=NanoClaw NotebookLM daemon
After=network.target

[Service]
Type=simple
Environment=NOTEBOOKLM_PORT=__PORT__
Environment=NOTEBOOKLM_WARM_SESSIONS=1
Environment=NOTEBOOKLM_IDLE_SECONDS=90
Environment=NOTEBOOKLM_MAX_WARM=3
WorkingDirectory=__WORKDIR__
ExecStart=__PYTHON__ __SCRIPT__
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

- [ ] **Step 9.3: Commit**

```bash
git add launchd/com.nanoclaw.notebooklm.plist setup/systemd/nanoclaw-notebooklm.service
git commit -m "feat(notebooklm): launchd + systemd supervisor templates"
```

---

## Task 10: Installer skill (`/add-notebooklm`)

**Goal:** the user-facing skill that ties everything together. Preflight, auth, code-changes, supervisor install, verify.

**Files:**
- Create: `.claude/skills/add-notebooklm/SKILL.md`

- [ ] **Step 10.1: Write the skill file**

Create `.claude/skills/add-notebooklm/SKILL.md`:

```markdown
---
name: add-notebooklm
description: Add NotebookLM (Google) query support to NanoClaw. Exposes private-notebook, citation-backed Q&A to the main-group agent via a warm Python daemon on the host. Includes same-notebook session reuse with fallback.
---

# Add NotebookLM Integration

Adds three MCP tools to the main-group agent — `notebooklm_ask`, `notebooklm_list`, `notebooklm_search` — backed by a host-side aiohttp daemon wrapping the upstream skill at https://github.com/PleasePrompto/notebooklm-skill.

## Phase 1: Preflight

### Check if already applied

If `~/Library/LaunchAgents/com.nanoclaw.notebooklm.plist` (macOS) or
`~/.config/systemd/user/nanoclaw-notebooklm.service` (Linux) already exists, skip to Phase 3.

### Check upstream skill

```bash
ls ~/.claude/skills/notebooklm/scripts/run.py
```

If missing, clone it:

```bash
git clone https://github.com/PleasePrompto/notebooklm-skill ~/.claude/skills/notebooklm
```

### Check Python

```bash
python3 --version
```

Require 3.10 or newer. Direct the user to install Python 3.10+ if not.

### Pick a port

Default `11435`. If in use (`lsof -i :11435`), auto-pick the next free port and record in `.env`:

```bash
echo "NOTEBOOKLM_PORT=<picked>" >> .env
```

## Phase 2: Google auth setup (visible browser)

Tell the user:

> A Chromium window will open. Sign in to your Google account — the same one that owns the NotebookLM notebooks you want to query. After login completes, the browser closes automatically and your cookies are stored in `~/.claude/skills/notebooklm/data/browser_state/`.

Run setup:

```bash
python ~/.claude/skills/notebooklm/scripts/run.py auth_manager.py setup
```

Verify:

```bash
python ~/.claude/skills/notebooklm/scripts/run.py auth_manager.py status
```

If auth status is not "authenticated", stop and ask the user to retry before continuing.

## Phase 3: Apply code changes

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

Merge the skill branch:

```bash
git fetch upstream skill/notebooklm
git merge upstream/skill/notebooklm
```

This brings in:
- `scripts/notebooklm_daemon.py`, `scripts/notebooklm_session_pool.py`, `scripts/notebooklm_ask_adapter.py`, `scripts/requirements-notebooklm.txt`
- `launchd/com.nanoclaw.notebooklm.plist`, `setup/systemd/nanoclaw-notebooklm.service`
- `container/agent-runner/src/notebooklm-mcp-stdio.ts`
- `container/agent-runner/src/index.ts` changes (MCP registration — main-group-only)
- `src/container-runner.ts` changes (env propagation + `[NOTEBOOKLM]` log surfacing)
- `.env.example` additions

### Install Python deps into the skill's venv

```bash
python ~/.claude/skills/notebooklm/scripts/run.py -m pip install -r scripts/requirements-notebooklm.txt
```

### Copy agent-runner changes into per-group dirs

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/notebooklm-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Build

```bash
npm run build
./container/build.sh
```

Must be clean.

## Phase 4: Install supervisor + verify

### macOS (launchd)

Substitute placeholders and install the plist:

```bash
PORT="${NOTEBOOKLM_PORT:-11435}"
PY="$(which python3)"
SCRIPT="$(pwd)/scripts/notebooklm_daemon.py"
WORKDIR="$(pwd)"
LOG_DIR="$(pwd)/logs"
mkdir -p "$LOG_DIR"

sed -e "s|__PYTHON__|$PY|g" \
    -e "s|__SCRIPT__|$SCRIPT|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__LOG_DIR__|$LOG_DIR|g" \
    -e "s|__WORKDIR__|$WORKDIR|g" \
    launchd/com.nanoclaw.notebooklm.plist \
    > ~/Library/LaunchAgents/com.nanoclaw.notebooklm.plist

launchctl load ~/Library/LaunchAgents/com.nanoclaw.notebooklm.plist
```

### Linux (systemd user)

```bash
PORT="${NOTEBOOKLM_PORT:-11435}"
PY="$(which python3)"
SCRIPT="$(pwd)/scripts/notebooklm_daemon.py"
WORKDIR="$(pwd)"

mkdir -p ~/.config/systemd/user
sed -e "s|__PYTHON__|$PY|g" \
    -e "s|__SCRIPT__|$SCRIPT|g" \
    -e "s|__PORT__|$PORT|g" \
    -e "s|__WORKDIR__|$WORKDIR|g" \
    setup/systemd/nanoclaw-notebooklm.service \
    > ~/.config/systemd/user/nanoclaw-notebooklm.service

systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-notebooklm.service
```

### Verify daemon health

```bash
PORT="${NOTEBOOKLM_PORT:-11435}"
curl -s "http://127.0.0.1:$PORT/health" | python -m json.tool
```

Expect `ok: true` and `authenticated: true`. If not, inspect `logs/notebooklm-daemon.log`.

### Restart NanoClaw

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 5: Verify end-to-end (agent-visible)

Tell the user:

> Send the following in your main group:
>
> 1. "@assistant list my notebooks" — expect a list with ids/names/topics.
> 2. "@assistant add notebook X asking it about its contents" — expect a source-grounded answer with citations.
> 3. Within 30 seconds, ask a follow-up on the same notebook — the second query should be noticeably faster (warm hit). Confirm with `curl :$PORT/health` showing `warm_hits >= 1`.

### Bleed-through check (important)

Ask two *different, unrelated* questions against the same warmed notebook. The second answer must not reference the first. If it does, set `NOTEBOOKLM_WARM_SESSIONS=0` in `.env` and restart the daemon — warm-session reuse is disabled; each query spawns fresh Chromium. Report the bleed-through observation to the maintainer.

## Troubleshooting

### "NotebookLM daemon unreachable"

Check supervisor status:

```bash
launchctl list | grep notebooklm          # macOS
systemctl --user status nanoclaw-notebooklm   # Linux
tail -50 logs/notebooklm-daemon.log
```

### "NotebookLM auth expired"

Rerun auth setup:

```bash
python ~/.claude/skills/notebooklm/scripts/run.py auth_manager.py reauth
```

### "Rate limit 50/day exceeded"

Wait until UTC midnight, or switch Google account (`auth_manager.py clear` + `auth_manager.py setup`).

### Agent doesn't see notebooklm tools

- Confirm the group is the main group (`isMain: true`). Tools are main-group only.
- Confirm the container was rebuilt after Phase 3: `./container/build.sh`.
- Confirm the agent-runner source was copied to the group's cached dir (Phase 3 loop).

### Warm-session bleed-through

Set `NOTEBOOKLM_WARM_SESSIONS=0` in `.env` and restart the daemon to disable reuse.

## Uninstall (manual, not scripted)

```bash
# Stop supervisor
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.notebooklm.plist   # macOS
# or
systemctl --user disable --now nanoclaw-notebooklm.service              # Linux

# Revert the merge
git log --oneline | grep notebooklm
git revert <commit>  # or: git reset to a pre-merge commit on a branch

./container/build.sh
```

Auth cookies in `~/.claude/skills/notebooklm/data/` stay put — they aren't NanoClaw-owned.
```

- [ ] **Step 10.2: Commit**

```bash
git add .claude/skills/add-notebooklm/SKILL.md
git commit -m "feat(notebooklm): /add-notebooklm installer skill"
```

---

## Task 11: `.env.example` + watch script

**Files:**
- Modify: `.env.example`
- Create: `scripts/notebooklm-watch.sh`

- [ ] **Step 11.1: Update `.env.example`**

Append to `.env.example`:

```bash

# --- NotebookLM (see .claude/skills/add-notebooklm/SKILL.md) ---
# Host-side daemon port. If 11435 is in use, pick a free port — the installer
# auto-detects conflicts, but an explicit value wins.
NOTEBOOKLM_PORT=11435
# Set to 0 to disable warm-session reuse (spawns fresh Chromium every query).
NOTEBOOKLM_WARM_SESSIONS=1
# Idle seconds before an unused warm session is garbage-collected.
NOTEBOOKLM_IDLE_SECONDS=90
# Maximum concurrent warm sessions (LRU). Each session uses ~150MB of RAM.
NOTEBOOKLM_MAX_WARM=3
```

- [ ] **Step 11.2: Create `scripts/notebooklm-watch.sh`**

Create `scripts/notebooklm-watch.sh` (mirror of `ollama-watch.sh`):

```bash
#!/usr/bin/env bash
# Tail the NotebookLM daemon log and pop a macOS notification for each ASK.
# Usage: ./scripts/notebooklm-watch.sh
set -euo pipefail

LOG="${LOG:-logs/notebooklm-daemon.log}"
if [[ ! -f "$LOG" ]]; then
  echo "Log file not found: $LOG" >&2
  exit 1
fi

tail -F "$LOG" | awk '
  /\[NOTEBOOKLM\] .* ASK start/ {
    system("osascript -e \"display notification \\\"NotebookLM: ask started\\\" with title \\\"NanoClaw\\\"\"")
  }
  /\[NOTEBOOKLM\] .* ASK .* duration_ms/ {
    system("osascript -e \"display notification \\\"NotebookLM: ask complete\\\" with title \\\"NanoClaw\\\"\"")
  }
'
```

Make executable:

```bash
chmod +x scripts/notebooklm-watch.sh
```

- [ ] **Step 11.3: Commit**

```bash
git add .env.example scripts/notebooklm-watch.sh
git commit -m "feat(notebooklm): env.example defaults + optional macOS watch script"
```

---

## Task 12: Full integration verification (manual, no commits unless issues)

**Goal:** install end-to-end on the user's host, run the bleed-through check, confirm warm-hit behavior.

- [ ] **Step 12.1: Run the installer**

Invoke the skill:

```
/add-notebooklm
```

Follow all phases. If any phase fails, stop and fix before proceeding.

- [ ] **Step 12.2: Confirm `/health` is green**

```bash
curl -s http://127.0.0.1:${NOTEBOOKLM_PORT:-11435}/health | python -m json.tool
```

Expect `"ok": true, "authenticated": true`.

- [ ] **Step 12.3: Run the integration verify checklist from the spec**

From `docs/superpowers/specs/2026-04-22-notebooklm-skill-design.md` § Testing → Integration:

1. `curl /health` → `authenticated: true` ✓
2. Ask notebook A question → `warm_hit: false`.
3. Same notebook, different question, within 30s → `warm_hit: true`.
4. Wait 90s, ask again → `warm_hit: false`.
5. Bleed-through: two unrelated questions, same warmed notebook — verify no cross-contamination in the second answer.
6. Set `NOTEBOOKLM_WARM_SESSIONS=0`, restart daemon, repeat step 2 — always `warm_hit: false`.

- [ ] **Step 12.4: MCP visibility check**

From the main-group agent: "list my notebooks" — should return the library.

From a non-main group: attempt the same — the agent should respond that it does not have notebooklm tools available (because `mcp__notebooklm__*` is not in `allowedTools` for that group's container).

- [ ] **Step 12.5: Fix + commit any issues found**

For each failure, commit a fix with a descriptive message. Do not merge the branch until all Task 12 steps pass.

---

## Done criteria

- All Python tests pass (`python ~/.claude/skills/notebooklm/scripts/run.py -m pytest scripts/tests/`).
- All Node tests pass (`npm test`).
- `npm run typecheck` clean.
- `./container/build.sh` clean.
- Daemon `/health` returns `ok: true, authenticated: true`.
- Main-group agent has `notebooklm_ask`/`list`/`search` tools available.
- Non-main-group agent does NOT have notebooklm tools.
- Same-notebook follow-up query registers as a warm hit.
- Bleed-through check negative (unrelated questions don't contaminate each other).
- `NOTEBOOKLM_WARM_SESSIONS=0` correctly disables reuse.
