# Sefer Ha'erchim — Hemshech Teerav Pipeline Design

## Summary

Build a fully automated Python pipeline that processes Hemshech Teerav (המשך תער"ב) into structured encyclopedia entries following the Sefer Ha'erchim Chabad methodology. The pipeline reads the full Hebrew text, searches for concept occurrences, classifies passages, clusters them into thematic sections, detects contradictions, and outputs validated JSON entries.

## Source Material

- **Corpus**: Larger scrape file (`המשך_תער״ב_—_Hemshech_Tav-Resh-Ayin-Beis.txt`, 13,184 lines, 5.5MB) from `/home/chassidusaicon/code/nanoclaw/groups/whatsapp_main/chabad-library-clean-books/`
- **Structure**: Three volumes (חלק ראשון/שני/שלישי) covering תער"ב through עתר"ו, with 826 chapter-level markers
- **Spec doc**: Google Doc at `1bQqNQebK5kiq1P3csfwGoPfBH4GxnPnb2b5T0EV24Ec` (full processing specification)

## Directory Structure

```
~/code/haerchim-teerav/
├── corpus/
│   ├── vol1.txt          # חלק ראשון (תער"ב – תרד"ע)
│   ├── vol2.txt          # חלק שני (העת"ר – עתר"ו)
│   ├── vol3.txt          # חלק שלישי
│   └── structure.json    # Parsed perek index with offsets
├── output/
│   ├── entries/          # Completed entry JSONs
│   ├── index.json        # Master concept index
│   └── log.txt           # Processing log
├── reference/
│   ├── abbreviations.txt # Standard Chabad rashei teivos
│   ├── concept_seed.txt  # Initial concept list from spec Section 4
│   └── haerchim_sample.txt # Sample entries (placeholder)
└── scripts/
    ├── parse_corpus.py   # Split raw text → vol1/2/3 + structure.json
    ├── pipeline.py       # Core processing functions (Steps 3.1–3.10)
    ├── validate.py       # Entry validation (spec Section 6)
    └── run.py            # Orchestrator: iterate concepts, call pipeline
```

## Architecture

### Script 1: parse_corpus.py

Reads the raw 13K-line file, splits into 3 volumes, generates structure.json.

1. Find volume split points (`חלק ראשון`, `חלק שני`, `חלק שלישי`)
2. Within each volume, parse breadcrumb lines (`ספרי כ"ק אדמו"ר מוהרש"ב נ"ע > ...`) to extract:
   - Volume number (1/2/3)
   - Perek name (e.g., `בס"ד. ש"פ נשא, תער"ב`)
   - Date (e.g., `תער"ב`)
   - Character offset and line offset within the volume file
3. Extract body text (strip headers, TOC, separators) for each volume
4. Write vol1.txt, vol2.txt, vol3.txt
5. Write structure.json with full chapter index

### Script 2: pipeline.py

Core processing — each function corresponds to a spec step:

**concept_intake(concept_str)** → Parse seed format to dict with headword, transliteration, category, seed_terms

**term_expansion(concept)** → Generate expanded search terms:
- Abbreviation forms (from internal map)
- Aramaic equivalents (from internal map)
- Contrasting terms (from internal pairs map)
- Contextual phrases (prefix/suffix patterns)

**fulltext_retrieval(terms, corpus, structure)** → Regex search:
- Search all 3 volumes for every term
- Capture full paragraph (pisqa) + 1 paragraph context before/after
- Record vol, perek, pisqa number, char offset, matching term
- De-duplicate by paragraph

**classify_passages(passages, concept)** → Heuristic classification:
- PRIMARY: Concept is subject, defining patterns present
- CONTRAST: Contrast markers present
- EXAMPLE: Mashal markers present
- ASIDE: Brief mention, enumeration, no exposition
- Also tag discourse level and extract aspect (3-5 Hebrew words)
- Discard ASIDE passages

**cluster_into_seifim(passages)** → Group by aspect:
- Passages with same aspect tag → same se'if
- 4-12 se'ifim target per entry
- Order within se'if: chronological by chapter
- Minimum 2 passages per se'if
- Generate 2-5 word Hebrew titles

**detect_contradictions(seifim)** → Scan passage pairs:
- Contradictory claims about same aspect
- Apply standard resolution frameworks (level distinction, aspect distinction, progressive development, technical vs general)
- Flag confidence level

**assemble_entry(concept, seifim, contradictions)** → Full JSON:
- Verbatim Hebrew text for each passage
- Standard Chabad citations
- Minimal connective phrases
- Footnotes for contradictions and cross-corpus references

**add_cross_refs(entry, existing_entries, seed_list)** → Link related concepts

**score_confidence(entry)** → 0.0-1.0 based on passage coverage

**save_entry(entry)** → Validate, write JSON, update index.json, append log

### Script 3: validate.py

Programmatic checks from spec Section 6:
- Minimum 2 seifim
- Minimum 2 passages per se'if
- Valid passage_id format
- Non-empty text fields
- Short connective phrases (max 12 words)
- Contradiction flags reference valid passage_ids
- Confidence score set

### Script 4: run.py

Orchestrator that:
1. Loads corpus and structure.json
2. Reads concept_seed.txt
3. For each concept in processing order:
   a. Run full pipeline
   b. Print progress
   c. Handle errors (under-coverage → under_coverage.json, garbled → OCR_SUSPECT flag)
   d. Continue to next concept
4. After all concepts, generate summary_report.md, master_abbreviations.json, cross_ref_graph.json

## Classification Heuristics

### PRIMARY indicators
- Defining patterns: היינו, מהותו, ענין, בחינת, שורש, מקור, תכלית
- Concept is grammatical subject of sentence
- Passage length > 50 Hebrew characters containing the concept

### CONTRAST indicators
- Contrast markers: משא"כ, ולא כמו, היפך, שאינו דומה, אבל, רק, אלא
- Concept paired with its known opposite (e.g., סובב near ממלא)

### EXAMPLE indicators
- Mashal markers: וכמשל, והמשכיל יבין, מעין, ועד"ז, דוגמא, ענין
- Physical/concrete terms near concept

### ASIDE indicators
- Concept in enumeration (וכו' following)
- Cross-reference only (כמ"ש, כנ"ל, וראה)
- Passage < 30 Hebrew characters

## Processing Order

Tier 1 (8 concepts): אור אין סוף → צמצום → קו → רשימו → אדם קדמון → עיגולים ויושר → סובב כל עלמין → ממלא כל עלמין

## Key Design Decisions

1. **Fully automated**: All steps scripted — no interactive judgment calls during processing
2. **Heuristic classification**: Keyword-based rather than LLM-based, for reproducibility and speed
3. **Separate project directory**: ~/code/haerchim-teerav/ independent of nanoclaw
4. **Reference files skipped initially**: abbreviations.txt, concept_seed.txt, haerchim_sample.txt to be generated from spec content
5. **Confidence scoring**: Every entry gets a score; low-confidence entries flagged for scholar review
6. **Incremental output**: Each entry saved immediately, pipeline can resume after interruption
