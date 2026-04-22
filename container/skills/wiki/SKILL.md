---
name: wiki
description: Maintain and query the research wiki. Trigger on mentions of "wiki", when processing sources, or when the user asks research questions that should be grounded in accumulated knowledge.
allowed-tools: Bash(find:*), Bash(grep:*), Bash(cat:*), Bash(wc:*), Bash(mkdir:*), Bash(curl:*), Bash(ls:*), Bash(mv:*), Bash(cp:*), Bash(rm:*), Bash(head:*), Bash(tail:*)
---

# Research Wiki Skill

You maintain a persistent research wiki in `/workspace/group/wiki/`. The wiki sits between raw sources and the user — knowledge compiles once and stays current rather than re-deriving on every query.

## Architecture

Three layers:

1. **Sources** (`/workspace/group/sources/`) — Immutable raw documents (PDFs, markdown, images, downloaded web pages). Never modify these.
2. **Wiki** (`/workspace/group/wiki/`) — LLM-owned markdown pages organized into subdirectories. You create and update everything here.
3. **Schema** — This file + the wiki section in CLAUDE.md. Tells you how to maintain the wiki.

## Directory Structure

```
sources/              # Raw ingested documents (immutable)
wiki/
  index.md            # Catalog of all pages — update on every ingest
  log.md              # Append-only chronological activity log
  summaries/          # Source summaries (one per source)
  entities/           # Named entities (people, orgs, projects, tools)
  concepts/           # Key ideas, frameworks, methods
  syntheses/          # Cross-source analyses and comparisons
  explorations/       # Question-driven deep dives
```

## Operations

### Ingest

When the user provides a source (file, URL, image, text):

1. **Save the source** to `sources/` if it's a new file. For URLs, download full content:
   ```bash
   curl -sLo sources/filename.pdf "<url>"
   ```
   For web pages where full text matters, use `agent-browser` or `curl` to get complete content — not `WebFetch` (which returns summaries).

2. **Read the source** carefully. Discuss key takeaways with the user.

3. **Create/update wiki pages**:
   - Create a summary page in `summaries/` (slug-based filename, e.g., `summaries/attention-is-all-you-need.md`)
   - Update or create entity pages in `entities/` for every named entity (people, orgs, tools, projects)
   - Update or create concept pages in `concepts/` for key ideas, frameworks, methods
   - Create synthesis pages in `syntheses/` if this source connects to or contradicts existing knowledge
   - Update `wiki/index.md` — add entries under the correct category
   - Append to `wiki/log.md` — `## [YYYY-MM-DD] ingest | Source Title`

4. **Cross-reference**: Every new page should link to related pages using `[[page-slug]]` wiki-links. When creating a new page, check `wiki/index.md` for existing related content and add backlinks.

**Critical ingest discipline**: Process one source at a time. Read it, discuss it, create/update ALL related wiki pages (summary, entities, concepts, cross-references, index, log), and completely finish before moving to the next source. Never batch-read sources and process them together — this produces shallow pages.

### Query

When the user asks a question:

1. **Read `wiki/index.md`** first to locate relevant pages
2. **Search wiki pages** using grep/find to find all relevant content
3. **Synthesize an answer** with citations (`[[page-slug]]` links)
4. **If the answer is substantial**, offer to file it as a new exploration page in `explorations/` — good answers should compound into the knowledge base, not disappear into chat history
5. **Append to log**: `## [YYYY-MM-DD] query | Brief question summary`

### Lint

Periodic health check of the wiki:

1. **Contradictions**: Find pages making conflicting claims across sources
2. **Orphan pages**: Pages with no inbound links from other wiki pages
3. **Missing cross-references**: Pages that should link to each other but don't
4. **Stale content**: Pages whose source info has been superseded by newer sources
5. **Gaps**: Important concepts that lack dedicated pages, entities without full context
6. **Index freshness**: Verify `index.md` accurately reflects current pages
7. **Log consistency**: Check that log entries correspond to actual wiki changes

After lint, report findings and offer to fix issues. Append to log: `## [YYYY-MM-DD] lint | Summary of findings`

## Page Format

Each wiki page should have:

```markdown
# Page Title

> Brief one-line description

## Summary
<!-- Core content -->

## Key Points
<!-- Bullet points for quick scanning -->

## Connections
<!-- Links to related wiki pages: [[other-page]] -->

## Sources
<!-- References to source documents -->
```

## Searching the Wiki

Quick searches from bash:
- `grep -r "topic" wiki/` — full-text search across all pages
- `grep "^- " wiki/index.md` — list all indexed pages
- `grep "^## \[" wiki/log.md | tail -10` — recent activity
- `find wiki/ -name "*.md" | wc -l` — total page count
