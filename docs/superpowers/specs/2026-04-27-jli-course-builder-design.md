# JLI Course Builder — Design Spec

## Problem

JLI curriculum developers build courses through a multi-stage process: define the course, select A-B journeys, mine existing JLI content, build outlines, draft lessons, and export. This is currently done manually with ad-hoc prompting in chat tools. The JLI Course Builder automates this pipeline into a structured web app with human-in-the-loop review at each stage.

## Approach

NotebookLM-First Pipeline. The system uses Google Sheets as the structured A-B journey source (1,759 entries), NotebookLM as the content engine for mining existing JLI lessons, and Claude API for drafting. No separate vector database or data pipeline — leverage existing structured data and NotebookLM notebooks.

## Architecture

**Frontend:** React + TypeScript + Vite + TailwindCSS
**Backend:** Node.js + Express
**Database:** SQLite (project state — courses, stage progress, user edits)
**External APIs:** Google Sheets (read-only A-B data), NotebookLM (content queries), Claude (lesson drafting)

### Data Sources

- **Google Sheets spreadsheet** (1,759 rows): Columns — Micro-Journey Title, A-B Description, Course, Lesson #, Primary Text 1 #, Primary Text 1 Citation, Primary Text 2 #, Primary Text 2 Citation. Covers 14+ JLI courses. This is the source of truth for A-B journeys.
- **NotebookLM notebooks**: Contain indexed JLI lesson content. Queried at Stage 3 to find matching material for selected A-B journeys.
- **Lesson Construction Manual**: Used as a system prompt/guide for Claude when drafting lessons. Covers A/B framing, driving questions, big ideas, outlines, opening/closing sections, processing exercises.

## Pipeline Stages

### Stage 1: Define Course

**Input:** Topic/subject, number of lessons, any guidelines or constraints.
**Process:** System generates a Course Definition Document articulating what the course is and isn't, based on the topic and guidelines.
**Output:** Course Definition Doc (editable by user).
**Human-in-the-loop:** User reviews and edits the definition doc before proceeding.

### Stage 2: Select A-B Journeys

**Input:** Course Definition Doc from Stage 1.
**Process:** System queries the Google Sheets API for A-B journeys relevant to the topic. Ranks by relevance using text matching on title, A-B description, and primary text citations. Returns top candidates (e.g., 25-50 most relevant).
**Output:** Ranked list of A-B journeys with titles, descriptions, source course/lesson references.
**Human-in-the-loop:** User browses, selects, reorders, and confirms the A-B journeys for the course. User can also request more or different journeys.

### Stage 3: Mine JLI Content

**Input:** Selected A-B journeys from Stage 2.
**Process:** For each selected A-B journey, system queries NotebookLM to find matching existing JLI lesson content — lesson texts, primary sources, relevant discussions, and source material.
**Output:** Per-journey content package: relevant lesson excerpts, primary texts, source citations from existing JLI courses.
**Human-in-the-loop:** User reviews mined content for relevance and accuracy.

### Stage 4: Build Outline

**Input:** A-B journeys + mined content from Stages 2-3, Course Definition Doc.
**Process:** System combines everything into structured lesson outlines. Each lesson gets: driving questions, big ideas, section breakdowns (3-6 micro A-B journeys per lesson), primary texts assigned to each section, activities.
**Output:** Full course outline with per-lesson structure.
**Human-in-the-loop:** User reviews and edits outlines inline in the rich text editor. Can reorder sections, adjust texts, modify section breakdowns.

### Stage 5: Draft Lessons

**Input:** Approved outlines from Stage 4, mined content from Stage 3, Lesson Construction Manual.
**Process:** Claude generates full lesson scripts (~7,500 words each), grounded in NotebookLM content. Each lesson follows JLI format: verbatim primary texts, analysis, examples, transitions. The Lesson Construction Manual is included as a system prompt to ensure compliance with JLI style guidelines.
**Output:** Full lesson drafts (one per lesson in the course).
**Human-in-the-loop:** User edits drafts in rich text editor. Can regenerate individual sections.

### Stage 6: Export

**Input:** Finalized lesson drafts from Stage 5.
**Process:** System generates:
- **Textbook**: Formatted document (PDF or Google Doc) with all lessons, styled per JLI design system.
- **PowerPoint**: Slide deck per lesson with key points, texts, and discussion prompts.
**Output:** Downloadable textbook and slide files.
**Human-in-the-loop:** User downloads and reviews exported materials.

## Frontend Design

### Pages

1. **Dashboard** — List of courses (in-progress and completed). "New Course" button.
2. **Course Workspace** — Stage-by-stage wizard. Left sidebar shows pipeline progress (stages 1-6 with checkmarks). Main content area shows current stage's input/review interface.
3. **Settings** — API key management, NotebookLM notebook selection, export preferences.

### Key Components

