# Ha'erchim Teerav Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully automated Python pipeline that processes Hemshech Teerav into structured Sefer Ha'erchim encyclopedia entries (JSON).

**Architecture:** Modular Python scripts — one for corpus parsing, one for the processing pipeline, one for validation, and a runner that orchestrates concept-by-concept processing. Heuristic-based classification and clustering. Incremental output with confidence scoring.

**Tech Stack:** Python 3, standard library only (re, json, os, datetime, collections). No external dependencies.

**Spec:** `docs/superpowers/specs/2026-04-29-haerchim-teerav-design.md`
**Source text:** `/home/chassidusaicon/code/nanoclaw/groups/whatsapp_main/chabad-library-clean-books/המשך_תער״ב_—_Hemshech_Tav-Resh-Ayin-Beis.txt` (13,184 lines, 5.5MB, 3 volumes)

**Source text structure:**
- Lines 1-2730: TOC/index (chapter listings with page numbers)
- Lines 2731-13184: Body text
  - Chapters marked by `בס"ד. ...` lines (249 total)
  - Pages marked by `3601xxxxxx` IDs between `===` separators (1,210 total)
  - Paragraphs marked by `[cup]...[/cup]` opening tags (1,143 total)
  - Volume boundaries in body text: chapters in חלק ראשון, חלק שני, חלק שלישי

---

## File Structure

```
~/code/haerchim-teerav/
├── corpus/
│   ├── vol1.txt              # חלק ראשון body text (תער"ב – תרד"ע)
│   ├── vol2.txt              # חלק שני body text (העת"ר – עתר"ו)
│   ├── vol3.txt              # חלק שלישי body text
│   └── structure.json        # {chapters: [{vol, num, title, date, line_start, line_end, char_offset}]}
├── output/
│   ├── entries/              # {headword_ascii}.json files
│   ├── index.json            # Master concept index
│   ├── log.txt               # Processing log
│   ├── under_coverage.json   # Concepts with too few passages
│   ├── summary_report.md     # Generated after all processing
│   ├── master_abbreviations.json
│   └── cross_ref_graph.json
├── reference/
│   ├── concept_seed.txt      # From spec Section 4
│   ├── abbreviations.txt     # Placeholder
│   └── haerchim_sample.txt   # Placeholder
└── scripts/
    ├── parse_corpus.py       # Task 1-2
    ├── pipeline.py           # Task 3-5
    ├── validate.py           # Task 6
    └── run.py                # Task 7
```

---

### Task 1: Create project directory structure

**Files:**
- Create: `~/code/haerchim-teerav/` and all subdirectories

- [ ] **Step 1: Create directories**

```bash
mkdir -p ~/code/haerchim-teerav/{corpus,output/entries,reference,scripts}
```

- [ ] **Step 2: Create empty output files**

```bash
touch ~/code/haerchim-teerav/output/index.json
echo '[]' > ~/code/haerchim-teerav/output/index.json
touch ~/code/haerchim-teerav/output/log.txt
echo '[]' > ~/code/haerchim-teerav/output/under_coverage.json
```

- [ ] **Step 3: Create concept_seed.txt from spec Section 4**

Write the Tier 1-5 concept list to `reference/concept_seed.txt`. Format per the spec:

```
CONCEPT: אור אין סוף
TRANSLITERATION: Ohr Ein Sof
CATEGORY: OROT
PRIORITY: HIGH
SEED_TERMS: אוא"ס, אין סוף, אורו ית', אור הא"ס

CONCEPT: צמצום
...
```

- [ ] **Step 4: Verify structure**

Run: `find ~/code/haerchim-teerav -type f -o -type d | sort`
Expected: All directories and seed files present.

---

### Task 2: Build parse_corpus.py — corpus splitting and structure.json

**Files:**
- Create: `~/code/haerchim-teerav/scripts/parse_corpus.py`

This script reads the raw source file and produces `corpus/vol1.txt`, `corpus/vol2.txt`, `corpus/vol3.txt`, and `corpus/structure.json`.

**Source file path:** `/home/chassidusaicon/code/nanoclaw/groups/whatsapp_main/chabad-library-clean-books/המשך_תער״ב_—_Hemshech_Tav-Resh-Ayin-Beis.txt`

**Parsing logic:**

1. Read entire file as UTF-8
2. Find body text start: the line after the last TOC entry (look for the second occurrence of `============================================================` followed by a `3601xxxxxx` line). Body text starts around line 2731.
3. In the body text, find chapter boundaries by matching `בס"ד. ` lines that appear between `============================================================` separators
4. Determine volume assignment by matching chapter titles to the volume TOC:
   - Vol 1 (חלק ראשון): chapters from חה"ש תער"ב through נצו"י תרד"ע
   - Vol 2 (חלק שני): chapters from ליל ב' דר"ה העת"ר through ש"פ וירא עתר"ו
   - Vol 3 (חלק שלישי): chapters from המשך בכתב שלא נאמר onwards
