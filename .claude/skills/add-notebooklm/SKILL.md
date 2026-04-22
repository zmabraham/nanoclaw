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
~/.claude/skills/notebooklm/.venv/bin/python -m pip install -r scripts/requirements-notebooklm.txt
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
> 2. "@assistant ask notebook X about its contents" — expect a source-grounded answer with citations.
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
