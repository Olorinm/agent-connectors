---
name: agent-browser
description: "The owner's remote browser through the official agent-browser CLI: run `agent-browser ...` in the shell to open pages, take snapshots, click, type, screenshot and download; uploading a file asks the owner first."
command: agent-browser
connector: browser
---

# Browser (`agent-browser …`)

The owner gave you a remote browser in Mau (Cloudflare Browser Run). Drive it with the official
[agent-browser](https://github.com/vercel-labs/agent-browser) CLI from your shell, in its own syntax.
Mau runs each command in the owner's browser; you never handle its credentials, and sign-ins the owner made
stay in that browser between commands and sessions.

## Learn the commands from the CLI itself

```bash
agent-browser skills get core            # the official usage guide: snapshot/ref workflow, commands, patterns
agent-browser skills get core --ref commands
agent-browser click --help               # usage of one command
```

The usual loop:

```bash
agent-browser open https://example.com
agent-browser snapshot -i                # interactive elements with refs such as @e1
agent-browser click @e2
agent-browser fill @e3 "text"
agent-browser snapshot -i                # refs change when the page changes; take a new snapshot
```

## How it works here

- One browser, one active tab: commands run in order. There is no `--session`, `--profile`, `--cdp` or other
  global flag except `--json`; the connection is chosen by Mau.
- **Run directly**: navigation (`open`, `back`, `tab new <url>`, …), `snapshot`, `get`, `is`, `find`, `wait`,
  clicks, typing, keys, scrolling, `select`, `frame`, `dialog`, `set viewport|device|media`, `read` (current
  page), `screenshot`, `pdf`, `download`, `close`.
- **Asks the owner** unless they allowed it: `agent-browser upload <file-input> <file...>` sends workspace files to the current site.
  The owner sees the files and the site on an approval card; the command waits for the decision. If it is
  declined, tell the owner and do not retry another way. Target the file input itself (its ref, or a CSS
  selector such as `"input[type=file]"`).
- The owner can set each operation to run directly, to ask every time, or to not allowed. A refused one
  fails with `connector_operation_denied`; do not work around it, tell the owner if you need it. In scheduled
  or delegated work, operations that ask fail with `connector_operation_requires_approval`.
- **Not available**: `cookies`, `storage`, `state`, `auth`, `eval` and other page JavaScript, `network`,
  `set headers|credentials`, `connect`, `close --all`, `install`, `batch`, `stream`, `dashboard`. Do not try to read
  cookies or tokens from pages.
- Files: `screenshot`, `pdf` and `download` save into `browser_downloads/` in your working directory and print
  the saved path. `download <element> <name>` clicks the element and captures what it downloads: a link (also on
  another site), a form that posts a download, or a file a script generates.
- Local and private addresses (`localhost`, `10.x`, `192.168.x`, metadata endpoints) and non-http(s) URLs are
  refused, also when a click, a new tab or a redirect leads there (the page shows "blocked").
- `close` disconnects and keeps the sign-ins; the next command reconnects.

## When the owner must take over

For a login, CAPTCHA or a choice only the owner can make, call the `connected_apps` tool with the browser
connection's `handoff_start` operation (`instructions`, optional `timeoutSeconds`). The owner privately receives a
live view of the current tab with your instructions and Done/Failed buttons; you receive only the handoff ID. Check
`handoff_status` every so often (or when the owner says they are done): `done: true` with `success` tells you they
pressed Done or Failed. Then run `agent-browser snapshot -i` again: the page may have changed. `handoff_cancel` ends
it early.
