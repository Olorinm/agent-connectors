---
name: feishu
description: "The owner's Feishu (Lark) through the official lark-cli: run `lark-cli ...` in the shell for messages, docs, calendar, sheets, tasks and more; reads run directly, changes ask the owner first."
command: lark-cli
connector: feishu
---

# Feishu (`lark-cli …`)

The owner connected their Feishu account in Mau. Run the official `lark-cli` from your shell as its
own documentation describes. Mau runs each command with the owner's authorization; you never handle
Feishu credentials.

## Learn the commands from the CLI itself

`lark-cli` embeds the official skills for its version. Start with:

```bash
lark-cli skills list                 # every domain skill with a one-line description
lark-cli skills read lark-shared     # shared concepts (identities, permissions) — read first
lark-cli skills read lark-im         # then the domain you need: lark-calendar, lark-doc, lark-base, …
lark-cli im --help                   # commands of a domain
lark-cli schema <service.resource.method>
```

These guidance commands never touch the owner's data.

## How it works here

- Commands run as the owner. Do not pass `--as`, `--profile` or `--user…`, and do not run
  `lark-cli auth …` or `config …`: identity and login are managed by Mau.
- **Reads run immediately** when the CLI declares the command read-only and its dry-run plan only reads.
- **Changes wait for the owner**: sending messages or mail, creating or editing documents, records,
  events, approvals. The owner sees the full command on an approval card; the command blocks until
  they decide. If it is declined, tell the owner and do not retry another way.
- Not available: local file paths (`@file`, `-`, absolute or `~` paths), `+watch` and `+subscribe`.
  Files the CLI produces are returned as attachments.
- If the owner's authorization lacks a permission, the command reports
  `feishu_personal_authorization_required` with an official link; pass it to the owner.
- Output over 500,000 characters is cut; use the CLI's paging and filter flags.
