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


async def test_concurrent_miss_same_url_launches_only_once(fake_clock):
    """Concurrent acquires against an empty pool must share a single launch."""
    launch_started = asyncio.Event()
    launch_proceed = asyncio.Event()
    launch_count = {"n": 0}

    async def slow_launcher(url: str):
        launch_count["n"] += 1
        launch_started.set()
        await launch_proceed.wait()
        browser = MagicMock()
        browser.close = AsyncMock()
        return browser, MagicMock(), MagicMock()

    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=9999), launcher=slow_launcher, clock=fake_clock)

    async def try_acquire():
        r = await pool.acquire("https://x/a")
        await pool.release(r)
        return r.hit

    t1 = asyncio.create_task(try_acquire())
    t2 = asyncio.create_task(try_acquire())
    t3 = asyncio.create_task(try_acquire())

    await launch_started.wait()
    # At this point one launch is underway and the others should be awaiting it
    launch_proceed.set()

    hits = await asyncio.gather(t1, t2, t3)
    # Exactly one real launch, regardless of which task won the race
    assert launch_count["n"] == 1
    # At least two of the three must have been warm hits (served by the leader's entry)
    assert sum(hits) >= 2
    await pool.shutdown()


async def test_gc_skips_in_use_session(fake_clock, fake_launcher):
    """GC must not close a session whose per-entry lock is currently held."""
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=30), launcher=fake_launcher, clock=fake_clock)
    r = await pool.acquire("https://x/a")  # holds the per-entry lock
    browser = r.browser
    fake_clock.advance(31)  # would normally be stale
    evicted = await pool.run_gc_once()
    assert evicted == 0
    browser.close.assert_not_called()
    # After release, the next GC run should collect it.
    await pool.release(r)
    fake_clock.advance(31)
    evicted = await pool.run_gc_once()
    assert evicted == 1
    browser.close.assert_awaited_once()
    await pool.shutdown()


async def test_evict_of_in_use_session_defers_close_to_release(fake_clock, fake_launcher):
    """evict() on a locked entry must not close the browser out from under the holder."""
    pool = SessionPool(PoolConfig(max_warm=3, idle_seconds=9999), launcher=fake_launcher, clock=fake_clock)
    r = await pool.acquire("https://x/a")  # holds lock
    browser = r.browser
    removed = await pool.evict("https://x/a")
    assert removed is True
    browser.close.assert_not_called()  # still in use, not closed yet
    # Next lookup must not reuse it
    r2 = await pool.acquire("https://x/a")
    try:
        assert r2.hit is False
        assert fake_launcher.calls["n"] == 2
    finally:
        await pool.release(r2)
    # Releasing the evicted session closes it.
    await pool.release(r)
    browser.close.assert_awaited_once()
    await pool.shutdown()


async def test_pool_config_rejects_invalid_values():
    with pytest.raises(ValueError):
        PoolConfig(max_warm=0)
    with pytest.raises(ValueError):
        PoolConfig(idle_seconds=0)
