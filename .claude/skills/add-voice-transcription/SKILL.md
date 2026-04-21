---
name: add-voice-transcription
description: Add voice message transcription to NanoClaw using OpenAI's Whisper API. Automatically transcribes WhatsApp voice notes so the agent can read and respond to them.
---

# Add Voice Transcription

This skill adds automatic voice message transcription to NanoClaw's WhatsApp channel using OpenAI's Whisper API. When a voice note arrives, it is downloaded, transcribed, and delivered to the agent as `[Voice: <transcript>]`.

> **Route through media-ingestion (recommended):** If the `media-ingestion` skill is installed, this skill also registers a priority-ranked `MediaHandler` for `kind: 'voice'`. **The handler must use priority ≥ 1** — the `fallback` handler already matches voice at priority 0, so without a higher priority the raw-audio fallback wins and no transcription happens. The pipeline owns download, size/timeout guards, rotation, and marker emission. The legacy WhatsApp-only path below still works when media-ingestion is not installed — install it first if you want the unified pipeline. (The marketplace catalog enforces this ordering: voice-transcription's entry has `depends: ["media-ingestion"]`.)

## Phase 1: Pre-flight

### Check if already applied

Check if `src/transcription.ts` exists. If it does, skip to Phase 3 (Configure). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect information:

AskUserQuestion: Do you have an OpenAI API key for Whisper transcription?

If yes, collect it now. If no, direct them to create one at https://platform.openai.com/api-keys.

## Phase 2: Apply Code Changes

**Prerequisite:** WhatsApp must be installed first (`skill/whatsapp` merged). This skill modifies WhatsApp channel files.

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
git fetch whatsapp skill/voice-transcription
git merge whatsapp/skill/voice-transcription || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/transcription.ts` (voice transcription module using OpenAI Whisper)
- Voice handling in `src/channels/whatsapp.ts` (isVoiceMessage check, transcribeAudioMessage call)
- Transcription tests in `src/channels/whatsapp.test.ts`
- `openai` npm dependency in `package.json`
- `OPENAI_API_KEY` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install --legacy-peer-deps
npm run build
npx vitest run src/channels/whatsapp.test.ts
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Configure

### Get OpenAI API key (if needed)

If the user doesn't have an API key:

> I need you to create an OpenAI API key:
>
> 1. Go to https://platform.openai.com/api-keys
> 2. Click "Create new secret key"
> 3. Give it a name (e.g., "NanoClaw Transcription")
> 4. Copy the key (starts with `sk-`)
>
> Cost: ~$0.006 per minute of audio (~$0.003 per typical 30-second voice note)

Wait for the user to provide the key.

### Add to environment

Add to `.env`:

```bash
OPENAI_API_KEY=<their-key>
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

### Register the handler (only if media-ingestion is installed)

If `src/media/registry.ts` exists in your tree, also register a specialized voice handler so pipeline-enabled groups route voice notes through media-ingestion and get Whisper transcription instead of the raw-audio fallback.

1. Create `src/media/handlers/voice-transcription.ts` — implement `MediaHandler` with:
   - `name: 'voice-transcription'`
   - `priority: 100` (**must be > 0 to beat the fallback handler**, which matches voice at priority 0)
   - `matches(ref)`: `ref.kind === 'voice'` (all voice-mime variants)
   - `process(ref, ctx, signal)`: write the audio bytes to `attachments/voice-<ts>-<rand>.<ext>`, call `transcribeAudioMessage()` from `src/transcription.ts` (reuse the existing Whisper wrapper), and return:
     ```ts
     {
       textRepresentation: `[Voice: ${transcript}]`,
       workspaceFile: { relativePath, bytes: ref.buffer },
       handlerName: 'voice-transcription',
       durationMs,
     }
     ```
   - On transcription failure, either return a `ProcessedMedia` with `error` set (pipeline records it) or fall through to a `[Voice Message - transcription failed]` text — match the existing WhatsApp-path behavior.
2. Register at startup — in `src/media/bootstrap.ts`:
   ```ts
   import { registerMediaHandler } from './registry.js';
   import { voiceTranscriptionHandler } from './handlers/voice-transcription.js';
   registerMediaHandler(voiceTranscriptionHandler);
   ```
3. Add `src/media/handlers/voice-transcription.test.ts` covering: priority > fallback, `matches()` for `kind: 'voice'` only, happy-path transcription (mocked OpenAI), missing/invalid `OPENAI_API_KEY`, and graceful failure.

The legacy `src/channels/whatsapp.ts` `isVoiceMessage`/`transcribeAudioMessage` path stays — the pipeline's `MEDIA_PIPELINE_ENABLED='1'` short-circuits before it when enabled.

## Phase 4: Verify

### Test with a voice note

Tell the user:

> Send a voice note in any registered WhatsApp chat. The agent should receive it as `[Voice: <transcript>]` and respond to its content.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i voice
```

Look for:
- `Transcribed voice message` — successful transcription with character count
- `OPENAI_API_KEY not set` — key missing from `.env`
- `OpenAI transcription failed` — API error (check key validity, billing)
- `Failed to download audio message` — media download issue

## Troubleshooting

### Voice notes show "[Voice Message - transcription unavailable]"

1. Check `OPENAI_API_KEY` is set in `.env` AND synced to `data/env/env`
2. Verify key works: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | head -c 200`
3. Check OpenAI billing — Whisper requires a funded account

### Voice notes show "[Voice Message - transcription failed]"

Check logs for the specific error. Common causes:
- Network timeout — transient, will work on next message
- Invalid API key — regenerate at https://platform.openai.com/api-keys
- Rate limiting — wait and retry

### Agent doesn't respond to voice notes

Verify the chat is registered and the agent is running. Voice transcription only runs for registered groups.

### Pipeline enabled but voice comes through as raw audio file

Handler priority is wrong. The `fallback` handler matches voice at priority 0 — your `voice-transcription` handler must register with priority ≥ 1 (recommended: 100) to win. Grep `src/media/handlers/voice-transcription.ts` for the `priority:` field, then confirm `registerMediaHandler(voiceTranscriptionHandler)` is called in `src/media/bootstrap.ts`.
