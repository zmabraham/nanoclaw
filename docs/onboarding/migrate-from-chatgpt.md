# Migrating from ChatGPT or Claude.ai to GabAI

A guide for shluchim moving context, preferences, and writing history from consumer AI tools into their GabAI agent.

## Why bother

If you've been using ChatGPT or Claude.ai for months or years, those tools have learned a lot about you — your writing style, your community and donors, your recurring priorities, the way you like things worded. That context lives inside those platforms and doesn't automatically come along. This guide shows you how to export it and make it available to your GabAI.

You don't need all of it. 20 minutes of copy-paste gets you 80% of the value.

---

## Part 1: Exporting from ChatGPT

### Chat history + memories

1. Sign into ChatGPT at chat.openai.com
2. Click your profile icon (bottom left) → **Settings**
3. Go to **Data Controls** → **Export Data** → **Export**
4. Confirm the export
5. Check your email (from `noreply@openai.com`) — the download link expires in 24 hours
6. Download the ZIP

**What you get:**
- `conversations.json` — full chat history
- Account metadata, preferences, interaction patterns
- Memory data is integrated into the export (not a separate file)

**Limitations:**
- Export takes up to 7 days to process
- No way to export just "memories" separately
- ChatGPT's aggregated memory / profile is only partially visible

### Artifacts / Canvas documents

- Open the canvas / artifact in ChatGPT
- Click the download icon or copy-paste the content
- No bulk export for artifacts — manual, one at a time

---

## Part 2: Exporting from Claude.ai

### Conversation history + projects + artifacts

1. Go to claude.ai → profile icon → **Settings**
2. **Privacy** → **Export Data**
3. Choose time range (last 30 / 90 days or custom)
4. Confirm → check your email for the download link (expires in 24h)
5. Download the ZIP

**What you get:**
- Full conversation history as JSON
- Project conversations
- Artifacts / documents, downloadable in their native format (MD, CSV, XLSX, etc.)
- Memory data (if you have the memory feature enabled)

**Export formats available:**
- JSON (best for programmatic use)
- Markdown (good for reading / importing into Obsidian, Notion)
- PDF, TXT, CSV, PNG

**Best format for GabAI:** JSON — it's the most structured and easiest to parse.

---

## Part 3: What to bring over

Priority order for what's worth importing:

| What | Value | How to extract |
|------|-------|----------------|
| Writing-style samples | High | 10–20 drafts you're proud of from your chat history |
| Community / donor context | High | Conversations where you described your kehilla, key donors, recurring programs |
| Preferences and pet peeves | High | Any "always do X" or "never do Y" instructions you gave |
| Project templates | Medium | Recurring documents (grant proposals, newsletters, appeals) |
| Full chat history | Low-Medium | Too noisy to use raw — needs summarization first |

---

## Part 4: Getting context into your GabAI

There are three approaches, in increasing order of complexity.

### Approach 1 — Paste into `/customize` (recommended first step)

The fastest option. After exporting:

1. Open your JSON export and pick out the most useful conversations
2. Copy the key context — donor names, community description, your writing preferences, recurring tasks
3. In your main GabAI chat, run `/customize` and paste the context as a "background knowledge" block

This works cleanly for up to ~10,000 words of context. Your agent will reference the saved CLAUDE.md on every invocation, so the context is always in scope.

### Approach 2 — Write a persistent context file directly

For medium-sized context (10,000–50,000 words), ask your agent to write the context to a dedicated file in the group's workspace. The container mounts the group's host directory (`groups/<group>/` on the host) at `/workspace/group/` inside the container, so you can phrase it either way:

```
@YourBot I'm pasting context from my ChatGPT export. Save this to my-context.md
in the group workspace (that's /workspace/group/my-context.md inside the container,
or groups/<this-group>/my-context.md on the host) and add a reference to it from
the group's CLAUDE.md so you always load it.

[paste content]
```

Claude Code will create the file and wire up the reference. The file lives in your group's isolated workspace, so it's not shared across groups.

### Approach 3 — Build an import skill

For larger exports (full years of history) or if you want the workflow reusable for other shluchim, build a skill:

1. **Ingests** the export ZIP
2. **Parses** the JSON to extract meaningful content
3. **Summarizes** using Claude (filter out noise, keep signal)
4. **Writes** the summary to a persistent file in the group's workspace
5. **References** the file from the group's `CLAUDE.md`

Skill structure (rough):

```bash
#!/bin/bash
# install-ai-history skill
# Usage: /install-ai-history <path-to-export.zip>

# 1. Unzip the export
unzip "$1" -d /tmp/ai-export/

# 2. Parse conversations.json — extract meaningful exchanges
node --input-type=module << 'EOF'
import fs from 'fs';
const data = JSON.parse(fs.readFileSync('/tmp/ai-export/conversations.json'));
// Extract conversations where user described their context
// Filter for length, recency, relevance
// Output cleaned markdown
EOF

# 3. Summarize with Claude
# 4. Write to /workspace/group/imported-context.md (which is groups/<group>/imported-context.md
#    on the host) and add a reference to it from the group's CLAUDE.md
```

---

## Part 5: Contributing an import skill back

If you build an import skill and it works well, package it for other shluchim:

```
/gabai-core:contribute ai-history-import
```

The slash command walks you through creating a clean `skill/ai-history-import` branch on `ChabadLabs/GabAI`, adding the matching installer walkthrough + catalog entry in `ChabadLabs/GabAIskills`, and opening both PRs cross-linked. Other shluchim can then run `/gabai-core:install-skill ai-history-import`.

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for full contribution details.

---

## Recommended first steps (right now, no coding required)

1. **Export your data** from ChatGPT and / or Claude.ai today — the downloads take hours to generate
2. **Read through your conversations** and pull out 1–2 pages of context about yourself, your community, and your work style
3. **Paste that into your GabAI** via `/customize` — or just tell your agent directly: "Here's background about me and my shlichus: [paste]"
4. **Ask your agent to save it** so it persists across sessions

That alone will get you 80% of the value. The full import skill is the remaining 20%.
