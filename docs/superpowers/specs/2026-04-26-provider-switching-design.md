# Provider Switching: Claude ↔ ZAI with Auto-Failover

## Problem

NanoClaw needs to run against two Anthropic-compatible API providers (Claude/Anthropic and ZAI/GLM) and automatically switch when rate limits are hit.

## Context

- ZAI (`api.z.ai/api/anthropic`) is an Anthropic-compatible endpoint serving GLM models
- Both providers use the same API protocol — only base URL, credentials, and model names differ
- The credential proxy already supports any base URL via `ANTHROPIC_BASE_URL`
- The agent SDK reads model names from `ANTHROPIC_DEFAULT_MODEL` env vars

## Design

### 1. Environment Configuration

Add to `.env`:

```
PROVIDER_PRIMARY=claude          # "claude" or "zai"

# Claude credentials (already exists)
CLAUDE_CODE_OAUTH_TOKEN=...

# ZAI credentials
ZAI_API_KEY=<key>
ZAI_BASE_URL=https://api.z.ai/api/anthropic
ZAI_DEFAULT_MODEL=glm-4.5-air
ZAI_DEFAULT_HAIKU_MODEL=glm-4.5-air
ZAI_DEFAULT_SONNET_MODEL=glm-4.7
ZAI_DEFAULT_OPUS_MODEL=glm-5

# Failover cooldown after 429 (ms)
PROVIDER_FAILOVER_COOLDOWN=300000
```

### 2. Credential Proxy — Dual-Provider Routing

**File:** `src/credential-proxy.ts`

On startup, load both credential sets. Track `activeProvider` (initially `PROVIDER_PRIMARY`).

Per-request behavior:
1. Route to active provider's base URL with its credentials
2. If upstream returns HTTP 429: switch to the other provider, set cooldown timer, retry the same request
3. After cooldown expires, revert to `PROVIDER_PRIMARY`
4. Log all provider switches

### 3. Container Runner — Model Name Passthrough

**File:** `src/container-runner.ts`

When spawning a container, detect the active provider and set model env vars accordingly:
- Claude: pass host's `ANTHROPIC_DEFAULT_*` if set, otherwise let SDK use built-in defaults
- ZAI: pass `glm-*` model names from config

### 4. Config — New Env Vars

**File:** `src/config.ts`

Add to env allowlist: `PROVIDER_PRIMARY`, `PROVIDER_FAILOVER_COOLDOWN`, `ZAI_API_KEY`, `ZAI_BASE_URL`, `ZAI_DEFAULT_MODEL`, `ZAI_DEFAULT_HAIKU_MODEL`, `ZAI_DEFAULT_SONNET_MODEL`, `ZAI_DEFAULT_OPUS_MODEL`.

### Files Changed

| File | Change |
|------|--------|
| `src/config.ts` | Read new env vars |
| `src/credential-proxy.ts` | Dual-provider routing + 429 failover |
| `src/container-runner.ts` | Pass active provider's model names |
| `.env` | Add ZAI credentials and provider config |

No changes to `container/agent-runner/` — it already reads model env vars.
