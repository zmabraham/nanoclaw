---
name: intercom
description: Escalate requests you cannot fulfill (calendar, email, approvals, tool access) to the main agent, and receive responses. Check inbox on every invocation.
---

# Intercom: Inter-Container Communication

The intercom is a filesystem-based mailbox for communicating with the main container through the host. You write JSON files to your outbox; the host validates, routes, and delivers responses to your inbox.

## Directory Layout

```
/workspace/ipc/intercom/
  outbox/    # Write requests here (host picks them up)
  inbox/     # Read responses and directives here (host delivers them)
```

You only interact with `outbox/` and `inbox/`. The host manages `expired/` and `errors/` — never write to those.

## Always Check Inbox First

At the start of **every invocation** — whether triggered by a chat message, a scheduled task, or an intercom inbox notification — check `/workspace/ipc/intercom/inbox/` for pending messages. This opportunistic check ensures intercom messages are picked up promptly even during chat-triggered invocations, without waiting for a dedicated intercom invocation.

Process pending messages in filename order (ascending) — filenames are `{epoch_ms}-{uuid}.json`, so alphabetical sort gives chronological order. Handle them before or after the primary task for this invocation.

After processing an inbox message, **delete the file** so you don't re-process it next time.

## Message Format

### Sending a Request (outbox)

Write a JSON file to `/workspace/ipc/intercom/outbox/` with any filename ending in `.json`:

```json
{
  "version": 1,
  "id": "<uuid>",
  "type": "escalation | query | directive_response | sync_session_request",
  "chat_id": "<channel-specific-chat-id>",
  "source_message_id": "<id-of-the-user-message-that-triggered-this>",
  "subject": "<short-topic-key>",
  "body": "<human-readable-request>",
  "requires_approval": false,
  "expects_response": true,
  "timeout_seconds": 3600,
  "expires_at": "2026-03-27T15:00:00Z"
}
```

**Required fields:**

| Field | Description |
|-------|-------------|
| `version` | Always `1` |
| `id` | A UUID you generate — used for deduplication |
| `type` | One of: `escalation`, `query`, `directive_response`, `sync_session_request` |
| `source_message_id` | ID of the user message that prompted this request — the host verifies trust from this. Find it in the `id` attribute of the `<message>` XML tag in your context (e.g., `<message id="ABC123" ...>`). Never fabricate this value; if you cannot find a message ID, do not send the intercom request. |
| `subject` | Short topic key (e.g., `calendar_booking`, `github_access`) |
| `body` | Human-readable description of the request |

> **Note:** You do not need to set `from_group` or `chat_id` — the host stamps `from_group` automatically. `chat_id` is optional context for main.

**Optional fields:**

| Field | Description |
|-------|-------------|
| `requires_approval` | `true` if this needs owner approval before main acts |
| `expects_response` | `true` if you'll wait for a response in your inbox |
| `timeout_seconds` | How long you'll wait for a response (informational to main) |
| `expires_at` | ISO timestamp when the message should be garbage-collected (default: 24h) |
### Message Types

- **`escalation`** — Ask main to perform a privileged action (e.g., book a meeting, grant repo access)
- **`query`** — Ask main a question and expect a response (e.g., "what's on my calendar?")
- **`directive_response`** — Reply to a directive you previously received from main
- **`sync_session_request`** — Request a real-time bidirectional session with main
- **`query_response`** — Reply to a query you received (produced by `send_intercom_response` tool — do not write manually)

### Sending a Response

When you receive a `query` message in your inbox with `expects_response: true`, reply using the `send_intercom_response` MCP tool. Do **not** write to the intercom outbox manually for responses — use the tool.

Parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `in_response_to` | yes | The `id` field from the inbox message you received |
| `status` | yes | `'completed'` (success) or `'error'` (failure) |
| `result` | no | Your answer / success text (for `status: completed`) |
| `reason` | no | What went wrong (for `status: error`) |
| `to_group` | no | Target group folder — defaults to `'main'` |

**Important:** The host relays your completion text to the group chat. To avoid broadcasting your answer, wrap all non-tool output in `<internal>...</internal>` tags when responding to intercom queries. Put the actual answer in the `result` parameter (or `reason` for errors), not in your completion text.

Delete the inbox file after calling this tool.

### Handling `private: true` Queries

When you receive a `query` in your inbox with `"private": true`:

1. **Do NOT call `send_message`** — do not post the query or any discussion of it in the group chat
2. **Wrap ALL output in `<internal>` tags** — the host relays your final completion text to the group chat unless it is wrapped in `<internal>...</internal>`. Any text outside these tags will be broadcast to the group, defeating the purpose of private mode.
3. Process the query using your own tools and knowledge
4. Reply using `send_intercom_response` with the inbox message's `id` as `in_response_to`
5. Delete the inbox file after responding

