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
