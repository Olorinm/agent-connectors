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
- **Changes wait for the owner** unless they allowed them: sending messages or mail, creating or editing documents, records,
  events, approvals. The owner sees the full command on an approval card; the command blocks until
  they decide. If it is declined, tell the owner and do not retry another way.
- The owner can set each operation to run directly, to ask every time, or to not allowed. A refused one
  fails with `connector_operation_denied`; do not work around it, tell the owner if you need it. In scheduled
  or delegated work, operations that ask fail with `connector_operation_requires_approval`.
- Not available: local file paths (`@file`, `-`, absolute or `~` paths), `+watch` and `+subscribe`.
  Files the CLI produces are returned as attachments.
- If the owner's authorization is missing, expired or lacks a permission, the command reports
  `feishu_personal_authorization_required` with `state` (`authorization_required`, `expired`, `scope_required`),
  a message and an official link. Tell the owner it needs re-authorization (需要重新授权) and pass the link,
  or ask them to use 飞书 → 重新授权 in Mau. Never ask for tokens in chat.
- These tools act as the owner, so Mau offers them only in the owner's private conversation with you.
- Output over 500,000 characters is cut; use the CLI's paging and filter flags.