- **Rich Text Editor** (TipTap) — Used in Stages 1, 4, and 5 for editing course docs, outlines, and lesson drafts. Supports inline formatting, section headers, text highlighting.
- **A-B Journey Browser** — Card/list view of candidate journeys with search, filter, and selection. Shows title, A description, B description, source course/lesson, primary texts.
- **Content Mining Panel** — Shows NotebookLM query results per journey. Expandable cards with source lesson references.
- **Export Preview** — Preview of textbook/slide output before final download.

### UI Flow

Dashboard → New Course → Stage 1 (define) → Stage 2 (pick A-Bs) → Stage 3 (mine content) → Stage 4 (outline) → Stage 5 (draft) → Stage 6 (export)

Each stage transition requires user approval. User can go back to any previous stage to revise.

## Backend API

### Endpoints

```
POST   /api/courses                              — Create new course
GET    /api/courses                              — List all courses
GET    /api/courses/:id                          — Get course with current state
PUT    /api/courses/:id                          — Update course metadata
DELETE /api/courses/:id                          — Delete course (cascades)

POST   /api/courses/:id/stage/1                  — Generate course definition doc
POST   /api/courses/:id/stage/2                  — Search A-B journeys
POST   /api/courses/:id/stage/2/select           — Confirm selected A-B journeys
POST   /api/courses/:id/stage/3                  — Mine JLI content via NotebookLM
POST   /api/courses/:id/stage/4                  — Generate outline
POST   /api/courses/:id/stage/5                  — Draft lesson (streaming)
POST   /api/courses/:id/stage/5/regen            — Regenerate specific section (by lesson_number + section_number)
POST   /api/courses/:id/stage/6                  — Export textbook/slides

PUT    /api/courses/:id/stage/:stage/approve     — Approve a stage
PUT    /api/courses/:id/stage/:stage/revert      — Revert to a previous stage (cascades downstream to needs_review)
GET    /api/courses/:id/stage-progress           — Get status of all 6 stages

GET    /api/ab-journeys?q=&page=1&limit=25       — Search A-B journeys (from local SQLite cache of Sheets data)
GET    /api/ab-journeys/:id                      — Get single journey details
GET    /api/courses/:id/exports/:exportId/download — Download exported file
```

### Streaming

Stage 5 (lesson drafting) uses Server-Sent Events (SSE) to stream Claude's output to the frontend in real-time. User sees the draft being generated word by word.

### NotebookLM Integration

See "NotebookLM Query Strategy" section below for full details on endpoint, concurrency, and notebook selection.

### Google Sheets Integration

Read-only access via Google Sheets API. All 1,759 rows are loaded into SQLite on startup (see "A-B Journey Search" section). Sheets is refreshed every 24 hours or on manual trigger. No data is written back to Sheets.

## Data Model (SQLite)

```sql
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  lesson_count INTEGER NOT NULL,
  guidelines TEXT,
  current_stage INTEGER DEFAULT 1,
  version INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Per-stage tracking: status and cascading invalidation
CREATE TABLE stage_progress (
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  stage INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | needs_review | approved
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (course_id, stage)
);

CREATE TABLE course_definitions (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  approved BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- A-B selections with full Sheet columns + per-lesson assignment
CREATE TABLE ab_selections (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  journey_title TEXT NOT NULL,
  description_a TEXT NOT NULL,             -- "A" half of the journey
  description_b TEXT NOT NULL,             -- "B" half of the journey
  source_course TEXT,
  source_lesson TEXT,
  primary_text_1_num TEXT,
  primary_text_1_citation TEXT,
  primary_text_2_num TEXT,
  primary_text_2_citation TEXT,
  lesson_number INTEGER,                   -- which lesson this journey is assigned to
  section_position INTEGER,                -- ordering within the lesson
  sort_order INTEGER,                      -- global ordering
  approved BOOLEAN DEFAULT FALSE
);

-- Join table for lesson ↔ journey assignments (supports 3-6 journeys per lesson)
CREATE TABLE lesson_journey_assignments (
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lesson_number INTEGER NOT NULL,
  ab_selection_id TEXT REFERENCES ab_selections(id) ON DELETE CASCADE,
  section_position INTEGER NOT NULL,
  PRIMARY KEY (course_id, lesson_number, ab_selection_id)
);

CREATE TABLE mined_content (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  journey_id TEXT REFERENCES ab_selections(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sources TEXT,  -- JSON-encoded array of citation objects from NotebookLM
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE outlines (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lesson_number INTEGER NOT NULL,
  content TEXT NOT NULL,  -- JSON: { driving_questions, big_ideas, sections: [{title, journey_id, texts, activities}] }
  approved BOOLEAN DEFAULT FALSE
);

-- Section-based drafts for per-section regeneration
CREATE TABLE lesson_sections (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lesson_number INTEGER NOT NULL,
  section_number INTEGER NOT NULL,
  section_type TEXT,  -- opening | main | closing
  content TEXT NOT NULL,
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE lesson_drafts (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  lesson_number INTEGER NOT NULL,
  content TEXT NOT NULL,  -- assembled from lesson_sections
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- pdf | pptx
  file_path TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Trigger: update updated_at on courses
CREATE TRIGGER update_course_timestamp
AFTER UPDATE ON courses
BEGIN
  UPDATE courses SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;
```

