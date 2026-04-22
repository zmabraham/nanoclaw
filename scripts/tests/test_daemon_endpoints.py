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
