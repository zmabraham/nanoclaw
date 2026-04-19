# Contributing

## Before You Start

1. **Check for existing work.** Search open PRs and issues on both repos before starting:
   ```bash
   gh pr list --repo ChabadLabs/GabAI --search "<your feature>"
   gh issue list --repo ChabadLabs/GabAI --search "<your feature>"
   gh pr list --repo ChabadLabs/GabAIskills --search "<your feature>"
   gh issue list --repo ChabadLabs/GabAIskills --search "<your feature>"
   ```
   If a related PR or issue exists, build on it rather than duplicating effort.

2. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one simplification. Don't mix unrelated changes in a single PR.

## Repo structure

ChabadLabs maintains GabAI across two repos:

- **`ChabadLabs/GabAI`** (this repo) — the NanoClaw fork. Core code, operational skills, and `skill/<name>` branches that contain feature-skill code.
- **`ChabadLabs/GabAIskills`** — the marketplace catalog and installer walkthroughs. Users discover and install feature skills from here via `/gabai-core:install-skill <name>`.

Feature-skill contributions require linked PRs on both repos (see below).

## Access

Both repos are private. Contributors need access to the `ChabadLabs` GitHub organization. Request access at [github.com/ChabadLabs](https://github.com/ChabadLabs). If you believe you already have access but `git fetch` or `gh` commands return 403/404, check you're signed in as the correct GitHub user (`gh auth status`) — multi-account setups often authenticate as the wrong identity.

## Skills

GabAI uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something.

### Skill types

#### Feature skills (branch-based)

Add capabilities by merging a git branch. The code lives on a `skill/<name>` branch in this repo; the installer walkthrough (`SKILL.md`) and catalog entry live in `ChabadLabs/GabAIskills`.

**How they work:**
1. User runs `/gabai-core:install-skill <name>`
2. The install command ensures a `chabadlabs` remote pointing at this repo, fetches `skill/<name>`, and merges it — works regardless of whether the user's `upstream` points at `ChabadLabs/GabAI` or `qwibitai/nanoclaw`
3. Claude walks through interactive setup (env vars, external-service config, etc.)

**Contributing a feature skill:**

Use `/gabai-core:contribute <name>`. The command walks you through:

1. Creating a clean `skill/<name>` branch on your fork of `ChabadLabs/GabAI`, from this repo's `main` (not nested categories — just `skill/<name>`, e.g., `skill/birthday-reminders`)
2. Opening a PR here with the code
3. Opening a companion PR on `ChabadLabs/GabAIskills` with the catalog entry and installer SKILL.md
4. Cross-linking the two PRs

The GabAI PR merges first so the branch lands on `chabadlabs`. The marketplace PR merges second so the catalog entry becomes installable. While the PR is open, rebase your `skill/<name>` branch on this repo's `main` as needed to keep the merge clean:

```bash
git fetch chabadlabs && git rebase chabadlabs/main
```

There's no automation currently merge-forwarding skill branches against `main`, so this is on the contributor.

If you've already built the code but haven't run the command, `/gabai-core:contribute` can still package what you have — point it at the commits that make up the skill and it'll handle the rest.

#### Operational skills (instruction-only)

Workflows and guides with no code changes. The `SKILL.md` is the entire skill.

**Location:** `.claude/skills/<name>/SKILL.md` on `main` (this repo)

**Examples:** `/setup`, `/debug`, `/customize`

To contribute: open a PR that adds the `SKILL.md` directly on `main`.

#### Utility skills (self-contained tools)

SKILL.md plus code files that Claude executes or references as part of the workflow. No branch, no merge — everything ships in one directory.

**Location:** `.claude/skills/<name>/` on `main`, with `SKILL.md` alongside the code files (scripts, config, templates)

**Examples:** `/claw` (ships with its own `scripts/` directory)

To contribute: open a PR that adds the entire `.claude/skills/<name>/` directory. The SKILL.md tells Claude how and when to invoke the code; the code itself lives next to it.

#### Container skills (agent runtime)

Instructions loaded inside the agent container at runtime. These teach the containerized agent (not Claude Code itself) about tools available inside its sandbox.

**Location:** `container/skills/<name>/SKILL.md` on `main`. If the skill wraps a CLI, the dispatcher script typically lives at `/usr/local/bin/<name>` (installed via `container/Dockerfile`) with functions sourced from the skill directory — see existing container skills for the pattern.

**Examples:** `agent-browser`, `capabilities`, `status`, `slack-formatting`

To contribute: open a PR that adds `container/skills/<name>/SKILL.md` (and any dispatcher/Dockerfile changes needed to install the CLI). Container skills are loaded at container spawn time, so changes take effect on the next container start — no host rebuild required.

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

This repo is a maintained fork of [qwibitai/nanoclaw](https://github.com/qwibitai/nanoclaw). ChabadLabs periodically syncs upstream changes. If your contribution is a general nanoclaw improvement (not shluchim-specific), consider opening the PR upstream instead — it will reach ChabadLabs via the sync.
