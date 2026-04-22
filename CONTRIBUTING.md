# Contributing

## How GabAI differs — and why it matters for where your PR goes

GabAI has a contribution model that's different from both upstream nanoclaw and other community forks:

| | **Upstream nanoclaw** | **Community forks** (e.g. `jonazri/gabay`) | **GabAI (ChabadLabs)** |
|---|---|---|---|
| Skills live | `.claude/skills/` on `main` + `skill/*` branches | `.claude/skills/` on `main` + `skill/*` branches | `skill/*` branches on `ChabadLabs/GabAI` + catalog on `ChabadLabs/GabAIskills` |
| Discovery | `/list-skills`, manual skill merge | `/list-skills`, manual skill merge | `/gabai-core:list-skills` + curated marketplace |
| Install | `git fetch upstream skill/x && git merge` | Fork-specific | `/gabai-core:install-skill x` handles remote + fetch + merge + env setup |
| Who merges | Upstream maintainers | Fork owner | ChabadLabs maintainers, with extra audit for shluchim-safe defaults |
| Target audience | General | Individual power users | Shluchim running a single WhatsApp assistant |

**Practical consequence for contributors:** a feature-skill contribution to GabAI is **two linked PRs** (one per repo), not one. The `/gabai-core:contribute` slash command below handles the mechanics automatically; the rest of this document explains the *why*.

## Before You Start

1. **Check for existing work.** Search open PRs and issues on both repos before starting:
   ```bash
   gh pr list --repo ChabadLabs/GabAI --search "<your feature>"
   gh issue list --repo ChabadLabs/GabAI --search "<your feature>"
   gh pr list --repo ChabadLabs/GabAIskills --search "<your feature>"
   gh issue list --repo ChabadLabs/GabAIskills --search "<your feature>"
   ```
   If a related PR or issue exists, build on it rather than duplicating effort.

