# Jina CLI Skill for Mashbak

**Date:** 2026-03-18
**Status:** Draft
**Scope:** Main group only (Mashbak)

## Summary

Add a container skill that gives Mashbak access to the `jina` CLI for web search and content extraction. Mashbak will use `jina search QUERY` as his default search method instead of web browsing.

## Background

[jina-cli](https://github.com/jina-ai/cli) is a Unix-style CLI that wraps Jina AI's APIs. It provides:
- `jina search QUERY` — Web search (also `--arxiv`, `--images`, `--blog`)
- `jina read URL` — Extract clean markdown from web pages
- `jina rerank QUERY` — Rerank documents by relevance
- `jina embed TEXT` — Generate embeddings
- `jina screenshot URL` — Capture screenshots
- `jina pdf URL` — Extract figures/tables from PDFs

The CLI is designed for AI agents — one `run(command="jina search ...")` replaces a sprawling tool catalog.

## Requirements

1. Install `jina-cli` in the agent container
2. Provide the `JINA_API_KEY` to the container environment
3. Create a container skill with usage instructions
4. Make the skill available to the main group only (Mashbak)
5. Instruct Mashbak to prefer `jina search` over browser-based web search

## Design

### 1. Container Skill

**Path:** `container/skills/jina-cli/SKILL.md`

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

### 2. Dockerfile Changes

**File:** `container/Dockerfile`

Add Python/pip and install jina-cli:

```dockerfile
# Install Python and jina-cli for web search
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    && pip3 install --break-system-packages jina-cli \
    && rm -rf /var/lib/apt/lists/*

# Set Jina API key for search functionality
ENV JINA_API_KEY=jina_3982838bd63749a9b76257d3450f3af2Os2aCtQ0Sd4pxRN3awSRz7S4A9Zz
```

Insert after the Chromium dependencies section (line 27).

### 3. Main-Only Skill Support

**File:** `src/container-runner.ts`

Modify the skill syncing logic (around line 149-159) to respect a `mainOnly` frontmatter field:

```typescript
// Sync skills from container/skills/ into each group's .claude/skills/
const skillsSrc = path.join(process.cwd(), 'container', 'skills');
const skillsDst = path.join(groupSessionsDir, 'skills');
if (fs.existsSync(skillsSrc)) {
  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;

    // Check for mainOnly frontmatter
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

## Files Changed

| File | Change |
|------|--------|
| `container/skills/jina-cli/SKILL.md` | New file — skill documentation |
| `container/Dockerfile` | Add Python/pip, install jina-cli, set API key |
| `src/container-runner.ts` | Add `mainOnly` frontmatter support |

## Verification

1. Rebuild container: `./container/build.sh`
2. Restart NanoClaw
3. In main group, ask Mashbak to search for something
4. Verify he uses `jina search` instead of browser automation
5. In a non-main group, verify the skill is not available

## Security Notes

- The API key is baked into the container image (acceptable for personal use)
- For multi-user deployments, consider passing the key via credential proxy instead
