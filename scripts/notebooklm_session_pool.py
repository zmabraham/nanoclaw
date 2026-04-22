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

    def __post_init__(self) -> None:
        if self.max_warm < 1:
            raise ValueError("max_warm must be >= 1")
        if self.idle_seconds <= 0:
            raise ValueError("idle_seconds must be > 0")


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
        # In-flight launches for the same URL share a future so we never spawn twice.
        self._pending: dict[str, asyncio.Future[_Entry]] = {}
        self._table_lock = asyncio.Lock()
        self._gc_task: asyncio.Task | None = None

    async def acquire(self, notebook_url: str) -> AcquiredSession:
        if not self._config.warm_enabled:
            browser, context, page = await self._launcher(notebook_url)
            return AcquiredSession(notebook_url, browser, context, page, hit=False, _pool=self)

        # Retry loop: if a concurrent evictor invalidates our entry while we're
        # waiting on its per-entry lock, we restart the lookup from the top.
        while True:
            leader = False
            fut: asyncio.Future[_Entry] | None = None

            async with self._table_lock:
                entry = self._entries.get(notebook_url)
                if entry is not None:
                    self._entries.move_to_end(notebook_url)
                else:
                    pending = self._pending.get(notebook_url)
                    if pending is None:
                        # We're the leader for this URL's launch.
                        fut = asyncio.get_running_loop().create_future()
                        self._pending[notebook_url] = fut
                        leader = True
                    else:
                        fut = pending

            if entry is not None:
                # Warm-hit candidate: wait for the per-entry lock, then re-validate.
                await entry.lock.acquire()
                async with self._table_lock:
                    still_there = self._entries.get(notebook_url) is entry
                if still_there:
                    entry.last_used_at = self._clock()
                    return AcquiredSession(
                        notebook_url, entry.browser, entry.context, entry.page, hit=True, _pool=self
                    )
                # Evicted while we waited — release and retry from the top.
                entry.lock.release()
                continue

            if not leader:
                # Another task is launching for this URL. Wait for them, then retry lookup.
                assert fut is not None
                try:
                    new_entry = await fut
                except Exception:
                    # Leader failed — retry from top (next iteration will either
                    # become leader itself or find a fresh pending entry).
                    continue
                # Claim a shared warm hit on the freshly launched entry.
                await new_entry.lock.acquire()
                async with self._table_lock:
                    still_there = self._entries.get(notebook_url) is new_entry
                if still_there:
                    new_entry.last_used_at = self._clock()
                    return AcquiredSession(
                        notebook_url, new_entry.browser, new_entry.context, new_entry.page, hit=True, _pool=self
                    )
                new_entry.lock.release()
                continue

            # Leader path: perform the actual launch exactly once.
            assert fut is not None
            try:
                browser, context, page = await self._launcher(notebook_url)
            except Exception as exc:
                async with self._table_lock:
                    self._pending.pop(notebook_url, None)
                if not fut.done():
                    fut.set_exception(exc)
                raise

            new_entry = _Entry(notebook_url, browser, context, page, self._clock())
            await new_entry.lock.acquire()

            to_close: list[_Entry] = []
            async with self._table_lock:
                self._entries[notebook_url] = new_entry
                self._entries.move_to_end(notebook_url)
                while len(self._entries) > self._config.max_warm:
                    _, evicted = self._entries.popitem(last=False)
                    to_close.append(evicted)
                self._pending.pop(notebook_url, None)

            if not fut.done():
                fut.set_result(new_entry)

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
        # If the entry is still in use (lock held), the current holder owns the
        # close when it calls release() — the entry is already removed from the
        # table so no new lookup will reuse it. Closing here would yank the
        # browser out from under an in-flight query.
        if entry.lock.locked():
            return True
        await self._close_entry(entry)
        return True

    async def run_gc_once(self) -> int:
        cutoff = self._clock() - self._config.idle_seconds
        to_close: list[_Entry] = []
        async with self._table_lock:
            # Skip entries whose per-entry lock is currently held — those are
            # in-flight queries; GC picks them up on the next cycle after release.
            stale = [
                url for url, e in self._entries.items()
                if e.last_used_at < cutoff and not e.lock.locked()
            ]
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
