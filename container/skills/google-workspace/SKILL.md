---
name: google-workspace
description: Access Google Drive, Gmail, Calendar, Sheets, Docs, Chat, and all Workspace services using the `gws` CLI. Use for reading/sending emails, managing files, calendar events, spreadsheets, and any Google Workspace operations.
allowed-tools: Bash(gws*)
---

# Google Workspace CLI (gws)

One CLI for all Google Workspace services. All responses are structured JSON.

## Quick start

```bash
# Drive: list files
gws drive files list --params '{"pageSize": 10}'

# Gmail: list recent emails
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'

# Calendar: list events
gws calendar events list --params '{"calendarId": "primary", "maxResults": 10}'

# Sheets: read data
gws sheets spreadsheets values get --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:D10"}'
```

## Prerequisites

The required Google APIs must be enabled in your GCP project. If you get "API not enabled" errors, visit the URL in the error message to enable the API, wait a few seconds, then retry.

---

## Google Drive

### List and search files

```bash
# List recent files
gws drive files list --params '{"pageSize": 20}'

# Search by name
gws drive files list --params '{"q": "name contains '\''report'\''"}'

# Search folders only
gws drive files list --params '{"q": "mimeType = '\''application/vnd.google-apps.folder'\''"}'

# Files in a specific folder
gws drive files list --params '{"q": "'\''<folderId>'\'' in parents"}'
```

### Download and export

```bash
# Download a file
gws drive files get --params '{"fileId": "<id>", "alt": "media"}' > file.txt

# Export Google Doc as plain text
gws drive files export --params '{"fileId": "<id>", "mimeType": "text/plain"}'

# Export Google Sheet as CSV
gws drive files export --params '{"fileId": "<id>", "mimeType": "text/csv"}'
```

### Upload files

```bash
# Simple upload
gws drive files create --json '{"name": "report.pdf"}' --upload ./report.pdf

# Upload to specific folder
gws drive files create --json '{"name": "doc.txt", "parents": ["<folderId>"]}' --upload ./doc.txt
```

### Common MIME types

| Type | MIME |
|------|------|
| Google Doc | `application/vnd.google-apps.document` |
| Google Sheet | `application/vnd.google-apps.spreadsheet` |
| Google Slides | `application/vnd.google-apps.presentation` |
| Folder | `application/vnd.google-apps.folder` |

---

## Gmail

### List and search emails

```bash
# Recent emails
gws gmail users messages list --params '{"userId": "me", "maxResults": 20}'

# Search emails
gws gmail users messages list --params '{"userId": "me", "q": "from:boss@company.com"}'

# Unread emails
gws gmail users messages list --params '{"userId": "me", "q": "is:unread"}'
```

### Read an email

```bash
# Get full message
gws gmail users messages get --params '{"userId": "me", "id": "<messageId>"}'

# Get just the headers
gws gmail users messages get --params '{"userId": "me", "id": "<messageId>", "format": "metadata"}'
```

### Send an email

```bash
# Send plain text
gws gmail users messages send --params '{"userId": "me"}' --upload - <<EOF
From: me@gmail.com
To: recipient@example.com
Subject: Test email

This is the body of the email.
EOF
```

### Manage labels

```bash
# List labels
gws gmail users labels list --params '{"userId": "me"}'

# Add label to message
gws gmail users messages modify --params '{"userId": "me", "id": "<messageId>"}' --json '{"addLabelIds": ["Label_1"]}'
```

---

## Google Calendar

### List events

```bash
# Upcoming events
gws calendar events list --params '{"calendarId": "primary", "maxResults": 20}'

# Events in date range
gws calendar events list --params '{"calendarId": "primary", "timeMin": "2024-01-01T00:00:00Z", "timeMax": "2024-01-31T23:59:59Z"}'
```

### Create event

```bash
gws calendar events insert --params '{"calendarId": "primary"}' --json '{
  "summary": "Team meeting",
  "start": {"dateTime": "2024-01-15T10:00:00", "timeZone": "America/New_York"},
  "end": {"dateTime": "2024-01-15T11:00:00", "timeZone": "America/New_York"}
}'
```

### Update and delete

```bash
# Update event
gws calendar events update --params '{"calendarId": "primary", "eventId": "<id>"}' --json '{"summary": "Updated title"}'

# Delete event
gws calendar events delete --params '{"calendarId": "primary", "eventId": "<id>"}'
```

---

## Google Sheets

### Read data

```bash
# Read a range
gws sheets spreadsheets values get --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:D10"}'

# Read entire sheet
gws sheets spreadsheets values get --params '{"spreadsheetId": "<id>", "range": "Sheet1"}'
```

### Write data

```bash
# Append rows
gws sheets spreadsheets values append \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Alice", 95], ["Bob", 87]]}'

# Update cells
gws sheets spreadsheets values update \
  --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:B2", "valueInputOption": "USER_ENTERED"}' \
  --json '{"values": [["Name", "Score"], ["Charlie", 92]]}'
```

### Clear data

```bash
gws sheets spreadsheets values clear --params '{"spreadsheetId": "<id>", "range": "Sheet1!A1:Z100"}'
```

---

## Google Docs

```bash
# Get document content
gws docs documents get --params '{"documentId": "<id>"}'

# Note: For reading text, export via Drive is usually easier:
gws drive files export --params '{"fileId": "<id>", "mimeType": "text/plain"}'
```

---

## Google Chat

```bash
# List spaces
gws chat spaces list

# Send message
gws chat spaces messages create \
  --params '{"parent": "spaces/SPACE_ID"}' \
  --json '{"text": "Hello from the bot!"}'
```

---

## Advanced Usage

### Pagination

```bash
# Auto-paginate all results (NDJSON stream)
gws drive files list --page-all | jq -r '.files[].name'

# Limit pages
gws drive files list --page-limit 5
```

### JSON output and jq

```bash
# Extract specific fields
gws drive files list | jq '.files[] | {id, name, mimeType}'

# Count results
gws gmail users messages list --params '{"userId": "me"}' | jq '.messages | length'
```

### Introspect API schemas

```bash
# See available parameters for a method
gws schema drive.files.list

# See request/response structure
gws schema gmail.users.messages.send
```

---

## Tips

- All commands accept `--params '<json>'` for query parameters
- Use `--json '<json>'` for request body
- Use `gws <service> --help` to explore sub-commands
- Use `gws schema <method>` to see parameter/field names
- Pipe to `jq` for parsing JSON output
