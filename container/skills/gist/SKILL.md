---
name: gist
description: Share files with users by creating GitHub Gists and returning URLs. Use when you need to share code, configs, reports, or any file content that is too large or complex for a chat message.
allowed-tools: Bash(gist *)
---

# Gist — GitHub Gist File Sharing

Share files with users by creating GitHub Gists and returning URLs. Manage gists (view, edit, delete, clone) via the `gist` CLI tool, which proxies operations through the host's authenticated `gh` CLI.

## Usage

```bash
# Create a gist from one or more files (returns URL)
gist create report.md --description "Weekly report"
gist create config.yaml main.py --description "Project files"

# View gist contents
gist view <gist_id>

# Edit/update a gist
gist edit <gist_id> updated-file.txt --description "New description"

# Clone gist files to /workspace/group/
gist clone <gist_id> my-gist

# List recent gists
gist list --limit 5

# Delete a gist
gist delete <gist_id>
```

## Notes

- Gists are **private** by default. Pass `--public` to `create` for public gists.
- The gist URL is what you send to the user — it provides syntax highlighting, raw download, and GitHub's native viewer.
- Operations are proxied through the host via IPC. Expect ~1-2 second latency.
- `clone` downloads gist files into the group's workspace where you can read and modify them.
- `delete` is restricted to the **main group only**. To delete a gist from a non-main container, send an intercom escalation to main requesting the deletion.