## Error Handling

- **Sheets API failures**: Fall back to cached A-B data from last successful fetch. Show warning to user.
- **NotebookLM timeouts**: Queue queries, retry with exponential backoff (3 retries). Show progress indicator per journey.
- **Claude API errors**: Surface error to user with retry button. Partial drafts are saved automatically.
- **Concurrent access**: SQLite WAL mode for safe concurrent reads. Optimistic locking on course updates.

## Testing Strategy

- **Unit tests**: A-B journey ranking algorithm, outline generation logic, export formatting.
- **Integration tests**: Sheets API fetch, NotebookLM query mock, Claude API mock with streaming.
- **E2E tests**: Full pipeline from course creation through export, using mocked external APIs.

## Security

- API keys stored in environment variables, never committed.
- Google Sheets credentials via OAuth or service account (read-only scope).
- No user authentication in MVP — single-user production tool. Auth can be added later.

## Deployment Context

This is a **standalone web app** separate from the GabAI/NanoClaw orchestrator. The spec lives in this repo for convenience (shared NotebookLM infrastructure and project context), but the app runs independently with its own Express server, SQLite database, and frontend build. Future integration as a GabAI skill is possible but not in scope for MVP.

## NotebookLM Query Strategy

The Express backend calls NotebookLM via the existing HTTP daemon (`notebooklm_daemon.py` on port 11435). Each A-B journey query sends the journey title + description to the `callAsk` endpoint with the relevant notebook ID.

**Notebook selection:** All JLI lessons are indexed in a single NotebookLM notebook. The notebook ID is configured in Settings and stored as an env var (`NOTEBOOKLM_NOTEBOOK_ID`).

**Concurrency:** Queries run with a pool of 3 concurrent requests (matching the daemon's `SessionPool.max_warm=3`). A course with 20 A-B journeys processes in ~7 batches. Progress is reported per-journey to the frontend via SSE.

**Queue:** An in-memory job queue in the Express process manages batch queries. Failed queries retry 3 times with exponential backoff. The queue state is ephemeral — if the server restarts, Stage 3 must be re-run (mined content already persisted in SQLite is preserved).

## A-B Journey Search (Stage 2)

**Input:** Search is auto-derived from the Course Definition Doc (topic + key themes extracted by a lightweight Claude call). User can also type a manual search query to refine.

**Ranking:** TF-IDF cosine similarity between the search query and concatenated A-B journey fields (title + description A + description B + primary text citations). Top 50 results returned.

**Loading strategy:** All 1,759 rows are loaded from Sheets into SQLite on app startup and refreshed every 24 hours (or on manual refresh from Settings). This avoids per-request Sheets API calls and enables fast text search.

**Pagination:** `GET /api/ab-journeys?q=...&page=1&limit=25` returns paginated results.

## Stage Navigation and Cascading Invalidation

Each course tracks per-stage status in the `stage_progress` table. When a user revises Stage N, all stages N+1 through 6 are reset to `needs_review` status. Their data is preserved but flagged as potentially stale. The UI shows a warning on downstream stages: "Upstream stage revised — review recommended."

User can explicitly re-approve a downstream stage without changes if the upstream revision didn't affect it.

## Export Details (Stage 6)

**Libraries:**
- **PDF**: `pdfkit` (Node.js) with a JLI-branded template (fonts, margins, header/footer defined in a JSON config file at `config/export-template.json`).
- **PowerPoint**: `pptxgenjs` with a JLI slide master template at `config/slide-template.pptx`.
- **Google Docs**: Not in MVP scope. PDF export first; Google Docs export is a future enhancement requiring OAuth.

**File serving:** Exported files are stored in `data/exports/{course_id}/`. Served via `GET /api/courses/:id/exports/:exportId/download`. Files are cleaned up after 30 days.

## Lesson Construction Manual

Stored as a static file at `config/lesson-construction-manual.md`. Loaded at server startup and injected as a system prompt prefix for Claude in Stage 5. Can be edited by placing a new file at that path. No database storage — it's a reference document, not per-course data.

## Future Considerations (Not in Scope)

- Multi-user authentication and role-based access
- Direct Google Docs/Sheets editing integration
- Version history and diffing between draft iterations
- Collaborative editing (multiple users on one course)
- Broader audience access (shluchim browsing A-B journeys)
- Local vector database replacing NotebookLM dependency
