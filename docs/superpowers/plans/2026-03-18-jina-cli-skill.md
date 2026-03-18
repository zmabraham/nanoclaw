# Jina CLI Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add jina-cli search capability to Mashbak (main group only) as his default search method.

**Architecture:** Container skill with `mainOnly: true` frontmatter, jina-cli installed in container image, API key passed via environment variable at runtime.

**Tech Stack:** Python/pip (for jina-cli), TypeScript (container-runner), Docker

**Spec:** `docs/superpowers/specs/2026-03-18-jina-cli-skill-design.md`

---

## Files Changed

| File | Action | Purpose |
|------|--------|---------|
| `container/skills/jina-cli/SKILL.md` | Create | Skill documentation with usage instructions |
| `container/Dockerfile` | Modify | Install Python/pip and jina-cli |
| `src/container-runner.ts` | Modify | Add `mainOnly` support + JINA_API_KEY passthrough |
| `.env` | Modify | Add JINA_API_KEY (user action, not committed) |

---

### Task 1: Create Jina CLI Container Skill

**Files:**
- Create: `container/skills/jina-cli/SKILL.md`

- [ ] **Step 1: Create the skill directory and file**

```bash
mkdir -p container/skills/jina-cli
```

- [ ] **Step 2: Write the skill documentation**

Create `container/skills/jina-cli/SKILL.md`:

```markdown
---
name: jina-cli
description: Search the web, read pages, rerank results, and extract content using the jina CLI. Use `jina search QUERY` as your default search method instead of opening a browser.
allowed-tools: Bash(jina*)
mainOnly: true
---

# Jina CLI

Use the `jina` command for web search and content extraction. Prefer this over browser automation for search tasks.

## Quick start

```bash
jina search "transformer architecture"     # Web search
jina search --arxiv "attention mechanism"  # arXiv search
jina read https://arxiv.org/abs/2301.12345 # Extract page content
```

## Commands

### Search

```bash
jina search "what is BERT"
jina search --arxiv "attention mechanism" -n 10
jina search --images "neural network diagram"
jina search "AI news" --time d          # past day
```

### Read web pages

```bash
jina read https://example.com
jina read https://example.com --links --images
echo "https://example.com" | jina read   # Pipe support
```

### Rerank results

```bash
jina search "AI" | jina rerank "embeddings" --top-n 5
cat docs.txt | jina rerank "machine learning"
```

### PDF extraction

```bash
jina pdf https://arxiv.org/pdf/2301.12345
jina pdf 2301.12345                        # arXiv ID shorthand
```

### Screenshot

```bash
jina screenshot https://example.com -o page.png
```

## Piping

Commands compose via pipes:

```bash
# Search and rerank
jina search "transformer models" | jina rerank "efficient inference"

# Search, deduplicate
jina search "attention mechanism" | jina dedup
```

## JSON output

Add `--json` for structured output:

```bash
jina search "BERT" --json | jq '.results[0].url'
```

## When to use

- **Use `jina search`** for: finding information, research, answering questions
- **Use `jina read`** for: extracting content from a specific URL
- **Use `jina rerank`** for: filtering many results by relevance
- **Use browser automation** for: interactive sites, forms, authentication
```

- [ ] **Step 3: Commit the skill file**

```bash
git add container/skills/jina-cli/SKILL.md
git commit -m "feat: add jina-cli container skill for web search

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Update Dockerfile to Install jina-cli

**Files:**
- Modify: `container/Dockerfile`

- [ ] **Step 1: Add Python and jina-cli installation**

Insert after line 27 (after the `rm -rf /var/lib/apt/lists/*` of the Chromium deps section):

```dockerfile
# Install Python and jina-cli for web search
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && pip3 install --break-system-packages jina-cli \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: Commit the Dockerfile change**

```bash
git add container/Dockerfile
git commit -m "feat: install jina-cli in container for web search

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: Add mainOnly Frontmatter Support

**Files:**
- Modify: `src/container-runner.ts` (lines 149-159)

- [ ] **Step 1: Modify the skill sync logic to respect mainOnly**

Replace lines 149-159 in `src/container-runner.ts`:

**Before:**
```typescript
  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
```

**After:**
```typescript
  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;

      // Check for mainOnly frontmatter - skip main-only skills for non-main groups
      const skillFile = path.join(srcDir, 'SKILL.md');
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, 'utf8');
        const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (frontmatterMatch) {
          const frontmatter = frontmatterMatch[1];
          if (frontmatter.includes('mainOnly: true') && !isMain) {
            continue; // Skip main-only skills for non-main groups
          }
        }
      }

      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
```

- [ ] **Step 2: Build and verify TypeScript compiles**

```bash
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit the mainOnly support**

```bash
git add src/container-runner.ts
git commit -m "feat: add mainOnly frontmatter support for container skills

Skills with mainOnly: true in frontmatter are only synced to the main group.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: Add JINA_API_KEY Environment Passthrough

**Files:**
- Modify: `src/container-runner.ts` (buildContainerArgs function, after line 255)

- [ ] **Step 1: Add JINA_API_KEY passthrough**

Insert after line 255 (after the ANTHROPIC_DEFAULT_OPUS_MODEL line):

```typescript
  // Pass Jina API key for search functionality (main group only uses this)
  if (process.env.JINA_API_KEY) {
    args.push('-e', `JINA_API_KEY=${process.env.JINA_API_KEY}`);
  }
```

- [ ] **Step 2: Build and verify TypeScript compiles**

```bash
npm run build
```

Expected: No errors

- [ ] **Step 3: Commit the API key passthrough**

```bash
git add src/container-runner.ts
git commit -m "feat: pass JINA_API_KEY to container for jina-cli search

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: Rebuild Container and Verify

**Files:**
- Modify: `.env` (user action)

- [ ] **Step 1: Add JINA_API_KEY to .env**

User must add to `.env` (not committed):
```
JINA_API_KEY=your_jina_api_key_here
```

Get your key at https://jina.ai/?sui=apikey

- [ ] **Step 2: Rebuild container image**

```bash
./container/build.sh
```

Expected: Build succeeds with jina-cli installed

- [ ] **Step 3: Restart NanoClaw**

```bash
# Linux:
systemctl --user restart nanoclaw
```

- [ ] **Step 4: Verify in main group**

Send a message to Mashbak asking him to search for something. He should use `jina search` instead of browser automation.

---

## Verification Checklist

- [ ] Container skill created at `container/skills/jina-cli/SKILL.md`
- [ ] Dockerfile updated with Python/pip and jina-cli
- [ ] `mainOnly` frontmatter support works (skill only appears in main group)
- [ ] `JINA_API_KEY` passed to container at runtime
- [ ] Container rebuilds successfully
- [ ] Mashbak can use `jina search` in main group
