---
name: add-pdf-reader
description: Add PDF reading to NanoClaw agents. Extracts text from PDFs via pdftotext CLI. Handles WhatsApp attachments, URLs, and local files.
---

# Add PDF Reader

Adds PDF reading capability to all container agents using poppler-utils (pdftotext/pdfinfo). PDFs sent as WhatsApp attachments are auto-downloaded to the group workspace.

> **Route through media-ingestion (recommended):** If the `media-ingestion` skill is installed, this skill also registers a priority-ranked `MediaHandler` for `kind: 'document'` / `mimetype: 'application/pdf'`. The pipeline then owns download, size/timeout guards, attachment-dir rotation, and marker emission (`[PDF: attachments/<name>]`). The legacy WhatsApp-only path below still works when media-ingestion is not installed — install it first if you want the unified pipeline.

## Phase 1: Pre-flight

1. Check if `container/skills/pdf-reader/pdf-reader` exists — skip to Phase 3 if already applied
2. Confirm WhatsApp is installed first (`skill/whatsapp` merged). This skill modifies WhatsApp channel files.

## Phase 2: Apply Code Changes

### Ensure WhatsApp fork remote

```bash
git remote -v
```

If `whatsapp` is missing, add it:

```bash
git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
```

### Merge the skill branch

```bash
git fetch whatsapp skill/pdf-reader
git merge whatsapp/skill/pdf-reader || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `container/skills/pdf-reader/SKILL.md` (agent-facing documentation)
- `container/skills/pdf-reader/pdf-reader` (CLI script)
- `poppler-utils` in `container/Dockerfile`
- PDF attachment download in `src/channels/whatsapp.ts`
- PDF tests in `src/channels/whatsapp.test.ts`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate

```bash
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

### Rebuild container

```bash
./container/build.sh
```

### Register the handler (only if media-ingestion is installed)

If `src/media/registry.ts` exists in your tree, also register a specialized PDF handler so pipeline-enabled groups route PDFs through media-ingestion instead of the legacy WhatsApp path.

1. Create `src/media/handlers/pdf.ts` — implement `MediaHandler` with:
   - `name: 'pdf'`
   - `priority: 50` (beats the `fallback` handler's priority of 0; document kind isn't matched by fallback but explicit priority documents intent)
   - `matches(ref)`: `ref.kind === 'document' && ref.mimetype === 'application/pdf'`
   - `process(ref, ctx, signal)`: write the PDF bytes to `attachments/pdf-<ts>-<rand>.pdf`, shell out to `pdftotext` against the resulting path, return `{ textRepresentation: '[PDF: <relpath>]\n<extracted-text>', workspaceFile: { relativePath, bytes: ref.buffer }, handlerName: 'pdf', durationMs }`. Respect the `signal` abort and size caps.
2. Register at startup — in `src/media/bootstrap.ts`, add:
   ```ts
   import { registerMediaHandler } from './registry.js';
   import { pdfHandler } from './handlers/pdf.js';
   registerMediaHandler(pdfHandler);
   ```
3. Add a `src/media/handlers/pdf.test.ts` covering match behaviour and a happy-path extraction against a fixture PDF.

The legacy `src/channels/whatsapp.ts` download path stays as-is — it's a no-op when `MEDIA_PIPELINE_ENABLED='1'` because the pipeline short-circuits before the legacy emit.

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test PDF extraction

Send a PDF file in any registered WhatsApp chat. The agent should:
1. Download the PDF to `attachments/`
2. Respond acknowledging the PDF
3. Be able to extract text when asked

### Test URL fetching

Ask the agent to read a PDF from a URL. It should use `pdf-reader fetch <url>`.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i pdf
```

Look for:
- `Downloaded PDF attachment` — successful download
- `Failed to download PDF attachment` — media download issue

## Troubleshooting

### Agent says pdf-reader command not found

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### PDF text extraction is empty

The PDF may be scanned (image-based). pdftotext only handles text-based PDFs. Consider using the agent-browser to open the PDF visually instead.

### WhatsApp PDF not detected

Verify the message has `documentMessage` with `mimetype: application/pdf`. Some file-sharing apps send PDFs as generic files without the correct mimetype.

### Pipeline enabled but no PDF handler ran

If `MEDIA_PIPELINE_ENABLED='1'` and PDFs fall through to the `fallback` handler (or get no handler at all), the pdf handler probably isn't registered. Grep for `registerMediaHandler(pdfHandler)` in `src/media/bootstrap.ts` and verify the import resolves. Log line `media ingestion path: pipeline` at startup confirms the pipeline is active.
