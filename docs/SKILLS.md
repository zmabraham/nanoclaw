# GabAI Skills Reference

Index of the Claude Code skills commonly used on a GabAI install. Run commands inside the `claude` CLI. This is not an exhaustive list of every skill on disk — it's the curated set a shliach is likely to reach for, plus upstream skills worth knowing about. To see everything available, run `/gabai-core:list-skills` or browse `.claude/skills/`.

Skills come from two places:

- **Marketplace** (curated by ChabadLabs) — installable via `/gabai-core:install-skill <name>`. These are audited for shluchim defaults, dependency order, and cross-skill interactions. The catalog lives in [`ChabadLabs/GabAIskills`](https://github.com/ChabadLabs/GabAIskills).
- **Upstream slash commands** — ship with nanoclaw and run as `/add-<name>` or `/<name>` directly in Claude Code. No marketplace entry; merge-on-demand against the upstream skill branch or apply to the current fork.

For the skill taxonomy (feature / operational / utility / container) see [CONTRIBUTING.md](../CONTRIBUTING.md#skill-types). For container skills (loaded inside agent containers, not on the host) see [`container/skills/`](../container/skills/).

---

## Shluchim-essential (marketplace)

Install these on a fresh GabAI — `/gabai-core:setup` pre-selects most of them.

| Skill | Description |
|-------|-------------|
| `/gabai-core:install-skill shabbat-mode` | Pause all activity during Shabbat and Yom Tov based on Hebrew calendar + location |
| `/gabai-core:install-skill reactions` | WhatsApp emoji status reactions (👀 → 💭 → 🔄 → ✅/❌) on every message the agent processes |
| `/gabai-core:install-skill group-lifecycle` | Group unregistration via IPC for dynamic group management |
| `/gabai-core:install-skill ipc-handler-registry` | Modular IPC handler registration with self-heal error reporting (infrastructure for other skills) |
| `/gabai-core:install-skill lifecycle-hooks` | Startup / shutdown hooks, message event emitters, and processing guards |
| `/gabai-core:install-skill container-hardening` | Dead-process guards, log rotation, plugins sync — robustness in the container pipeline |
| `/gabai-core:install-skill task-scheduler-fixes` | Prevents duplicate task execution and improves task-result routing |

## Setup & Runtime

| Skill | Description | Source |
|-------|-------------|--------|
| `/gabai-core:setup` | Guided first-time setup — forks, container, credentials, channel, skills. Pre-selects non-API-key skills. | marketplace |
| `/gabai-core:update` | Pull latest GabAI main + rebuild | marketplace |
| `/gabai-core:install-skill convert-to-apple-container` (or `/convert-to-apple-container` directly) | Switch container runtime from Docker to Apple Container (macOS only) | marketplace |
| `/debug` | Triage container agent failures, logs, mount and session issues | operational |
| `/customize` | Add channels or modify behavior interactively | operational |
| `/update-nanoclaw` | Bring upstream NanoClaw changes into your fork | operational |
| `/update-skills` | Check installed skill branches against upstream and apply updates | operational |
| `/migrate-nanoclaw` | Heavy-lift migration for deep fork divergence | operational |
| `/migrate-from-openclaw` | One-shot migration from an OpenClaw installation | operational |
| `/init-onecli` | Set up OneCLI Agent Vault and migrate `.env` credentials | operational |
| `/use-native-credential-proxy` | Switch from OneCLI to the built-in `.env` credential proxy | operational |

## Channels

`/gabai-core:setup` handles these during initial install. To add one later:

| Skill | Description | Source |
|-------|-------------|--------|
| `/add-whatsapp` | Add WhatsApp (QR or pairing-code auth) — required for most WhatsApp-specific skills below | upstream |
| `/gabai-core:install-skill telegram` | Add Telegram (bot token) | marketplace |
| `/gabai-core:install-skill slack` | Add Slack via Socket Mode (no public URL needed) | marketplace |
| `/gabai-core:install-skill discord` | Add Discord (bot token) | marketplace |
| `/gabai-core:install-skill gmail` | Add Gmail as a tool or full channel (OAuth) | marketplace |
| Emacs | Ships on `main` (imported in `src/channels/index.ts`). Self-registers when the local HTTP bridge is running — no separate install step. See `src/channels/emacs.ts`. | built-in |
| `/add-telegram-swarm` | Multi-bot agent swarm on Telegram (requires `/add-telegram` first) | upstream |

## Media & message enhancements

Most require `/add-whatsapp` first. **If you want the unified media pipeline, install `media-ingestion` before any per-media skill.**

| Skill | Description | Source |
|-------|-------------|--------|
| `/gabai-core:install-skill media-ingestion` | Channel-agnostic media pipeline — foundation for pdf / image / voice. Install **first**. | marketplace |
| `/gabai-core:install-skill voice-transcription` | Transcribe voice notes via OpenAI Whisper (requires `OPENAI_API_KEY`) | marketplace |
| `/use-local-whisper` | Switch voice transcription to on-device whisper.cpp (Apple Silicon) | upstream |
| `/add-image-vision` | Process image attachments as multimodal content blocks for Claude | upstream |
| `/add-pdf-reader` | Extract text from PDF attachments via pdftotext | upstream |
| `/gabai-core:install-skill whatsapp-replies` | Quote / reply context on inbound messages; threaded replies via `send_message` | marketplace |
| `/gabai-core:install-skill whatsapp-summary` | Daily / weekly group summary pipeline (per-group + cross-group ranking) | marketplace |
| `/gabai-core:install-skill message-search` | Semantic search over WhatsApp message history via vector embeddings | marketplace |
| `/channel-formatting` | Auto-convert Claude's Markdown output to WhatsApp / Telegram / Slack native syntax | upstream |
| `/add-compact` | Adds `/compact` slash command for manual context compaction in long agent sessions | upstream |

## Integrations & features

| Skill | Description | Source |
|-------|-------------|--------|
| `/gabai-core:install-skill gist` | Agents can create, view, edit, clone, delete, and list GitHub Gists via a CLI that proxies through the host `gh` | marketplace |
| `/gabai-core:install-skill google-home` | Smart-home control via Google Assistant (lights, AC, sensors, scenes, YAML automations). Main-group only. | marketplace |
| `/gabai-core:install-skill perplexity-research` | Perplexity Pro for multi-source research with citations (requires `PERPLEXITY_API_KEY`) | marketplace |
| `/gabai-core:install-skill intercom` | Cross-group messaging: agents can send messages, queries, and directives across groups with trust verification | marketplace |
| `/gabai-core:install-skill feature-request` | Container agent can write feature-request PRDs for the host to review | marketplace |
| `/add-parallel` | Parallel AI MCP for fast web search | upstream |
| `/add-ollama-tool` | Ollama MCP — call local models from the agent | upstream |
| `/add-karpathy-llm-wiki` | Persistent markdown knowledge base (Karpathy LLM Wiki pattern) | upstream |
| `/x-integration` | X (Twitter): post tweets, like, reply, retweet, quote | upstream |

## Developer / contributor workflow

| Skill | Description | Source |
|-------|-------------|--------|
| `/gabai-core:contribute <skill-name>` | Package a custom skill as a linked PR pair (code → `ChabadLabs/GabAI`, catalog → `ChabadLabs/GabAIskills`) | marketplace |
| `/gabai-core:list-skills` | Browse the marketplace catalog | marketplace |
| `/get-qodo-rules` | Fetch org / repo coding rules from Qodo before a code task | upstream |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch | upstream |
| `/claw` | Run NanoClaw agent containers from the CLI | upstream |
| `/add-macos-statusbar` | macOS menu-bar indicator for the nanoclaw service | upstream |

---

## Cross-links & install-order notes

- **Media pipeline:** install `media-ingestion` **before** `voice-transcription` / `add-pdf-reader` / `add-image-vision` if you want the unified pipeline. Without media-ingestion they still work in their legacy per-channel path.
- **Voice transcription alternatives:** pick one — `/gabai-core:install-skill voice-transcription` (OpenAI Whisper, cheapest) or `/use-local-whisper` (on-device, no API cost, Apple Silicon only).
- **Agent swarm:** `/add-telegram-swarm` requires `/add-telegram` first. No equivalent for WhatsApp or Slack yet.
- **Credentials:** Docker → `/init-onecli`; Apple Container → use `/gabai-core:setup` step 4b; switching away from OneCLI → `/use-native-credential-proxy`.
- **Upstream catch-up:** routine → `/gabai-core:update`; heavy divergence → `/migrate-nanoclaw`.
- **Dependencies inside the marketplace:** `reactions` requires `ipc-handler-registry` + `lifecycle-hooks`; `shabbat-mode` requires `reactions` + `group-lifecycle`; `voice-transcription` requires `media-ingestion`. The installer resolves these automatically.
