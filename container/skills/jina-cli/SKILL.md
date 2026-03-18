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
