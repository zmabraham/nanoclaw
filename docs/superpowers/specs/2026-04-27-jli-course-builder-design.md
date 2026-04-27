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
POST   /api/courses                    — Create new course
GET    /api/courses                    — List all courses
GET    /api/courses/:id                — Get course with current state
PUT    /api/courses/:id                — Update course metadata
DELETE /api/courses/:id                — Delete course

POST   /api/courses/:id/stage/1        — Generate course definition doc
POST   /api/courses/:id/stage/2        — Search A-B journeys
POST   /api/courses/:id/stage/2/select — Confirm selected A-B journeys
POST   /api/courses/:id/stage/3        — Mine JLI content via NotebookLM
POST   /api/courses/:id/stage/4        — Generate outline
POST   /api/courses/:id/stage/5        — Draft lesson (streaming)
POST   /api/courses/:id/stage/5/regen  — Regenerate specific section
POST   /api/courses/:id/stage/6        — Export textbook/slides

GET    /api/ab-journeys                — Search A-B journeys (proxied from Sheets)
GET    /api/ab-journeys/:id            — Get single journey details
```

### Streaming

Stage 5 (lesson drafting) uses Server-Sent Events (SSE) to stream Claude's output to the frontend in real-time. User sees the draft being generated word by word.

### NotebookLM Integration

Queried via the NotebookLM MCP/API during Stage 3. The backend sends the A-B journey description and receives grounded content with source citations. This content is stored in SQLite for the course project so it doesn't need re-querying.

### Google Sheets Integration

Read-only access via Google Sheets API. A-B journeys are fetched on demand during Stage 2 (search/rank). Response is cached in memory for the session duration. No data is written back to Sheets.

## Data Model (SQLite)

```sql
CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  topic TEXT NOT NULL,
  lesson_count INTEGER NOT NULL,
  guidelines TEXT,
  current_stage INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE course_definitions (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id),
  content TEXT NOT NULL,
  approved BOOLEAN DEFAULT FALSE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ab_selections (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id),
  journey_title TEXT NOT NULL,
  journey_description TEXT NOT NULL,
  source_course TEXT,
  source_lesson TEXT,
  sort_order INTEGER,
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE mined_content (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id),
  journey_id TEXT REFERENCES ab_selections(id),
  content TEXT NOT NULL,
  sources TEXT,
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE outlines (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id),
  lesson_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE lesson_drafts (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id),
  lesson_number INTEGER NOT NULL,
  content TEXT NOT NULL,
  approved BOOLEAN DEFAULT FALSE
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  course_id TEXT REFERENCES courses(id),
  type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
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

## Future Considerations (Not in Scope)

- Multi-user authentication and role-based access
- Direct Google Docs/Sheets editing integration
- Version history and diffing between draft iterations
- Collaborative editing (multiple users on one course)
- Broader audience access (shluchim browsing A-B journeys)
- Local vector database replacing NotebookLM dependency
