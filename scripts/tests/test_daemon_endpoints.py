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
