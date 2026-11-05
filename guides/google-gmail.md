---
name: google-gmail
description: "Gmail of the owner's Google account through the official Google Workspace CLI: run `gws gmail ...` in the shell to search, read and summarize mail; drafts, sending and label changes ask the owner first."
command: gws
connector: google
product: gmail
---

# Gmail (`gws gmail …`)

The owner connected their Google account in Mau. Run the official Google Workspace CLI from your
shell exactly as documented below: `gws gmail <resource> <method> [flags]` or a `+helper`.
Mau runs the command for you with the owner's authorization; you never handle Google credentials.

## How it works here

- `gws` in your shell forwards the command to Mau. Do not run `gws auth …`, look for tokens, or set
  `GOOGLE_*` variables — authentication is managed by Mau and those commands are refused.
- **Reads run immediately**: GET methods, `+triage`, `+read`, `--dry-run`, `gws gmail --help`,
  `gws schema gmail.<resource>.<method>`.
- **Writes wait for the owner**: sending, drafting, replying, forwarding, modifying labels,
  trashing. The owner sees the exact command on an approval card. The command blocks until they
  decide; keep waiting for its output. If it is declined, tell the owner and do not retry another way.
- If the owner's consent does not include an operation, the command fails with
  `google_scope_not_granted` before any card is shown. Tell the owner which permission is missing
  (the error lists it) — they can grant it in Mau's connector page.
- Not available: local files (`--upload`, `-a/--attach`, `-o/--output`), `+watch`, `--sanitize`.
  Pass attachments by asking the owner, or include a link in the body.
- Output over 60,000 characters is cut. Prefer `+triage` and `+read` over raw `users.messages.get`,
  and set `--params '{"maxResults": N}'` on lists.

## Helper commands

| Command | Description |
|---------|-------------|
| `+triage` | Show unread inbox summary (sender, subject, date). `--max N`, `--query '<gmail search>'`, `--labels` |
| `+read` | Read a message and extract its body or headers. `--id <ID>`, `--headers`, `--format json`, `--html` |
| `+send` | Send an email. `--to`, `--subject`, `--body` (required); `--cc`, `--bcc`, `--html`, `--draft` (save as draft instead) |
| `+reply` / `+reply-all` | Reply to a message (handles threading automatically) |
| `+forward` | Forward a message to new recipients |

Examples:

```bash
gws gmail +triage --max 10
gws gmail +triage --query 'from:boss newer_than:7d'
gws gmail +read --id 18f1a2b3c4d --headers
gws gmail +send --to alice@example.com --subject 'Hello' --body 'Hi Alice!' --draft
```

`+read` converts HTML-only messages to plain text. Newsletters whose content is only images have
little readable text; summarize from the subject and say so.

## Raw API methods

```bash
gws gmail users messages list --params '{"userId": "me", "q": "is:unread", "maxResults": 5}'
gws gmail users threads get --params '{"userId": "me", "id": "<THREAD_ID>", "format": "metadata"}'
gws gmail users labels list --params '{"userId": "me"}'
```

Resources under `users`: `messages`, `threads`, `drafts`, `labels`, `history`, `settings`, plus
`getProfile`. Before calling a method, inspect it:

```bash
gws gmail --help
gws schema gmail.users.messages.list
```

Use the schema to build `--params` (URL/query parameters) and `--json` (request body). Global flags:
`--format json|table|yaml|csv`, `--dry-run`, `--page-all` with `--page-limit N`.

## Rules

- Never print or forward message content to third parties unless the owner asked.
- Confirm recipients and content with the owner in conversation before a send; the approval card is
  the final check, not the only one.

<!-- Adapted from the googleworkspace/cli agent skills gws-shared, gws-gmail and gws-gmail-* (v0.22.5, Apache-2.0). -->
