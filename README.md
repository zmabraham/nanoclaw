# GabAI

A personal Shlichus AI assistant that runs on WhatsApp, powered by [nanoclaw](https://github.com/qwibitai/nanoclaw).

GabAI helps shluchim with scheduling, answering questions, managing WhatsApp groups, voice transcription, and more — all through a conversational WhatsApp interface.

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

## Contributing Skills

Want to share a skill you've built? Open a PR on this repo with your code on a `skill/<category>-<skill-name>` branch (e.g., `skill/shluchim-essential-birthday-reminders`). Include a description of what it does and any required API keys in the PR description.

A ChabadLabs maintainer will handle adding it to the marketplace after your PR is merged.

## Upstream

This repo is a maintained fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). ChabadLabs periodically syncs upstream changes and reviews them before they reach shluchim.
