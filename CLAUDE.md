# GabAI

Shluchim-focused fork of [nanoclaw](https://github.com/qwibitai/nanoclaw), maintained by ChabadLabs.

See [README.md](README.md) for philosophy and setup. See [CONTRIBUTING.md](CONTRIBUTING.md) for the two-repo contribution model (code on `ChabadLabs/GabAI`, marketplace on `ChabadLabs/GabAIskills`). See [docs/SKILLS.md](docs/SKILLS.md) for the full skills index. See [docs/SPEC.md](docs/SPEC.md) for architecture.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail, Emacs) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

> **Fork boundary note:** GabAI ships only what ChabadLabs has audited as a marketplace entry. Skills like `pdf-reader`, `image-vision`, `karpathy-llm-wiki`, `parallel`, and `telegram-swarm` continue to work via upstream `/add-<name>` slash commands, but they're not in the GabAI marketplace catalog. The marketplace is the shortlist that `/gabai-core:install-skill` knows about. The `emacs` channel already ships on `main` — it's imported in `src/channels/index.ts` — so no extra install step is needed for it.

## Key Files (on `main`)

### Orchestrator

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/config.ts` | Trigger pattern, paths, intervals, env-allowlist |
| `src/env.ts` | Env-var allowlist + audit helpers |
| `src/logger.ts` | Logger |
| `src/types.ts` | Core types: `NewMessage`, channel callbacks, agent I/O |

### Channels

| File | Purpose |
|------|---------|
| `src/channels/registry.ts` | Channel registry — channels self-register at startup |
| `src/channels/index.ts` | Channel entry point (imports trigger registration) |
| `src/channels/emacs.ts` | Emacs HTTP-bridge channel (ships on `main`; other channels ship via `/add-*` skills) |

Channels shipped via skills: `whatsapp` (`/add-whatsapp`), `telegram`, `slack`, `discord`, `gmail`. Each self-registers when its skill has been applied.

### Container runtime

| File | Purpose |
|------|---------|
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/container-runtime.ts` | Runtime abstraction (Docker / Apple Container) |
| `src/credential-proxy.ts` | Built-in `.env`-based credential proxy (alternative to OneCLI) |
| `src/mount-security.ts` | Mount allowlist enforcement |
| `src/group-folder.ts` | Per-group workspace folder management |

### Message flow

| File | Purpose |
|------|---------|
| `src/ipc.ts` | IPC watcher — tasks/responses between host and container |
| `src/ipc-auth.test.ts` | IPC auth surface (implementation in `ipc.ts`) |
| `src/router.ts` | Outbound message formatting and routing |
| `src/formatting.test.ts` | Channel-formatting conversion tests |
| `src/group-queue.ts` | Per-group message queue with global concurrency |
| `src/task-scheduler.ts` | Scheduled-task runner (cron-style jobs) |
| `src/session-cleanup.ts` | Session teardown |
| `src/sender-allowlist.ts` | Sender-level access control |
| `src/remote-control.ts` | Remote-control mode (main-group debugging over chat) |

### Persistence

| File | Purpose |
|------|---------|
| `src/db.ts` | SQLite operations — messages, groups, sessions, state |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

### Container

| Dir | Purpose |
|-----|---------|
| `container/agent-runner/` | Node app that runs inside the container — loads Claude Agent SDK, executes the conversation |
| `container/skills/` | Container-runtime skills (browser, status, formatting) — loaded on container spawn |
| `container/Dockerfile` | Container image definition |
| `container/build.sh` | Container build wrapper |

### Setup & installer entry points

| Dir | Purpose |
|-----|---------|
| `.claude/skills/` | Operational + utility skills (not branch-based) — invoked as `/setup`, `/debug`, `/customize`, etc. |

Skill installation uses the `chabadlabs` remote pattern — `/gabai-core:install-skill <name>` ensures the remote exists, fetches `skill/<name>` from `ChabadLabs/GabAI`, and merges it. Each skill's `SKILL.md` describes its own post-merge setup (env vars, container rebuild, etc.). No dedicated installer script on `main`; the install logic lives per-skill.

## Secrets / Credentials / Proxy (OneCLI)

API keys, secret keys, OAuth tokens, and auth credentials are managed by the OneCLI gateway — which handles secret injection into containers at request time, so no keys or tokens are ever passed to containers directly. Run `onecli --help`.

If you're not using OneCLI, the `/use-native-credential-proxy` skill switches GabAI to a built-in `.env`-based proxy — simpler, but keys live on disk in the fork instead of a vault.

## Skills

Four types of skills. See [CONTRIBUTING.md](CONTRIBUTING.md#skill-types) for the full taxonomy.

- **Feature skills (branch-based)** — merge a `skill/*` branch to add capabilities. In GabAI, these land on `ChabadLabs/GabAI/skill/<name>` and require a matching catalog entry on `ChabadLabs/GabAIskills`. Installed via `/gabai-core:install-skill <name>`.
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. `/claw`).
- **Operational skills** — instruction-only workflows on `main` (e.g. `/setup`, `/debug`, `/customize`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`).

Most-used top-level skills — the full index is in [docs/SKILLS.md](docs/SKILLS.md):

| Skill | When to use |
|-------|-------------|
| `/gabai-core:setup` | First-time installation, authentication, service configuration |
| `/gabai-core:list-skills` | Browse marketplace catalog |
| `/gabai-core:install-skill <name>` | Install a skill from the marketplace |
| `/gabai-core:contribute <name>` | Package your own skill as a linked PR pair |
| `/gabai-core:update` | Pull latest GabAI main and rebuild |
| `/customize` | Add channels, integrations, change behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, **you MUST read [CONTRIBUTING.md](CONTRIBUTING.md)**. It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, the two-repo model (GabAI + GabAIskills), the `/gabai-core:contribute` helper, and PR requirements.

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:

```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is a separate skill, not bundled in core. Run `/add-whatsapp` to install it. Existing auth credentials and groups are preserved.

**Container build cache:** The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
