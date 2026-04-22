# GabAI

A personal Shlichus AI assistant that runs on WhatsApp, powered by [nanoclaw](https://github.com/qwibitai/nanoclaw).

GabAI helps shluchim with scheduling, answering questions, managing WhatsApp groups, voice transcription, and more — all through a conversational WhatsApp interface.

## Why GabAI

A shliach's assistant needs to be trustworthy and bespoke — not a generic chatbot with access to everything, and not a black box you can't adjust. GabAI is built around four ideas:

- **Small enough to understand.** One Node.js process, a handful of source files, no microservices. If anything surprises you, ask Claude Code to walk you through the code.
- **Secure by isolation.** Every group's agent runs in its own Linux container with only explicitly-mounted directories accessible. API keys never enter the container — they're injected at request time by [OneCLI](https://github.com/onecli/onecli).
- **Customization = code changes.** No configuration sprawl. When you want different behavior, you (or Claude Code) modify the code directly. The codebase is small enough that this is safe.
- **Skills over features.** Capabilities are added as [Claude Code skills](https://code.claude.com/docs/en/skills) that merge into your fork — you keep only the code you actually use.

GabAI is a maintained fork of upstream [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw), curated by ChabadLabs for shluchim: audited skills, shluchim-essential defaults (`shabbat-mode`, Hebrew calendar awareness), and a single-command setup flow.

## Getting Started

### 1. Get Access

[Request access](https://github.com/ChabadLabs/.github/issues/new?template=access-request.yml) to the ChabadLabs org if you haven't already.

### 2. Set Up Your Server

Run this on a fresh Linux VM:

```bash
curl -fsSL https://chabadlabs.github.io/.github/setup-vm.sh -o ~/setup-vm.sh && bash ~/setup-vm.sh
```

The installer sets up your server, installs Claude Code, and configures everything you need.

### 3. Launch Your Bot

Open Claude Code and run:

```
/gabai-core:setup
```

This walks you through forking this repo, connecting WhatsApp, choosing skills, and starting your bot.

## Commands

| Command | Description |
|---------|-------------|
| `/gabai-core:setup` | Guided installation of your Shlichus bot |
| `/gabai-core:list-skills` | Browse available skills |
| `/gabai-core:install-skill <name>` | Install a skill into your bot |
| `/gabai-core:update` | Update to latest upstream and rebuild |
| `/gabai-core:contribute <skill-name>` | Package your own skill as a marketplace PR |

For the full skill catalog see [docs/SKILLS.md](docs/SKILLS.md).

## Migrating From ChatGPT or Claude.ai

If you've been using ChatGPT or Claude.ai, those tools have learned a lot about your community, writing style, and priorities. See [docs/onboarding/migrate-from-chatgpt.md](docs/onboarding/migrate-from-chatgpt.md) for how to export that context and bring it into your GabAI.

## Contributing

GabAI uses a two-repo model curated for shluchim — different from both upstream nanoclaw (single repo, anyone merges) and jonazri/gabay (single repo, individual-user focused). Skill code lands here on `ChabadLabs/GabAI`; the marketplace catalog lives in `ChabadLabs/GabAIskills`. Feature skills require linked PRs on both.

**The fastest path:** run `/gabai-core:contribute <skill-name>` inside Claude Code. It walks you through packaging your skill, opens both PRs, and cross-links them.

See [CONTRIBUTING.md](CONTRIBUTING.md) for full details on skill types, PR requirements, and what kinds of changes are accepted.

## Upstream

This repo is a maintained fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). ChabadLabs periodically syncs upstream changes and reviews them before they reach shluchim.
