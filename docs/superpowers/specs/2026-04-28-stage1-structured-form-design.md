# Stage 1 Redesign: Structured Course Definition Form

## Problem

Stage 1 currently uses a free-text "guidelines" field plus an AI generation step (`generateCourseDefinition()`) that produces a verbose course definition document. In practice, the value of Stage 1 is gathering constraints — who the course is for, why it exists, what it covers. A structured form captures this more reliably than AI-generated prose.

## Approach

Replace the AI generation step with a fixed set of structured fields. The completed form IS the course definition — no Claude call, no rich text editor, no "Generate Definition" button. The developer fills in the fields, reviews them, and approves.

## Design

### Form Fields

| # | Field | DB Column | Type | Required | Default | Notes |
|---|-------|-----------|------|----------|---------|-------|
| 1 | **Topic** | `topic` *(existing)* | text input | yes | — | e.g. "The meaning of suffering". Column already exists in `courses`. |
| 2 | **Target Audience** | `target_audience` *(new)* | text input | yes | "Broadly educated Jewish adults" | Pre-filled, editable |
| 3 | **Why is this course being taught?** | `purpose` *(new)* | textarea (3-5 lines) | yes | — | The rationale/goal |
| 4 | **Number of Lessons** | `lesson_count` *(existing)* | number | yes | 6 | Min 1, max 12. Column already exists in `courses`. |
| 5 | **Lesson Length** | `lesson_length` *(new)* | text input | yes | "~7,500 words" | Pre-filled, editable. Freeform (e.g. "90 min", "~5,000 words") |

Fields 1 and 4 use existing columns — no schema change needed for them. Fields 2, 3, 5 are new columns.

The existing `title` field (course display name) stays on the dashboard create-modal. The existing `guidelines` column is kept in the DB for backward compatibility but no longer exposed in the UI — `purpose` replaces it.

### Database Changes

Add three new columns to `courses` table. `guidelines` column stays but is no longer read or written by the UI.

```sql
ALTER TABLE courses ADD COLUMN target_audience TEXT DEFAULT 'Broadly educated Jewish adults';
ALTER TABLE courses ADD COLUMN lesson_length TEXT DEFAULT '~7,500 words';
ALTER TABLE courses ADD COLUMN purpose TEXT;
```

Also update the `initDb()` function in `server/db.ts` to include these columns in the `CREATE TABLE` statement for new databases.

### Frontend Changes

**Stage1Define.tsx — Remove:**
- The "Generate Definition" button and its `handleGenerate` handler
- The `isGenerating` loading state
- The RichTextEditor component import and usage
- The `definition` state variable
- The call to `POST /courses/:id/stage/1` (the AI generation endpoint)
- The `course_definitions` table interaction at Stage 1
- The `handleSaveMetadata` handler and "Save Details" button (replaced by auto-save)

**Stage1Define.tsx — Add:**
- Target Audience text input (pre-filled with default)
- Lesson Length text input (pre-filled with default)
- Purpose textarea (replaces the Guidelines textarea)
- Auto-save: fields save to backend on blur (debounced), no explicit save button needed
- Approve button renders when all required fields are filled (not when `definition` exists)

**Stage1Define.tsx — Keep unchanged:**
- The approve/unapprove flow
- The "Approve & Continue" button
- The "Undo Approval" button
- The topic and lesson count fields
- The stage sidebar navigation

**CourseWorkspace.tsx — Remove:**
- The fetch to `GET /courses/:id/definition` on mount
- The `definition` prop passed to Stage1Define

**Dashboard.tsx — Modify:**
- The "New Course" modal currently collects `topic`, `lesson_count`, and `guidelines`. After this change, the modal collects only `title` (required to create the course row). Topic, lesson count, and all new fields are set on the Stage 1 form.
- `POST /courses` must accept `title` as the only required field. `topic` becomes optional (default empty string), `lesson_count` defaults to 6.

**types.ts — Update:**
- Add `target_audience`, `lesson_length`, `purpose` to the `Course` interface
- Add them to `CreateCourseRequest`
- Keep `guidelines` in types for backward compat but mark optional/deprecated

**RichTextEditor.tsx — Keep:**
- The component stays in the codebase. It is still used by Stage 4 (outline editing) and Stage 5 (draft editing). Only Stage 1 stops using it.

### Backend Changes

**Remove:**
- The `POST /courses/:id/stage/1` endpoint (no more AI generation for Stage 1)
- The `generateCourseDefinition()` function in `services/claude.ts`
- The `GET /courses/:id/definition` endpoint

**Modify `PUT /courses/:id`:**
- Accept `target_audience`, `lesson_length`, `purpose` fields in addition to existing ones

**Modify `POST /courses`:**
- Accept `target_audience`, `lesson_length`, `purpose` fields
- `title` is the only required field. `topic` defaults to `''`, `lesson_count` defaults to `6`

**Modify Stage 2 endpoint (`POST /courses/:id/stage/2`):**
- Replace `course.topic` search query with `${course.topic} ${course.purpose}` for richer TF-IDF matching

**Modify Stage 4 endpoint (`POST /courses/:id/stage/4`):**
- Remove the `course_definitions` table query
- Replace the guard condition: instead of checking `course_definitions` exists, check that `course.topic` and `course.purpose` are non-empty
- Compose the course context string for the outline prompt:

```typescript
const courseContext = [
  `Topic: ${course.topic}`,
  `Purpose: ${course.purpose}`,
  `Target Audience: ${course.target_audience}`,
  `Number of Lessons: ${course.lesson_count}`,
  `Lesson Length: ${course.lesson_length}`,
].join('\n');
```

- Pass `courseContext` as the first argument to `generateOutline()` instead of `courseDef.content`

**Modify `generateOutline()` in `services/claude.ts`:**
- The function signature stays the same (first arg is `courseDef: string`)
- The prompt template replaces `Course Definition:\n${courseDef}` with `Course Context:\n${courseDef}`
- No other changes needed — the function works with any string input

### Data Flow After Change

```
Stage 1: Developer fills 5 fields → auto-saves on blur → approves → advances to Stage 2
Stage 2: topic + purpose → TF-IDF search → journey selection
Stage 3: NotebookLM mining (unchanged)
Stage 4: courseContext (topic + purpose + audience + lesson_count + lesson_length) → outline generation
Stage 5: outline + mined content → drafting (unchanged)
Stage 6: export (unchanged)
```

### Downstream Impact

Stages 2 and 4 currently read from `course_definitions.content`. After this change they compose context from `courses` columns directly. The `course_definitions` table stays in the schema for backward compatibility but is no longer queried. New courses will never have rows in it.

## Out of Scope

- Changes to Stages 3, 5, 6
- Migration of existing courses (old courses with `course_definitions` still work; new courses use the form)
- The `config/lesson-construction-manual.md` (still used for Stage 5)
