# Contributing

## Before You Start

1. **Check for existing work.** Search open PRs and issues before starting:
   ```bash
   gh pr list --repo ChabadLabs/GabAI --search "<your feature>"
   gh issue list --repo ChabadLabs/GabAI --search "<your feature>"
   ```
   If a related PR or issue exists, build on it rather than duplicating effort.

2. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one simplification. Don't mix unrelated changes in a single PR.

## Skills

Want to share a skill you've built? Open a PR on this repo with your code on a `skill/<category>-<skill-name>` branch (e.g., `skill/shluchim-essential-birthday-reminders`). Include a description of what it does and any required API keys in the PR description.

A ChabadLabs maintainer will handle adding it to the marketplace after your PR is merged.

### Skill types

NanoClaw uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something.

#### Feature skills (branch-based)

Add capabilities by merging a git branch. The SKILL.md contains setup instructions; the actual code lives on a `skill/*` branch.

**Location:** `.claude/skills/` on `main` (instructions only), code on `skill/*` branch

**How they work:**
1. User runs `/gabai-core:install-skill <name>`
2. The install command fetches and merges the `skill/<name>` branch
3. Claude walks through interactive setup (env vars, etc.)

**Contributing a feature skill:**
1. Fork `ChabadLabs/GabAI` and branch from `main`
2. Make the code changes (new files, modified source, updated `package.json`, etc.)
3. Add a SKILL.md in `.claude/skills/<name>/` with setup instructions — step 1 should be merging the branch
4. Open a PR against `ChabadLabs/GabAI`. We'll create the `skill/<name>` branch from your work

#### Operational skills (instruction-only)

Workflows and guides with no code changes. The SKILL.md is the entire skill.

**Location:** `.claude/skills/` on `main`

**Examples:** `/setup`, `/debug`, `/customize`

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications.

**Not accepted:** Features and enhancements — these should be skills.

## Pull Requests

Open PRs against `ChabadLabs/GabAI`, not the upstream `qwibitai/nanoclaw`.

Keep the description concise:
- **What** — what the PR adds or changes
- **Why** — the motivation
- **How it was tested** — what you did to verify it works

## Upstream

This repo is a maintained fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). ChabadLabs periodically syncs upstream changes. If your contribution is a general nanoclaw improvement (not shluchim-specific), consider opening the PR upstream instead.
