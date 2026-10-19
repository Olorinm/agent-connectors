# Feishu connector

Feishu/Lark through the official [lark-cli](https://github.com/larksuite/cli) (pinned `@larksuite/cli@1.0.97`),
acting as the linked owner's user identity.

## Tools

| Tool | Risk | Runs |
| --- | --- | --- |
| `cli_read` | read | Only commands that pass both read checks below, plus guidance (`schema …`, `skills list/read …`, `<domain> … --help`) |
| `cli_write` | write | Any allowed command, after the owner approves the exact arguments |

Arguments are lark-cli argument strings without the executable, e.g. `["mail", "+triage", "--query", "发票"]`.
Files for upload go in `files: [{ name, contentBase64 }]` and are referenced by name.

## How risk is decided

The CLI declares `read`, `write` or `high-risk-write` for each command. The connector asks it, for the exact
argument list, with `--help=true` inserted right after the domain, using an **unconfigured** CLI (empty config
and data directories, no app, no user token). A command with no declared risk — unknown, or an argument list
the CLI cannot parse — is never treated as read. Notable declarations: `mail +send` and `im +messages-send`
are `write`; `api` is `write` for every method.

The declaration alone is not enough: some commands declared `read` still change server state (`mail +watch`
subscribes, `base +record-share-link-create` creates share links, `apps +file-sign` issues download URLs, exports
and screenshots create tasks). So a read must also pass a second check: its official `--dry-run` plan, produced
by a placeholder app with no user and all proxies pointed at a closed local port, may contain only `GET` requests
and `POST` to read-only endpoints (`…/search`, `batch_get`, `batch_query`, `mget`, `query`, `fetch`). Anything
else goes to `cli_write`. A plan describes the requests the CLI intends; commands whose later steps depend on
responses are judged by their first steps, which is why non-GET requests are refused by default.

Guidance requests are answered from the unconfigured CLI with only the command path; the Agent's argument list
is not executed for them.

On execution the connector inserts `--profile=<app>` and `--as=user` right after the domain (and `--yes=true`
for an approved `high-risk-write`). Flags in `--name=value` form at that position cannot be taken as the value
of an Agent-supplied flag. Agents cannot pass `--as`, `--profile`, `--user*`, `--config`, `--app-id`, or
`--help=` / `--yes=` values. Management commands (`auth`, `config`, `profile`, `update`, `event`, …) and long-running `+watch`/`+subscribe`
commands are refused.

Neither tool accepts arguments that reach the connector host's files: `@file` expansion, `-` (stdin), absolute,
`~`, or `..` paths, including `--flag=value` forms (the `api` path argument is exempt). Files are exchanged only
through `files` and the per-call directory. Each account runs with its own empty `HOME`, stdin is closed, and
commands time out after 60 seconds. Keep the service's state, keys and Feishu directories out of `/tmp` and
`~/files`, which the CLI otherwise treats as allowed roots.

Each call runs in a new private directory under the connection's `workspace/`, removed afterwards. Files the CLI
reports saving inside it are returned (up to 10 MB total); paths outside it are ignored.

Exit status: errors the CLI reports before any request (`validation`, `authentication`, `authorization`,
confirmation required) are `failed`; any other failure of a write is `uncertain`.

## Connection

```json
{ "id": "work-feishu", "kind": "feishu", "owner": "@alice:router.example", "settings": { "directory": "feishu/alice" } }
```

`directory` (relative to the configuration file) is the private directory created by Router's
`npm run feishu:setup` — `credentials.json`, `app-secret`, `lark-cli/`, `cli-data/`. An existing Router directory
can be moved here unchanged; afterwards remove `personalTools` from Router's channel connection.

Storage note: lark-cli keeps the app secret and the owner's OAuth tokens in that directory itself, protected by
file permissions (0700/0600) on the connector host, not by this service's sealing key. The directory must never
be reachable from an Agent environment. The same Feishu app also serves Router's bot channel, so Router keeps
its own copy of the app secret; the owner's personal tokens live only here.

Authorization: when the owner has not authorized (or a scope is missing), tools fail with
`feishu_personal_authorization_required` and the official consent URL; the next call completes a pending
authorization automatically.