5. For each chapter, extract:
   - `vol`: 1, 2, or 3
   - `num`: sequential chapter number within the volume
   - `title`: the chapter title string (e.g., `בס"ד. ש"פ נשא, תער"ב`)
   - `date`: the year string (e.g., `תער"ב`)
   - `line_start`: line number within the volume file where this chapter's body text starts
   - `line_end`: line number where the next chapter starts
   - `char_offset`: character offset within the volume file
6. Strip `[cup]...[/cup]` tags from the body text (replace with just the word inside)
7. Write each volume's body text to vol1.txt, vol2.txt, vol3.txt
8. Write structure.json with the chapter index

- [ ] **Step 1: Write parse_corpus.py**

The script should:
- Accept `--source` path (default to the known path)
- Accept `--output-dir` (default `~/code/haerchim-teerav/corpus/`)
- Use only standard library
- Handle encoding properly (UTF-8)
- Be idempotent (safe to re-run)

- [ ] **Step 2: Run parse_corpus.py**

Run: `cd ~/code/haerchim-teerav && python3 scripts/parse_corpus.py`
Expected: vol1.txt, vol2.txt, vol3.txt, structure.json created

- [ ] **Step 3: Verify output**

```bash
wc -l ~/code/haerchim-teerav/corpus/vol*.txt
python3 -c "import json; s=json.load(open('corpus/structure.json')); print(f'Chapters: {len(s[\"chapters\"])}'); print(f'V1: {sum(1 for c in s[\"chapters\"] if c[\"vol\"]==1)}'); print(f'V2: {sum(1 for c in s[\"chapters\"] if c[\"vol\"]==2)}'); print(f'V3: {sum(1 for c in s[\"chapters\"] if c[\"vol\"]==3)}')"
```

Expected: ~249 chapters total, roughly split across 3 volumes.

- [ ] **Step 4: Spot-check a chapter**

Read a few lines from vol1.txt to verify Hebrew text is clean and `[cup]` tags are stripped.

---

### Task 3: Build pipeline.py — retrieval and classification

**Files:**
- Create: `~/code/haerchim-teerav/scripts/pipeline.py`

Core functions:

```python
def concept_intake(seed_text: str) -> dict
def term_expansion(concept: dict) -> list[str]
def fulltext_retrieval(terms: list[str], corpus_dir: str, structure: dict) -> list[dict]
def classify_passages(passages: list[dict], concept: dict) -> list[dict]
def cluster_into_seifim(passages: list[dict], concept: dict) -> list[dict]
def detect_contradictions(seifim: list[dict]) -> list[dict]
def assemble_entry(concept: dict, seifim: list[dict], contradictions: list[dict]) -> dict
def add_cross_refs(entry: dict, existing_index: list[dict], seed_concepts: list[dict]) -> dict
def score_confidence(entry: dict) -> float
```

**Key implementation details:**

**fulltext_retrieval**: Use `re.finditer()` on each volume file. For each match, capture the surrounding paragraph (text between consecutive `[cup]` markers or between blank lines). Record vol, chapter, paragraph number, char offset, matching term. De-duplicate paragraphs that are hit by multiple terms.

