# /add-notebooklm — NotebookLM Skill for NanoClaw

**Status:** Design (awaiting approval)
**Date:** 2026-04-22
**Author:** collaborative brainstorming
**Target user:** main-group agent queries NotebookLM with private-account auth, heavy query volume, low latency

## Purpose

Let the NanoClaw main-group agent query the user's Google NotebookLM notebooks (including private ones) with source-grounded, citation-backed answers — as a light wrapper around the upstream skill at https://github.com/PleasePrompto/notebooklm-skill.

## Requirements

Hard requirements (from user):

1. **Private-notebook access** — answers draw from the user's own Google account, not just public notebooks.
2. **Main group only** — MCP tools are exposed only when `input.isMain === true`. Other groups cannot query notebooks.
3. **Fresh Chromium per unique query stream** — each notebook's first query in a session spawns a fresh Chromium (explicit user preference).
4. **Low per-query latency** under heavy use — dominant cost today is browser spawn (~3–5s) and Python import (~1–3s); both to be minimized.
5. **venv isolation** — no system Python pollution.
6. **Light wrapper** — treat upstream skill as a library. No fork. Minimal new code in NanoClaw.

Derived requirements:

7. **Warm session reuse for same-notebook follow-ups** — when a recent idle session exists for the same `notebook_url`, the next query reuses it instead of spawning fresh Chromium. Falls back automatically if reuse fails.
8. **Graceful failure modes** — daemon unreachable, auth expired, rate-limited (NotebookLM's 50/day), and stale-session retries each produce actionable agent-visible errors.
9. **Single-host supervisor** — daemon runs under launchd (macOS) or systemd user unit (Linux), survives reboots, restarts on crash.

Explicitly out of scope (YAGNI):

- Dedicated Docker container for the daemon (host daemon chosen).
- MCP tools for `add`/`activate`/`remove`/`auth` (host-side CLI only).
- Cross-notebook session sharing (warm pool keyed by notebook URL).
- X11/VNC forwarding for in-container browser auth.
- Non-main group access.
- Persistent in-conversation memory across daemon restarts (warm sessions are ephemeral by design).

## Architecture

```
main-group container                      host (always-up)
┌───────────────────────────────────┐     ┌──────────────────────────────────┐
│ agent-runner                       │     │ ~/.claude/skills/notebooklm/     │
│  ├─ index.ts                       │     │  ├─ .venv/ (upstream-managed)    │
│  │   registers MCP only if        │     │  ├─ scripts/run.py               │
│  │   input.isMain === true         │     │  ├─ scripts/ask_question.py     │
│  ├─ notebooklm-mcp-stdio.ts ◄──────┼─────┤  ├─ scripts/notebook_manager.py │
│  │   HTTP client →                 │ HTTP│  └─ data/                        │
│  │   http://host.docker.internal/  │     │      ├─ browser_state/ (cookies) │
│  │     ${NOTEBOOKLM_PORT}          │     │      └─ library.json             │
│  └─ allowedTools:                  │     │                                  │
│     mcp__notebooklm__ask,          │     │ scripts/notebooklm-daemon.py     │
│     mcp__notebooklm__list,         │     │  ├─ aiohttp server, 127.0.0.1    │
│     mcp__notebooklm__search        │     │  ├─ session_pool (warm cache)    │
│                                    │     │  └─ on /ask: lock → ensure       │
│                                    │     │     session → ask_on_page →      │
│                                    │     │     retry-fresh on failure       │
│                                    │     │                                  │
│                                    │     │ supervised by launchd/systemd    │
└───────────────────────────────────┘     └──────────────────────────────────┘
```

### Design principles

- **Upstream is a library.** We import its modules, we don't fork its code. If upstream changes, we adapt the wrapper — not the other way around.
- **State lives on host, never in container.** Cookies, library, venv — all in `~/.claude/skills/notebooklm/data/` and `.venv/`. Containers are stateless callers.
- **One warm-session feature flag.** `NOTEBOOKLM_WARM_SESSIONS=0` falls back to one-shot Chromium per query. Escape hatch if reuse misbehaves.
- **Daemon is localhost-only.** No authentication, binds `127.0.0.1` — same trust model as the existing `add-ollama-tool` integration.

## Components

| File | New/Modified | Purpose |
|---|---|---|
| `.claude/skills/add-notebooklm/SKILL.md` | new | Installer: preflight, upstream clone-if-missing, auth setup, daemon install, supervisor register, restart, verify |
| `scripts/notebooklm-daemon.py` | new | aiohttp server, imports upstream modules once, manages warm-session pool |
| `scripts/notebooklm_session_pool.py` | new | `WarmSession` class, LRU pool, asyncio locks, GC task |
| `scripts/notebooklm_ask_adapter.py` | new | Splits upstream's `ask_question.py` into `ensure_session()` + `ask_on_page()` without forking upstream source |
| `scripts/notebooklm-watch.sh` | new | Optional macOS notification watcher (mirror of `ollama-watch.sh`) |
| `launchd/com.nanoclaw.notebooklm.plist` | new | macOS supervisor |
| `setup/systemd/nanoclaw-notebooklm.service` | new | Linux user-unit supervisor |
| `container/agent-runner/src/notebooklm-mcp-stdio.ts` | new | MCP stdio → HTTP bridge inside container |
| `container/agent-runner/src/index.ts` | modified | Conditionally register MCP server + allowedTools when `input.isMain === true` |
| `src/container-runner.ts` | modified | Surface `[NOTEBOOKLM]` log lines (mirror of existing `[OLLAMA]` pattern) |
| `.env.example` | modified | Add `NOTEBOOKLM_PORT`, `NOTEBOOKLM_WARM_SESSIONS`, `NOTEBOOKLM_IDLE_SECONDS`, `NOTEBOOKLM_MAX_WARM` |

## Data flow

### One-time setup (installer)

```
User runs /add-notebooklm
  ↓
Phase 1 · Preflight
  ├─ check ~/.claude/skills/notebooklm/ exists; git clone upstream if not
  ├─ check Python 3.10+
  └─ check port NOTEBOOKLM_PORT (default 11435) free
  ↓
Phase 2 · Auth bootstrap (user choice "B — handle from scratch")
  ├─ tell user: "visible Chromium will open; log into Google"
  ├─ run: python scripts/run.py auth_manager.py setup
  ├─ wait for completion
  ├─ verify: python scripts/run.py auth_manager.py status
  └─ abort install on auth failure
  ↓
Phase 3 · Apply code changes
  ├─ git fetch + merge upstream/skill/notebooklm
  ├─ copy updated agent-runner source to per-group dirs (same pattern as Ollama)
  ├─ npm run build
  └─ ./container/build.sh
  ↓
Phase 4 · Install supervisor + verify
  ├─ launchctl load ~/Library/LaunchAgents/com.nanoclaw.notebooklm.plist  (mac)
  ├─ or: systemctl --user enable --now nanoclaw-notebooklm.service       (linux)
  ├─ curl http://127.0.0.1:${NOTEBOOKLM_PORT}/health → expect {ok:true, authenticated:true}
  ├─ restart nanoclaw service
  └─ tell user: "test with: '@assistant ask my notebook about X'"
```

### Query path (happy path, warm hit)

```
Agent decides to query NotebookLM
  ↓
MCP tool invocation: notebooklm_ask({question, notebook_url})
  ↓
notebooklm-mcp-stdio.ts (in container)
  ↓ HTTP POST host.docker.internal:11435/ask
Daemon receives request
  ↓
session_pool.acquire(notebook_url):
  ├─ warm session exists & idle? → return (lock held)
  └─ else → launch fresh Chromium, navigate to notebook_url, wait ready → cache, return (lock held)
  ↓
ask_on_page(page, question):
  ├─ fill input, submit
  ├─ wait for answer-complete DOM marker
  └─ extract answer text + citations
  ↓
session_pool.release(notebook_url): update last_used_at, drop lock
  ↓
Daemon → HTTP 200 → MCP tool → agent receives answer
```

### Query path (failure with fallback)

```
ask_on_page() raises (stale page / cookie expired / UI changed)
  ↓
session_pool.evict(notebook_url) — close that Chromium
  ↓
Retry ONCE with fresh Chromium (same notebook_url)
  ↓
Still fails → HTTP 500 to MCP with structured error; agent sees actionable message
```

## Daemon HTTP protocol

Binds `127.0.0.1:${NOTEBOOKLM_PORT}` only. No auth token.

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/ask` | `{question: str, notebook_id?: str, notebook_url?: str}` | `{answer: str, citations: [...], notebook: {id, name}, warm_hit: bool}` |
| GET | `/list` | — | `{notebooks: [{id, name, description, topics, url}, ...]}` |
| GET | `/search?q=…` | — | `{notebooks: [...]}` |
| GET | `/health` | — | `{ok: bool, authenticated: bool, active_notebook: str\|null, warm_sessions: [{notebook_url, last_used_at}], warm_hits: int, warm_misses: int, uptime_s: int}` |

Error responses: HTTP 4xx/5xx + `{error: str, hint?: str}`.

## MCP tools (agent-facing)

Registered only when `input.isMain === true`. Other groups see no notebooklm tools.

### `notebooklm_ask`
- **Params:** `{question: string, notebook_id?: string, notebook_url?: string}`
- **Behavior:** primary query. Requires `notebook_id` OR `notebook_url` (not both required — daemon resolves active notebook if neither provided).
- **Returns:** `{answer, citations, notebook, warm_hit}`

### `notebooklm_list`
- **Params:** `{}`
- **Returns:** `{notebooks: [...]}`

### `notebooklm_search`
- **Params:** `{query: string}`
- **Returns:** `{notebooks: [...]}`

No `add`/`activate`/`remove`/`auth_setup` MCP tools — host-side CLI only. The agent doesn't get to mutate the library or touch auth.

## Warm-session pool

### Data model

```python
@dataclass
class WarmSession:
    notebook_url: str
    browser: patchright.Browser
    context: patchright.BrowserContext
    page: patchright.Page
    last_used_at: float       # monotonic
    lock: asyncio.Lock        # prevent concurrent ask on same page
```

### Pool behavior

- **Key:** `notebook_url` (canonicalized).
- **Capacity:** `NOTEBOOKLM_MAX_WARM` (default `3`). When full and a new notebook is requested, evict LRU.
- **Idle GC:** background task every 15s — close any session whose `last_used_at` exceeds `NOTEBOOKLM_IDLE_SECONDS` (default `90`).
- **Acquire flow:** `acquire(url)` returns a locked session. If cache miss, launches fresh Chromium (patchright, headless, with `browser_state/` persistent context). Caller must `release()`.
- **Eviction flow:** `evict(url)` closes browser, removes from pool. Called on `ask_on_page` error or idle timeout.
- **Feature flag:** `NOTEBOOKLM_WARM_SESSIONS=0` → every `acquire` is cache-miss + no-insert (equivalent to one-shot).

### Retry-with-fresh

On `ask_on_page` exception during reuse:
1. Evict the failed session.
2. Retry `acquire()` once — forces fresh Chromium.
3. Run `ask_on_page` again.
4. If still fails → surface error to caller.

Exactly one automatic retry per query. No exponential backoff. No queuing.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `NOTEBOOKLM_PORT` | `11435` | Daemon HTTP port (host-only bind) |
| `NOTEBOOKLM_WARM_SESSIONS` | `1` | Master toggle for warm-session reuse |
| `NOTEBOOKLM_IDLE_SECONDS` | `90` | Seconds of idle before GC closes a warm session |
| `NOTEBOOKLM_MAX_WARM` | `3` | LRU cap; each warm session ~150MB RAM |
| `NOTEBOOKLM_LOG_LEVEL` | `INFO` | daemon log level |

All optional; sensible defaults let the install Just Work.

## Error handling & agent-visible messages

| Condition | MCP response | Agent-actionable hint |
|---|---|---|
| Daemon unreachable | `NotebookLMUnreachable: connection refused on port N` | "Run `launchctl list \| grep notebooklm` (mac) or `systemctl --user status nanoclaw-notebooklm` (linux)" |
| Auth expired | `NotebookLMAuthExpired` | "Run `python ~/.claude/skills/notebooklm/scripts/run.py auth_manager.py reauth`" |
| NotebookLM rate limit hit | `NotebookLMRateLimit: 50/day exceeded` | "Wait until UTC midnight or switch Google account" |
| Notebook not found | `NotebookNotFound: id/url X not in library` | "List with `notebooklm_list`; add via host CLI `notebook_manager.py add`" |
| Retry-with-fresh also fails | `NotebookLMAskFailed: <underlying>` | include last error text; suggest `--show-browser` local debug |
| Port already in use (install) | fatal install error | "Set NOTEBOOKLM_PORT in .env" |

All errors include a `hint` field so the agent can relay an actionable next step to the user.

## Logging & observability

- Daemon logs to `logs/notebooklm-daemon.log` (rotated by launchd/systemd where possible).
- Key log tags: `[NOTEBOOKLM] ASK start`, `[NOTEBOOKLM] ASK warm=true|false duration_ms=N`, `[NOTEBOOKLM] SESSION evict reason=…`.
- `src/container-runner.ts` surfaces `[NOTEBOOKLM]`-prefixed lines into the main `nanoclaw.log` (mirror of the existing `[OLLAMA]` pattern).
- `/health` exposes `warm_hits` / `warm_misses` counters for quick verification.
- `scripts/notebooklm-watch.sh` optionally posts macOS notifications on each ask (useful during heavy-use tuning).

## Security model

- Daemon binds `127.0.0.1` only — no LAN or container exposure beyond the Docker-internal `host.docker.internal` hop.
- No daemon-level auth token — same trust model as `add-ollama-tool`. Any process on the host can reach it; this is the user's own machine.
- `browser_state/` never leaves the host. Container never sees cookies.
- The upstream skill's `.env` (if any) is *not* mounted into the agent container.
- Agent cannot mutate the library or auth — no MCP tools for those operations.
- Main-group-only exposure: agent containers for non-main groups do not register the MCP server, so even if another group tried to call `host.docker.internal:11435` via raw HTTP, it has no MCP client wiring and no `allowedTools` permission.

## Testing

### Daemon unit tests (`scripts/tests/`, pytest)

- `test_session_pool.py` — acquire/release semantics, LRU eviction, idle GC, flag disable.
- `test_ask_adapter.py` — `ensure_session` + `ask_on_page` split works against a mocked page.
- `test_daemon_endpoints.py` — `/health`, `/list`, `/search` with mocked upstream modules.

### Integration (manual, part of install verify)

1. `curl /health` → `{authenticated: true}`.
2. Ask a question against notebook A — expect `warm_hit: false`.
3. Ask a *different* question against notebook A within 30s — expect `warm_hit: true`.
4. Wait 90s, ask again — expect `warm_hit: false`.
5. Ask two *different* unrelated questions against the same warmed notebook — confirm the second answer does *not* echo/reference the first (bleed-through check).
6. Flip `NOTEBOOKLM_WARM_SESSIONS=0` in `.env`, restart daemon, repeat step 2 — expect `warm_hit: false` always.

Bleed-through check (step 5) is the key empirical test — it validates the core assumption that NotebookLM's same-tab chat UI doesn't contaminate answers across unrelated questions.

### MCP integration

- From main-group agent: "list my notebooks" → tool call → readable list.
- From main-group agent: "ask notebook X about Y" → answer with citations.
- From non-main group: confirm no notebooklm tools are visible (`mcp__notebooklm__*` absent from tool list).

## Rollout & idempotency

- Installer is idempotent: rerunning detects existing daemon, existing supervisor unit, existing merge — skips cleanly.
- Uninstall path (documented, not scripted in v1): `launchctl unload`/`systemctl --user disable`, remove plist/service file, `git revert` the skill merge. Auth cookies can stay in `~/.claude/skills/notebooklm/data/` — they aren't NanoClaw-owned.

## Open questions (to resolve during implementation, not blocking design)

1. **Upstream `ask_question.py` refactor approach** — monkey-patch at import, or submit a PR upstream adding `ensure_session()` / `ask_on_page()` as library functions? (Start with monkey-patch in `notebooklm_ask_adapter.py`; upstream PR is stretch.)
2. **Port collision with user setups** — if `11435` conflicts, installer should auto-pick next free port and write to `.env`. (Implementer choice.)
3. **aiohttp vs. stdlib `http.server`** — aiohttp preferred for async-friendly integration with patchright's asyncio. Adds one dep; acceptable.
