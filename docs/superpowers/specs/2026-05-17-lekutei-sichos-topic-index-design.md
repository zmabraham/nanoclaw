# Lekutei Sichos Comprehensive Topic Index — Design Spec

## Problem

The existing Lekutei Sichos wiki at `groups/whatsapp_main/likkutei-sichos-wiki/` organizes ~1,191 sichos across 39 volumes by parsha and volume. It has a `concept_manifest.json` with ~47 concepts, but these are not extracted from the actual source texts — they're manually identified. There is no deep, concept-based navigation that lets a reader find every sicha that discusses a given theme and understand how each sicha develops that idea.

## Solution

AI-driven concept extraction from all 39 volumes of raw source text, followed by reconciliation into a unified concept taxonomy, and generation of markdown wiki pages integrated into the existing Quartz wiki.

## Architecture

Three sequential phases:

1. **Extraction** — Split each volume into individual sichos, send each to an LLM, get structured concept + summary output
2. **Reconciliation** — Cluster raw concepts into a canonical taxonomy, re-map sichos to canonical IDs
3. **Wiki Generation** — Produce markdown concept pages, concept index, and navigation updates

## Phase 1: Extraction

### Input

- Raw text files: `groups/whatsapp_main/likkutei-sichos/likkutei_sichos_vol01.txt` through `vol39.txt`
- Language: Yiddish with Hebrew quotes, Rashi, Tanya, and other source citations

### Sicha Splitting

Each volume file is parsed into individual sicha segments using:
- Parsha headers as primary delimiters
- Letter markers (א, ב, ג...) as sub-delimiters within a parsha
- Each segment tagged with volume number, parsha name, and sicha letter

### Extraction Prompt Strategy

For each sicha, the LLM receives the full text and is asked to:
- Identify 3-10 core concepts/themes (Hebrew name + English translation)
- For each concept: write 2-4 sentences summarizing how this sicha develops the idea, its distinctive angle, and contribution
- Identify central Torah verses, Mishnah/Gemara passages, Tanya chapters, or other sources

### Output Format (per sicha)

```json
{
  "volume": 1,
  "parsha": "בראשית",
  "sicha_letter": "א",
  "concepts": [
    {
      "hebrew": "ביטול",
      "english": "Self-nullification",
      "summary": "The sicha explores bittul as...",
      "sources": ["Tanya ch. 46", "Genesis 1:1"]
    }
  ]
}
```

### Processing

- Sichos processed in parallel (~30 concurrent API calls)
- Progress logged per volume/sicha
- Failed extractions retried once, then logged for manual review
- Intermediate results saved incrementally (not all-or-nothing)
- Estimated time: several hours for all 39 volumes
- Estimated cost: $30-80 depending on model choice

### Intermediate Storage

Extracted data saved per-volume as JSON:
- `groups/whatsapp_main/likkutei-sichos/extracted/vol01.json` through `vol39.json`

## Phase 2: Reconciliation

### Collect

Gather all `(hebrew, english)` concept pairs from all 1,191 extractions. Expect ~2,000-5,000 raw entries.

### Cluster

Use an LLM to group concepts referring to the same idea:
- Exact Hebrew matches
- Translation pairs (Hebrew = English)
- Near-synonyms (גאולה / redemption / coming of Moshiach)
- Hierarchical relationships (אהבת ישראל is a form of אהבה)

### Build Canonical Taxonomy

For each cluster:
- Pick canonical Hebrew name and English translation
- Write a short description of the concept
- Assign category: Kabbalah, Avodah, Mitzvos, Jewish Thought, Geulah, Chassidic History, etc.
- Note broader/narrower relationships to other concepts

Expected output: ~100-200 canonical concepts.

### Re-map

Replace each sicha's raw concept references with canonical concept IDs. Output a unified mapping:
- `groups/whatsapp_main/likkutei-sichos/extracted/concept_taxonomy.json`
- `groups/whatsapp_main/likkutei-sichos/extracted/sicha_concepts.json` (all sichos → canonical concepts)

## Phase 3: Wiki Generation

### Location

All new pages under: `groups/whatsapp_main/likkutei-sichos-wiki/content/concepts/`

### Page Type 1: Individual Concept Pages (`concepts/<slug>.md`)

```markdown
---
title: ביטול / Self-Nullification
tags:
  - concept
  - avodah
---

# ביטול — Self-Nullification

**Category:** Avodah (Divine Service)
**Related concepts:** [[bittul-briyah]], [[hisbonenus]], [[kabbalat-ol]]

## Overview
Brief description of what bittul means in Chassidus...

## In Lekutei Sichos

### Vol. 1, בראשית א
Summary of how this sicha develops bittul...

### Vol. 3, לך לך ב
Summary of how this sicha develops bittul...

[... all sichos discussing this concept ...]

## Sources Referenced
- Tanya, Chapter 46
- Torah Or, בראשית י״ג ע״א
```

### Page Type 2: Concept Index (`concepts/index.md`)

Master browsable index grouped by category:
- Kabbalah & Sefirot
- Avodah (Divine Service)
- Mitzvos & Halacha
- Jewish Thought & Philosophy
- Geulah & Moshiach
- Chassidic Personalities & History

Each entry links to its concept page and shows a count of sichos.

### Page Type 3: Updated Main Index

Update `content/index.md` to add a "Browse by Concept" section with a link to the concept index.

### Page Type 4: Sicha Page Updates

Add concept tags to existing sicha pages in `content/sichos/` — a section at the top listing extracted concepts as links to their concept pages.

## Dependencies

- LLM API access (Claude or Gemini) for extraction and reconciliation
- Existing Quartz wiki structure and build pipeline
- Raw source text files (39 volumes)

## Risks

- **API cost:** 1,191 sichos × full-text extraction is expensive. Mitigated by incremental saves and the ability to pause/resume.
- **Concept quality:** LLM may miss implicit concepts or produce inconsistent names. Mitigated by the reconciliation pass.
- **Yiddish processing:** Some models handle Yiddish better than others. Will need to validate output quality on early volumes.
- **Wiki build:** Large number of new pages (~100-200 concept pages) may slow Quartz build. Should test.

## Success Criteria

- Every sicha has at least 3 concepts extracted
- Concept taxonomy covers the major themes of Lekutei Sichos (100+ canonical concepts)
- Each concept page links to all sichos that discuss it with meaningful summaries
- The concept index is browsable by category
- The wiki builds successfully with all new pages