2. **Check alignment.** Read the [Why GabAI](README.md#why-gabai) section. Source-code changes should be things most shluchim need (bug fixes, security fixes, simplifications). Skills can be more specific but should still be broadly useful — not for a single user's setup.

3. **One thing per PR.** Each PR should do one thing — one bug fix, one skill, one simplification. Don't mix unrelated changes.

4. **Never PR skills or customizations to upstream.** Upstream is `qwibitai/nanoclaw`; our skill branches and fork-specific code live only on `ChabadLabs/GabAI`. Only generic bug fixes or security fixes to upstream-owned files should ever be PR'd to upstream.

## Repo structure

ChabadLabs maintains GabAI across two repos:

- **`ChabadLabs/GabAI`** (this repo) — the NanoClaw fork. Core code, operational skills, and `skill/<name>` branches that contain feature-skill code.
- **`ChabadLabs/GabAIskills`** — the marketplace catalog and installer walkthroughs. Users discover and install feature skills from here via `/gabai-core:install-skill <name>`.

**Feature-skill contributions require linked PRs on both repos.** One repo holds the code; the other holds the catalog entry that makes the code installable. Neither is useful without the other.

## Access

Both repos are private. Contributors need access to the `ChabadLabs` GitHub organization. Request access at [github.com/ChabadLabs](https://github.com/ChabadLabs). If you believe you already have access but `git fetch` or `gh` commands return 403/404, check you're signed in as the correct GitHub user (`gh auth status`) — multi-account setups often authenticate as the wrong identity.

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, reducing code.

**Not accepted:** New features, capabilities, or enhancements. Those should be skills. Keeping the base system minimal is the point.

Open the PR against `ChabadLabs/GabAI`, not upstream. If your change is a general nanoclaw improvement (not shluchim-specific), consider opening the PR upstream at `qwibitai/nanoclaw` — it will reach ChabadLabs via the sync, and it benefits every fork.

## Skills

GabAI uses [Claude Code skills](https://code.claude.com/docs/en/skills) — markdown files with optional supporting files that teach Claude how to do something. There are four skill types.

### Skill types

#### 1. Feature skills (branch-based) — the usual path

Add capabilities to GabAI by merging a git branch. Code lives on a `skill/<name>` branch in `ChabadLabs/GabAI`; the installer walkthrough (`SKILL.md`) and catalog entry live in `ChabadLabs/GabAIskills`.

**How they work at install time:**
1. User runs `/gabai-core:install-skill <name>`
2. The install command ensures a `chabadlabs` remote pointing at `ChabadLabs/GabAI`, fetches `skill/<name>`, and merges it — works regardless of whether the user's `upstream` points at `ChabadLabs/GabAI` or `qwibitai/nanoclaw`
3. Claude walks through any interactive setup (env vars, external-service config, etc.)

**How to contribute one:**

Use `/gabai-core:contribute <name>` inside Claude Code. The command:

1. Validates your skill metadata and checks for name collisions in the marketplace
2. Creates a clean `skill/<name>` branch on your fork of `ChabadLabs/GabAI`, from current `main` (not nested categories — just `skill/<name>`, e.g., `skill/birthday-reminders`)
3. Adds a `skill-metadata.json` describing tier, dependencies, and category
4. Opens a PR here on `ChabadLabs/GabAI` with the code
5. Opens a companion PR on `ChabadLabs/GabAIskills` with the catalog entry + installer `SKILL.md`
6. Cross-links the two PRs

**Merge order** (maintainers handle this; noted here so you understand dependencies): the GabAI PR merges first so the `skill/<name>` branch lands. The GabAIskills PR merges second so the catalog entry is installable by users.

**While your PR is open**, rebase your `skill/<name>` branch on `ChabadLabs/GabAI/main` as main advances:
```bash
git fetch chabadlabs && git rebase chabadlabs/main
```
There's no automation currently merge-forwarding skill branches against `main`, so it's on the contributor to keep the merge clean.

If you've already built the code but haven't run the command, `/gabai-core:contribute` can still package what you have — point it at the commits that make up the skill and it'll handle the rest.

#### 2. Operational skills (instruction-only)

Workflows and guides with no code changes. The `SKILL.md` is the entire skill — no branch, no code files.

**Location:** `.claude/skills/<name>/SKILL.md` on `main` of this repo.

**Examples:** `/setup`, `/debug`, `/customize`

**How to contribute:** open a PR that adds the `SKILL.md` directly on `main`. No marketplace PR needed unless you want it discoverable in `/gabai-core:list-skills`.

#### 3. Utility skills (self-contained tools)

`SKILL.md` plus code files that Claude executes or references as part of the workflow. Everything ships in one directory — no branch merge.

**Location:** `.claude/skills/<name>/` on `main`, with `SKILL.md` alongside the code files (scripts, config, templates).

**Examples:** `/claw` (ships with its own `scripts/` directory)

**How to contribute:** open a PR that adds the entire `.claude/skills/<name>/` directory. The `SKILL.md` tells Claude how and when to invoke the code; the code itself lives next to it.

#### 4. Container skills (agent runtime)

Instructions loaded inside the agent container at runtime. These teach the containerized agent (not Claude Code itself) about tools available inside its sandbox.

**Location:** `container/skills/<name>/SKILL.md` on `main`. If the skill wraps a CLI, the dispatcher script typically lives at `/usr/local/bin/<name>` (installed via `container/Dockerfile`) with functions sourced from the skill directory — see existing container skills for the pattern.

**Examples:** `agent-browser`, `capabilities`, `status`, `slack-formatting`

**How to contribute:** open a PR that adds `container/skills/<name>/SKILL.md` (and any dispatcher/Dockerfile changes needed to install the CLI). Container skills are loaded at container spawn time, so changes take effect on the next container start — no host rebuild required.

### SKILL.md format

All skills use the [Claude Code skills standard](https://code.claude.com/docs/en/skills):

```markdown
---
name: my-skill
description: What this skill does and when to use it.
---

Instructions here...
```

**Rules:**
- Keep `SKILL.md` **under 500 lines** — move detail to separate reference files
- `name`: lowercase, alphanumeric + hyphens, max 64 chars
- `description`: required — Claude uses this to decide when to invoke the skill
- Put code in separate files, not inline in the markdown

## Pull Requests

### Before opening

1. **Link related issues.** If your PR resolves an open issue, include `Closes #123` so it's auto-closed on merge.
2. **Test thoroughly.** Run the feature yourself. For skills, test on a fresh clone.

### PR description

Keep it concise. The description should cover:
- **What** — what the PR adds or changes
- **Why** — the motivation
- **How it works** — brief explanation of the approach (for skills especially)
- **How it was tested** — what you did to verify it works
- **Usage** — how the user invokes it (for skills)

Don't pad the description. A few clear sentences are better than lengthy paragraphs.

## See Also

- [README.md](README.md) — user-facing overview and philosophy
- [CLAUDE.md](CLAUDE.md) — repo-level agent context and file index
- [docs/SKILLS.md](docs/SKILLS.md) — full skill catalog
- [docs/SPEC.md](docs/SPEC.md) — architecture reference
