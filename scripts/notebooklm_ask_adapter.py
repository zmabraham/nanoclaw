"""
Adapter that splits upstream's ask_question flow into two reusable phases:

  ensure_session(notebook_url)  -> (browser, context, page) ready to ask on
  ask_on_page(page, question)   -> AskResult(answer, citations)

Upstream (`~/.claude/skills/notebooklm/scripts/ask_question.py`) uses
synchronous patchright and is one monolithic function. Our daemon is
async, so we import upstream's CONFIG CONSTANTS (selectors, profile dir,
browser args) and reimplement the thin orchestration in async patchright.
Upstream is unchanged.

Citations are not extracted by upstream today; AskResult.citations is an
empty list in v1 and stays as a forward-compat field.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

UPSTREAM_SKILL_DIR = Path(os.path.expanduser("~/.claude/skills/notebooklm"))
UPSTREAM_SCRIPTS = UPSTREAM_SKILL_DIR / "scripts"

if str(UPSTREAM_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(UPSTREAM_SCRIPTS))


@dataclass
class AskResult:
    answer: str
    citations: list[dict[str, Any]] = field(default_factory=list)


async def ensure_session(notebook_url: str) -> tuple[Any, Any, Any]:
    """Launch patchright, navigate to notebook, return (browser, context, page)."""
    return await _launch_browser_on_notebook(notebook_url)


async def ask_on_page(page: Any, question: str) -> AskResult:
    """Fill the input on an already-loaded notebook page, submit, extract the answer."""
    return await _submit_question_and_extract(page, question)


# ----- seam functions (patched by tests, backed by upstream in prod) --------


async def _launch_browser_on_notebook(notebook_url: str) -> tuple[Any, Any, Any]:
    """
    Async-patchright mirror of upstream's sync launch path.

    Reuses upstream's config constants (profile dir, browser args, user agent,
    state cookie file) so auth state is shared with the upstream CLI.
    Returns (browser_proxy, context, page). The "browser" return slot holds the
    async_playwright context manager proxy so callers can close it cleanly.
    """
    from patchright.async_api import async_playwright  # upstream venv
    from config import (  # upstream constants
        BROWSER_ARGS,
        BROWSER_PROFILE_DIR,
        STATE_FILE,
        USER_AGENT,
        QUERY_INPUT_SELECTORS,
    )

    pw_cm = async_playwright()
    playwright = await pw_cm.start()
    try:
        context = await playwright.chromium.launch_persistent_context(
            user_data_dir=str(BROWSER_PROFILE_DIR),
            channel="chrome",
            headless=True,
            no_viewport=True,
            ignore_default_args=["--enable-automation"],
            user_agent=USER_AGENT,
            args=BROWSER_ARGS,
        )
    except Exception:
        await playwright.stop()
        raise

    # Cookie workaround for Playwright bug #36139 (mirrors upstream browser_utils).
    try:
        if STATE_FILE.exists():
            with open(STATE_FILE, "r") as f:
                state = json.load(f)
            if state.get("cookies"):
                await context.add_cookies(state["cookies"])
    except Exception:
        # Non-fatal: if cookie injection fails, the persistent profile may still
        # carry a valid session. Auth errors surface later via /health.
        pass

    page = await context.new_page()
    try:
        await page.goto(notebook_url, wait_until="domcontentloaded")
        # Wait for the query-input selector to become visible — the signal that
        # NotebookLM is ready to accept input.
        ready = False
        for selector in QUERY_INPUT_SELECTORS:
            try:
                await page.wait_for_selector(selector, timeout=10_000, state="visible")
                ready = True
                break
            except Exception:
                continue
        if not ready:
            raise RuntimeError(
                f"NotebookLM did not present a query input at {notebook_url}; "
                "possible auth expiry or unfamiliar UI."
            )
    except Exception:
        await context.close()
        await playwright.stop()
        raise

    # Stash the playwright root so the caller can cleanly shut it down alongside
    # the browser context. We return it in the "browser" slot (first tuple elem)
    # to fit the existing (browser, context, page) contract in the session pool.
    class _Browser:
        def __init__(self, pw: Any, ctx: Any) -> None:
            self._pw = pw
            self._ctx = ctx

        async def close(self) -> None:
            try:
                await self._ctx.close()
            finally:
                await self._pw.stop()

    return _Browser(playwright, context), context, page


async def _submit_question_and_extract(page: Any, question: str) -> AskResult:
    """
    Fill input, submit, poll for stable response, return AskResult.

    Mirrors upstream's ask_notebooklm polling algorithm (stable text for 3
    consecutive polls, bounded by QUERY_TIMEOUT_SECONDS). Citations are left
    empty — upstream does not extract them.
    """
    from config import (  # upstream constants
        QUERY_INPUT_SELECTORS,
        QUERY_TIMEOUT_SECONDS,
        RESPONSE_SELECTORS,
    )

    # Find a usable input selector (first match wins; mirrors upstream).
    chosen_input: str | None = None
    for selector in QUERY_INPUT_SELECTORS:
        try:
            await page.wait_for_selector(selector, timeout=5_000, state="visible")
            chosen_input = selector
            break
        except Exception:
            continue
    if chosen_input is None:
        raise RuntimeError("NotebookLM query input not found — UI may have changed.")

    # Type the question. fill() is simpler than human-typing; we rely on the
    # persistent-profile fingerprint for anti-detection rather than keystroke
    # timing (matches what NotebookLM sees for any human-fast typer).
    await page.fill(chosen_input, question)
    await page.keyboard.press("Enter")

    # Poll for stable answer text. "Stable" = identical text across 3 polls at
    # 1s cadence, matching upstream. Skip polls while the thinking indicator
    # is visible.
    deadline = time.monotonic() + QUERY_TIMEOUT_SECONDS
    last_text: str | None = None
    stable_count = 0
    answer: str | None = None

    while time.monotonic() < deadline:
        try:
            thinking = await page.query_selector("div.thinking-message")
            if thinking is not None and await thinking.is_visible():
                await asyncio.sleep(1)
                continue
        except Exception:
            pass

        for selector in RESPONSE_SELECTORS:
            try:
                elements = await page.query_selector_all(selector)
                if elements:
                    latest = elements[-1]
                    text = (await latest.inner_text()).strip()
                    if text:
                        if text == last_text:
                            stable_count += 1
                            if stable_count >= 3:
                                answer = text
                                break
                        else:
                            stable_count = 0
                            last_text = text
            except Exception:
                continue

        if answer is not None:
            break
        await asyncio.sleep(1)

    if answer is None:
        raise RuntimeError("Timed out waiting for a stable NotebookLM answer.")

    return AskResult(answer=answer, citations=[])
