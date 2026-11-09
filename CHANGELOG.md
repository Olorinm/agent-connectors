# Changelog

Notable changes to Agent Connectors, newest first. Each version has a GitHub Release with the same
notes and the package archive. When releasing, add the new section here in the version-bump commit;
the Release notes are copied from it.

## [0.1.0-alpha.11] - 2026-11-09

- Owner operation policy per connection: every operation can be set to `allow` (runs directly, writes included),
  `ask` (approval for every call, reads included) or `deny` (not listed and refused with
  `connector_operation_denied`). Defaults: reads allow, writes ask. Settings are stored per connection, survive
  disconnect and reconnect, apply from the next call and never change tool names or schemas.
  - `GET|PUT /v1/connections/:id/policy` and `POST /v1/connections/:id/policy/reset` (service token).
  - Catalogs: Gmail (read, write and delete groups; unsupported unsubscribe and background sync are listed as
    such), Feishu (docs, calendar, messages, other; read and write each), browser (navigate, read, interact,
    download, upload). Other connectors get one read and one write operation.
  - gws calls resolve to the operation of their Discovery method, lark-cli calls to their domain, agent-browser
    calls to their command; help, schemas and dry runs are outside the policy.
  - Read-only callers get `connector_operation_requires_approval` for operations set to ask.
  - An approval is refused when its operation was denied in the meantime.
- Operations whose scopes are not granted are reported `scope_required`; Google can add them with incremental
  consent (`POST /v1/connections/:id/connect` with `{ "scopes": [...] }`, limited to the catalog's grant scopes),
  keeping the current authorization until the new consent completes.
- Account status reports `accountEmail` (Gmail profile) and `accountName` (Feishu), and keeps a pending Google
  consent link (`authorizationUrl`, `expiresAt`) while it is valid.

## [0.1.0-alpha.10] - 2026-11-09

- Browser connector runs the official agent-browser CLI (`agent-browser` 0.41.2, pinned) against Cloudflare Browser
  Run, replacing the Playwright tools (`open`, `snapshot`, `click`, `type`, `press`, `screenshot`, `download`,
  `upload`, `close`). `playwright-core` is no longer a dependency.
  - `agent_browser_read` takes agent-browser arguments and runs an allowlist of commands; credentials, page
    JavaScript, traffic interception, other browsers and global flags other than `--json` are refused.
  - `agent_browser_write` runs `upload`, approved per file and site.
  - `screenshot`, `pdf` and `download` return files; output paths stay in a private per-call directory.
  - Cookies and local storage are saved with `state save` after every command and sealed; a new remote browser
    restores them with `state load`.
  - A minimal CDP connection to the same Browser Run session (Node's WebSocket, no new dependency) covers what
    agent-browser cannot do against a remote browser: it refuses document requests to private, loopback, link-local
    and non-http(s) addresses (including clicks, new tabs, form posts and redirects), captures downloads (links on
    any site, form posts, script-generated files) because Browser Run keeps downloaded files on its own machine, and
    runs Cloudflare's structured handoff.
  - Handoff shows the instructions with Done/Failed in the live view; `handoff_status` reports `done` and `success`;
    `handoff_cancel` closes the tab.
  - The Docker image keeps only its platform's agent-browser binary.
- Agent guide for the browser connector (`guides/browser.md`, command `agent-browser`).

## [0.1.0-alpha.9] - 2026-11-06

- Feishu owner tools on a product-provided app (the same app a chat channel's bot uses).
  - `POST /v1/connections/:id/application` installs `appId`, app secret, domain and owner `open_id`; the secret is
    never returned. Same app and owner keep the authorization; a different one resets it.
  - `POST /v1/connections/:id/complete` finishes the owner's device-flow authorization.
  - Status `expired` with `reason` (`refresh_token_expired`, `token_revoked`, `authorization_lost`) and
    `authorization_pending` with the consent link.
  - Tool errors for missing or expired authorization carry `state`, a re-authorization message and the consent link.
  - Connection listings include `usage: "owner_private"` so products can admit these tools only in the owner's
    private conversation.

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
