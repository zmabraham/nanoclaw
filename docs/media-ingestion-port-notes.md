# Media-Ingestion Port — Notes

This branch (`skill/media-ingestion`) ports the channel-agnostic media
processing pipeline from `jonazri/skill/media-ingestion` onto ChabadLabs/GabAI.

## What's on this branch

Core module (channel-agnostic, drop-in):

- `src/media/types.ts` — MediaKind, MediaRef, MediaHandler, ProcessedMedia, ProcessedAttachmentSummary
- `src/media/registry.ts` — handler registry with priority collision detection
- `src/media/pipeline.ts` — concurrent processor (semaphore, timeout, size cap, single-writer FS, path containment)
- `src/media/marker-parser.ts` — `[attachments:...]` marker parser with containment check
- `src/media/rotation.ts` — attachment dir rotation with hysteresis & hard ceiling
- `src/media/bootstrap.ts` — startup env-audit and pipeline-vs-legacy log line
- `src/media/handlers/fallback.ts` — last-resort handler for voice/video/audio with `mime-types`

Plus extensive unit tests (`*.test.ts`) and a pipeline integration test.

Surface tweaks needed by every channel that wants to participate:

- `src/types.ts` — adds `attachments?: ProcessedAttachmentSummary[] | null` on
  `NewMessage`, plus the new `OnMessageReceived(chatJid, message, mediaRefs)`
  callback type. `OnInboundMessage` is preserved as an alias for backward
  compat (no breakage for existing channel skills).
- `src/channels/registry.ts` — `ChannelOpts` gains optional `onMessageReceived`
  next to the legacy `onMessage`.
- `src/config.ts` — adds `MEDIA_PIPELINE_ENABLED`, `MEDIA_MAX_BYTES`,
  `MEDIA_MAX_AGGREGATE_BYTES`, `MEDIA_RETAIN_FILES`, `MEDIA_MAX_FILES`,
  `MEDIA_REFERENCE_FLOOR_HOURS`, `MEDIA_PIPELINE_MAX_CONCURRENCY`,
  `LATE_FINALIZE_*` tunables. All env-allowlisted.
- `src/env.ts` — adds `registerEnvAllowlist()` + `auditEnvAllowlist()` so
  modules outside config can declare their `.env` keys.
- `package.json` — adds `mime-types` (and `@types/mime-types`).

Default state: `MEDIA_PIPELINE_ENABLED` defaults to `'0'`, so merging this
skill is a no-op until an operator opts in. Channel skills that don't know
about `onMessageReceived` keep working through the `onMessage` legacy path.

## What's intentionally not on this branch

These pieces of jonazri's branch were excluded because they're either
(a) gabay-specific customizations or (b) couplings to other skills that
must be installed separately:

- `src/db.ts` migration for `attachments`/`media_status`/`media_ready_at` —
  jonazri's version is entangled with `intercom` (`isOwnerSender`,
  `intercom_processed` table, `trust_tier` column) and `whatsapp-replies`
  (`replied_to_*` columns). Splitting this cleanly requires a
  `media-ingestion-db` follow-up skill that depends only on the columns
  above.
- `src/group-queue.ts` two-phase host handler / dual-cursor polling /
  late-finalize retry — relies on the DB migration and the
  `lifecycle-hooks` `OnMessageReceived` plumbing. Belongs in a follow-up
  `media-ingestion-host` skill.
- `src/index.ts` rotation startup sweep, agent-runner attachment
  serialization (`mediaAttachments` on `ContainerInput`, `pushMultimodal`),
  and `container/agent-runner/src/index.ts` multimodal content blocks.
  Same reason — depends on `lifecycle-hooks` + the DB skill.
- WhatsApp-specific media detection (`src/channels/whatsapp.ts` legacy-voice
  flag guard, non-file-media serialization) — belongs on
  `nanoclaw-whatsapp` (the channel fork), not on this skill branch.
- `src/owner-identity.ts`, `src/voice-recognition.ts`, `src/transcription.ts`,
  aifs-wiki, whatsapp-contacts, akiflow, gist, google-home,
  voice-transcription-elevenlabs — all out of scope.

## SKILL.md modifications (applied)

The three upstream media skill docs now route through media-ingestion when it's installed. Each has:
- A top-of-file callout describing the "route through media-ingestion" path.
- An "If media-ingestion is also installed" subsection inside Phase 2 with the
  concrete steps to register the per-skill `MediaHandler` (handler file path,
  `matches()` condition, priority, marker format, required `outputMimetype` for
  image→JPEG transcode).
- A new troubleshooting bullet about handler registration (including the
  priority-> fallback interaction for voice-transcription).

Touched files:
- `.claude/skills/add-pdf-reader/SKILL.md`
- `.claude/skills/add-image-vision/SKILL.md`
- `.claude/skills/add-voice-transcription/SKILL.md`

The legacy WhatsApp-only path remains intact for users who don't install
media-ingestion.

## Follow-on skills to design (out of scope for this branch)

- `media-ingestion-db` — adds `attachments`, `media_status`, `media_ready_at`
  columns + `idx_messages_media_ready_at` partial index + crash-recovery sweep.
  Depends on `media-ingestion`.
- `media-ingestion-host` — wires the pipeline into `src/index.ts` (rotation
  sweep, two-phase handler), `src/group-queue.ts` (dual-cursor), and
  `container/agent-runner/src/index.ts` (multimodal). Depends on
  `media-ingestion-db` + `lifecycle-hooks`.
- Channel-side handler skills — one per channel that wants to surface
  media (e.g. `whatsapp-media-refs`, `telegram-media-refs`). These call
  `onMessageReceived(chatJid, msg, mediaRefs)` with channel-decoded
  `MediaRef`s instead of the old `onMessage`.

The marketplace catalog currently lists `voice-transcription` with no
dependency. Once `media-ingestion` is published, the catalog adds
`"depends": ["media-ingestion"]` to enforce install order.
