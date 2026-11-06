# Changelog

Notable changes to Agent Connectors, newest first. Each version has a GitHub Release with the same
notes and the package archive. When releasing, add the new section here in the version-bump commit;
the Release notes are copied from it.

## [0.1.0-alpha.8] - 2026-11-05

- Google through the official Google Workspace CLI (`gws`).
  - `gws_read` and `gws_write` classify a command by its Discovery `httpMethod` and scopes, without
    needing credentials.
  - Operations the granted scopes don't cover are refused before any approval.
  - The token is passed only through `GOOGLE_WORKSPACE_CLI_TOKEN`.
- Agent guides for each connector (`guides/*.md`, exported as `./guides`), for Gmail (`gws`) and
  Feishu (`lark-cli`).

PR: [#9](https://github.com/Olorinm/agent-connectors/pull/9)

## [0.1.0-alpha.7] - 2026-11-05

- Removed the `business-data` read adapter. The Cloudflare read broker now serves Feishu reads
  only.

PR: [#8](https://github.com/Olorinm/agent-connectors/pull/8)

## [0.1.0-alpha.6] - 2026-11-05

- Gmail matches Google's Gmail MCP server. It has the same ten tools (`search_threads`,
  `get_thread`, `get_message`, `list_labels`, `list_drafts`, `create_draft`,
  `label/unlabel_thread`, `label/unlabel_message`), with the same inputs and descriptions word for
  word.
- Tools return shaped messages instead of raw Gmail API payloads: sender, recipients, decoded
  `plaintextBody`/`htmlBody`, attachment metadata and visible labels.
  - When a text part is only a placeholder, the HTML body is used instead.
  - Bodies are capped at 30k and threads at 120k.
  - Timestamps are ISO.
- Trash and spam labels, and draft attachments, are refused.
- New dependencies: `html-to-text`, `nodemailer`.

PR: [#7](https://github.com/Olorinm/agent-connectors/pull/7)

## [0.1.0-alpha.5] - 2026-11-04

- Browser: reading page state tolerates the navigation a form submit starts, instead of failing the
  click with `connector_unexpected_error`. Unexpected errors log their class and first line.
- Uploads accept MIME type parameters (such as `; charset=utf-8`) and strip them.

PRs: [#5](https://github.com/Olorinm/agent-connectors/pull/5), [#6](https://github.com/Olorinm/agent-connectors/pull/6)

## [0.1.0-alpha.4] - 2026-11-04

- Browser connector on Cloudflare Browser Run:
  - remote Chromium through the official Playwright CDP client;
  - sealed site cookies;
  - downloads through CDP Fetch;
  - handoff to the owner with Live View;
  - uploads approved per file and site.
- Authenticated MCP requests accept browser uploads up to 10 MB.

PR: [#4](https://github.com/Olorinm/agent-connectors/pull/4)

## [0.1.0-alpha.3] - 2026-10-30

- Trusted read-only composition: `ConnectorReadClient`, using short-lived signed read-only tokens.
- `startConfigured` composition.
- Optional wrapping of the envelope key with Cloudflare Worker Secrets.

PR: [#3](https://github.com/Olorinm/agent-connectors/pull/3)

## [0.1.0-alpha.2] - 2026-10-21

- Account connectors.
- Writes that need an approval bound to the exact operation.
- A scoped Cloudflare read broker.