**classify_passages**: Heuristic keyword matching:
- PRIMARY: Look for defining patterns (היינו, מהותו, ענין, בחינת, שורש, מקור, תכלית, עצמות) within 20 chars of concept term
- CONTRAST: Look for contrast markers (משא"כ, ולא כמו, היפך, אבל, רק, אלא, שאינו)
- EXAMPLE: Look for mashal markers (וכמשל, מעין, ועד"ז, דוגמא) or concrete terms
- ASIDE: Short passages (<30 Hebrew chars containing concept) or enumeration-only context
- Also tag discourse_level (Atzilus/BY"A/general) and extract aspect (3-5 Hebrew words near the concept)

**cluster_into_seifim**: Group by extracted aspect, merge small clusters, ensure 4-12 seifim, minimum 2 passages per se'if, chronological ordering within se'if, generate Hebrew titles.

**Contrast pairs map** (built into pipeline.py):
```python
CONTRAST_PAIRS = {
    "סובב": "ממלא", "ממלא": "סובב",
    "חכמה": "בינה", "בינה": "חכמה",
    "חסד": "גבורה", "גבורה": "חסד",
    "אור פנימי": "אור מקיף", "אור מקיף": "אור פנימי",
    "עצמות": "מהות", "מהות": "עצמות",
    # ... more pairs
}
```

- [ ] **Step 1: Write pipeline.py with all functions**

Implement all 10 functions with full docstrings. Use only standard library.

- [ ] **Step 2: Test retrieval on a known concept**

```bash
cd ~/code/haerchim-teerav
python3 -c "
from scripts.pipeline import *
s = json.load(open('corpus/structure.json'))
c = concept_intake(open('reference/concept_seed.txt').read().split('\n\n')[0])
terms = term_expansion(c)
hits = fulltext_retrieval(terms, 'corpus/', s)
print(f'Concept: {c[\"headword_he\"]}')
print(f'Expanded terms: {len(terms)}')
print(f'Retrieved passages: {len(hits)}')
"
```

Expected: For אור אין סוף, should find 50+ passages across all 3 volumes.

---

### Task 4: Build pipeline.py — entry assembly, cross-refs, confidence

**Files:**
- Modify: `~/code/haerchim-teerav/scripts/pipeline.py` (add assembly functions)

**assemble_entry**: Constructs the full JSON entry per the spec schema (Section 2). Key rules:
- Copy Hebrew text verbatim from corpus
- Generate standard Chabad citations (המשך תער"ב ח"א פ'כ)
- Write connective phrases (2-10 Hebrew words max) or null
- Write footnotes in Hebrew scholarly register

**add_cross_refs**: Check seed_concepts and existing_index for related concepts using the CONTRAST_PAIRS map and textual co-occurrence.

**score_confidence**: 0.9-1.0 for 10+ PRIMARY passages, 0.7-0.89 for 5-9, 0.5-0.69 for 2-4.

- [ ] **Step 1: Add assembly, cross-refs, and confidence functions to pipeline.py**

- [ ] **Step 2: Test full pipeline on one concept**

```bash
cd ~/code/haerchim-teerav
python3 scripts/run.py --concept 0 --dry-run
```

Expected: Prints the full entry JSON for the first concept without saving.

---

### Task 5: Build validate.py — entry validation

**Files:**
- Create: `~/code/haerchim-teerav/scripts/validate.py`

Implements the `validate_entry()` function from spec Section 6. Returns list of error strings. Empty list = valid.

Checks:
- Minimum 2 seifim
- Minimum 2 passages per se'if
- All passage_ids start with "TEERAV."
- No empty text fields (min 20 chars)
- Connective phrases max 12 words
- Contradiction flags reference valid passage_ids
- Confidence score != 0.0

- [ ] **Step 1: Write validate.py**

- [ ] **Step 2: Test with a valid and invalid entry**

Create a minimal test entry, validate it, verify both pass/fail cases.

---

### Task 6: Build run.py — orchestrator

**Files:**
- Create: `~/code/haerchim-teerav/scripts/run.py`

Orchestrator that:
1. Loads corpus and structure.json
2. Reads concept_seed.txt, parses into individual concepts
3. For each concept in order:
   a. Run full pipeline (intake → expansion → retrieval → classification → clustering → contradiction → assembly → cross-refs → confidence → validation)
   b. If validation passes, save entry to output/entries/
   c. Update output/index.json
   d. Append to output/log.txt
   e. If under-coverage (<4 passages), write to under_coverage.json instead
4. After all concepts: generate summary_report.md, master_abbreviations.json, cross_ref_graph.json

CLI interface:
```
python3 run.py                    # Process all concepts
python3 run.py --concept 0        # Process only concept index 0
python3 run.py --concept 0 --dry-run  # Print entry without saving
python3 run.py --tier 1           # Process only Tier 1
python3 run.py --resume           # Skip already-processed concepts
```

- [ ] **Step 1: Write run.py**

- [ ] **Step 2: Run on first concept (dry-run)**

```bash
cd ~/code/haerchim-teerav
python3 scripts/run.py --concept 0 --dry-run 2>&1 | head -50
```

Expected: Shows the entry for אור אין סוף with passages, seifim, confidence score.

- [ ] **Step 3: Run on first concept (save)**

```bash
cd ~/code/haerchim-teerav
python3 scripts/run.py --concept 0
```

Expected: Entry saved to output/entries/ohr_ein_sof.json, index.json updated, log.txt updated.

- [ ] **Step 4: Verify saved entry**

```bash
python3 -c "import json; e=json.load(open('output/entries/ohr_ein_sof.json')); print(f'Seifim: {len(e[\"seifim\"])}'); print(f'Passages: {sum(len(s[\"passages\"]) for s in e[\"seifim\"])}'); print(f'Confidence: {e[\"processing_metadata\"][\"confidence_score\"]}')"
```

---

### Task 7: Run full Tier 1 processing

**Files:**
- Modify: output/entries/*.json, output/index.json, output/log.txt

- [ ] **Step 1: Run all Tier 1 concepts**

```bash
cd ~/code/haerchim-teerav
python3 scripts/run.py --tier 1
```

This processes all 8 Tier 1 concepts:
1. אור אין סוף (Ohr Ein Sof)
2. צמצום (Tzimtzum)
3. קו (Kav)
4. רשימו (Reshimu)
5. אדם קדמון (Adam Kadmon)
6. עיגולים ויושר (Iggulim v'Yosher)
7. סובב כל עלמין (Sovev Kol Almin)
8. ממלא כל עלמין (Memalei Kol Almin)

Expected: 8 entry JSON files, updated index.json, log entries for each.

- [ ] **Step 2: Check results**

```bash
cd ~/code/haerchim-teerav
echo "=== Entries ==="
ls -la output/entries/
echo "=== Log ==="
cat output/log.txt
echo "=== Under-coverage ==="
cat output/under_coverage.json
```

- [ ] **Step 3: Review a sample entry**

Read one of the completed entries to verify quality — check that passages are verbatim Hebrew, citations are correct format, seifim titles are specific, cross-references make sense.

- [ ] **Step 4: Commit results**

```bash
cd ~/code/haerchim-teerav
git init
git add -A
git commit -m "feat: Tier 1 Ha'erchim Teerav entries — 8 foundational concepts processed"
```