### Receiving `query_response` (inbox)

When you receive a `query_response` in your inbox (in reply to a `query` you sent with `expects_response: true`):

1. Match `in_response_to` to the `id` of your original query to confirm this is the response you're waiting for
2. Check `status`:
   - `'completed'` → read `result` to get the answer; continue your task
   - `'error'` → read `reason` to understand what failed; decide whether to retry or surface the error to the user
3. Delete the inbox file after processing

Fields on a received `query_response`: `id`, `type: 'query_response'`, `from_group`, `in_response_to`, `status` (`'completed'` | `'error'`), `result?`, `reason?`, `expires_at`.

### Reading Responses (inbox)

Inbox messages are JSON files with the same format. You may receive:

- **Responses to your requests** — look for `in_response_to` matching your original `id`
- **Directives from main** — `type: "directive"` with instructions for you to follow
- **Approval results** — `type: "approval_result"` with the outcome of an approval workflow
- **Errors** — `type: "error"` with `error` and `message` fields explaining what went wrong

Inbox-specific optional fields (set by main, not by you):

| Field | Description |
|-------|-------------|
| `private` | `true` if the query must not be relayed to the group chat — process silently and reply via `send_intercom_response` (see "Handling `private: true` Queries" below) |

### Error Responses

```json
{
  "version": 1,
  "id": "<uuid>",
  "type": "error",
  "in_response_to": "<your-original-message-id>",
  "error": "group_not_whitelisted | trust_verification_failed | ...",
  "message": "Human-readable explanation"
}
```

**Error codes:**

| Code | Meaning |
|------|---------|
| `group_not_whitelisted` | Your group is not on the intercom whitelist |
| `missing_source_message_id` | The `source_message_id` field was not set. Find the message ID in the `id` attribute of the `<message>` XML tag in your context |
| `trust_verification_failed` | The `source_message_id` could not be verified by the host |
| `unsupported_version` | Your `version` field is not recognized |
| `target_not_whitelisted` | The target group for a directive is not whitelisted |
| `unknown_query_reference` | The `in_response_to` ID is not in the host's processed-messages table; the referenced query was never delivered or its record has expired (default retention: 30 days) |

## Approval Result Messages

When main processes an escalation with `requires_approval: true`, the result arrives in your inbox as an `approval_result` message:

### Approved

```json
{
  "version": 1,
  "id": "<uuid>",
  "type": "approval_result",
  "in_response_to": "<your-original-escalation-uuid>",
  "to_group": "<your-group-folder>",
  "status": "approved",
  "result": "Meeting booked with Mendy tomorrow at 3pm",
  "modified": false
}
```

- `in_response_to` matches the `id` of your original escalation
- `modified` is `true` if the owner changed something (e.g., "y but make it 4pm")
- `result` contains a human-readable description of what was done

### Rejected

```json
{
  "version": 1,
  "id": "<uuid>",
  "type": "approval_result",
  "in_response_to": "<your-original-escalation-uuid>",
  "to_group": "<your-group-folder>",
  "status": "rejected",
  "reason": "Owner declined the request"
}
```

### Handling Approval Results

When you receive an `approval_result` in your inbox:

1. **Match it** to your original escalation via `in_response_to`
2. **On `approved`**: Inform the chat that the action was completed. Include the `result` text.
3. **On `rejected`**: Inform the chat the request was declined. Include the `reason` if present.
4. **Late results**: If you previously timed out waiting for a response, the result may arrive on a later invocation. Inform the chat with an update (e.g., "Update: that meeting was booked after all"). Late results are normal — always process them.
5. **Delete the inbox file** after processing.

### Auto-Approved Subjects

Some subjects may be auto-approved by the owner for your group. When a subject is auto-approved, main performs the action immediately without asking the owner — so you may receive an `approval_result` much faster than usual. This is transparent to you: you still write escalations to your outbox and read results from your inbox the same way. You don't need to know which subjects are auto-approved.

## Pending Approvals State (Main Only)

Main tracks pending approvals in `/workspace/pending-approvals.json`:

```json
{
  "pending": [
    {
      "intercom_id": "uuid",
      "from_group": "whatsapp_family-chat",
      "subject": "calendar_booking",
      "body": "Book a meeting with Mendy tomorrow at 3pm",
      "requester": "owner",
      "received_at": "2026-03-27T14:00:00Z",
      "presented_to_owner": true,
      "list_number": 1
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `intercom_id` | The `id` from the original escalation message |
| `from_group` | Which group folder the request came from |
| `subject` | Short topic key from the escalation |
| `body` | Human-readable request description |
| `requester` | `owner` or the member's identity |
| `received_at` | ISO timestamp when the request was received |
| `presented_to_owner` | Whether the owner has been shown this request |
| `list_number` | Position in the numbered list (when multiple are pending) |

Main reads this file on every invocation, updates it after presenting approvals or receiving owner responses, and removes entries once resolved. The file lives in main's workspace and persists across invocations.

### Late Approval Handling

Approval requests have no default timeout — they persist until the owner responds or `expires_at` is reached. The `timeout_seconds` field in the original escalation only controls how long the *group container* waits, not how long the owner has to decide. Main always writes results to its outbox regardless of timing. The host delivers them, and the group container processes them on its next invocation.

## Sync Sessions (Real-Time Bidirectional Communication)

For tasks that need low-latency back-and-forth with main (e.g., complex multi-step coordination), you can request a sync session instead of using the async mailbox.

### Requesting a Sync Session

Write a `sync_session_request` to your outbox:

```json
{
  "version": 1,
  "id": "<uuid>",
  "type": "sync_session_request",
  "chat_id": "<channel-specific-chat-id>",
  "source_message_id": "<id-of-the-owner-message-that-triggered-this>",
  "subject": "<short-topic-key>",
  "body": "<description-of-what-the-session-is-for>",
  "timeout_seconds": 120
}
```

**Requirements:**
- The `source_message_id` must trace back to an **owner** message (member messages are rejected)
- Your group must have `sync_sessions: true` in the whitelist
- Only one sync session per group can be active at a time

### Receiving `sync_session_ready`

After writing the request, poll your inbox for a `sync_session_ready` message:

```json
{
  "type": "sync_session_ready",
  "session_id": "<uuid>",
  "socket_path": "/workspace/ipc/intercom/session-<id>.sock"
}
```

If the request is rejected, you'll receive an `error` message instead (e.g., `owner_trust_required`, `sync_sessions_not_allowed`, `session_already_active`).

### Connecting to the Socket

Connect to the Unix socket at the provided `socket_path`. The host is listening on both ends — you connect as a client.

### Message Format

Exchange **newline-delimited JSON** over the socket. Each line is a complete JSON object with a required `type` field:

```
{"type": "text", "body": "I need to book a meeting with Mendy"}
{"type": "result", "subject": "calendar_booking", "data": {"time": "3pm", "confirmed": true}}
{"type": "session_end"}
```

- The `type` field is **required** on every message
- Beyond `type`, the schema is freeform — negotiate structure with main during the conversation
- No `version` field needed (the session was established under a known protocol version)
- Each line must be valid JSON terminated by `\n`

### Session Lifecycle

| Event | Behavior |
|-------|----------|
| **Timeout** | The host kills the session after `timeout_seconds` (default 120s) |
| **Graceful close** | Either side sends `{"type": "session_end"}` |
| **Socket breaks** | The host tears down the session and writes `session_terminated` to your inbox |

When a session ends (for any reason), you receive a `session_terminated` message in your inbox:

```json
{
  "type": "session_terminated",
  "session_id": "<uuid>",
  "reason": "timeout | connection_lost | proxy_error | graceful_close",
  "transcript_file": "<timestamp>-<session-id>.json"
}
```

A transcript of all exchanged messages is also written to your inbox so the next invocation has context if a retry is needed.

### When to Use Sync vs Async

| Use Case | Recommended |
|----------|-------------|
| Simple request/response (e.g., "what's on my calendar?") | Async (`query`) |
| Action with approval (e.g., "book a meeting") | Async (`escalation`) |
| Multi-step coordination (e.g., iterative planning) | **Sync session** |
| Real-time data exchange (e.g., streaming results) | **Sync session** |

## Non-goals

- Not a real-time channel — messages are async; check inbox on next invocation, not immediately after sending
- Not for messaging the user directly — use `mcp__nanoclaw__send_message` for that
- Cannot contact groups not on the intercom whitelist — attempts will return a `group_not_whitelisted` error

## Important Rules

1. **Never fabricate `source_message_id`** — the host verifies it against its own message store. Use the actual message ID from the user message that triggered your request.
2. **Set `expires_at`** — messages without it default to 24 hours. Set a longer TTL for requests that take time to resolve.
3. **Responses are not instant** — main processes your request asynchronously. Write to outbox, then either continue your current task or exit. Check inbox on your next invocation.
4. **Delete inbox files after processing** — the host does not remove them for you. Undeleted files will eventually be garbage-collected when they expire.
5. **Do not retry blindly** — if you get an error response, read it and decide whether retrying makes sense. The host does not retry for you.
6. **Reply to queries with `send_intercom_response`, not `send_message`.** When you receive a `query` with `expects_response: true`, use the `send_intercom_response` MCP tool to reply through the intercom system. Using `send_message` posts your answer to the group chat instead of routing it back to the requester.
