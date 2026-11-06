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

`directory` contains `credentials.json`, `app-secret`, `lark-cli/`, and `cli-data/`.
In production it is relative to the encrypted `secretFiles` bundle's private runtime directory.
In local development without `secretFiles`, it is relative to the configuration file.
`credentials.json` must reference the app secret with a relative path inside the account directory.

The official CLI reads ordinary private files at runtime. With production `secretFiles`, those files live
on tmpfs and are saved as a KMS-protected encrypted bundle after each operation, including token refresh.
See [production encryption](security-model.md#production-encryption) for import and recovery.
The directory must never be reachable from an Agent environment. If the same Feishu app also serves
Router's bot channel, Router has its own app-secret storage, which needs separate protection.

## One app for chat and tools

A product can run Feishu as a chat channel (bot identity, for example Router) and as these tools (the owner's user
identity) on the **same** app. The product hands the app it already created to this service; the owner then
authorizes their user identity on that app. No second app is created.

`POST /v1/connections/:id/application` (service token) with
`{ "appId": "cli_…", "appSecret": "…", "domain": "feishu" | "lark", "ownerOpenId": "ou_…" }` writes
`credentials.json` and `app-secret` into the connection's `directory` (the connection itself is configured as above).
The secret is accepted, never returned. Handing over the same app and owner again keeps the owner's authorization
(a rotated secret is replaced); a different app or owner removes the previous CLI configuration and user tokens.
Operators can do the same with `connection application <id> --app-id … --app-secret-file … --domain … --owner-open-id …`.

Then `POST …/connect` starts the official device flow (`lark-cli auth login --no-wait`) and returns the consent URL;
`POST …/complete` (or any status check) finishes it once the owner has confirmed. The CLI refreshes access tokens
itself; refreshed files are saved like every other CLI change.

## Status

| `status` | Meaning |
| --- | --- |
| `feishu_configuration_required` (`reason: application_not_provided`) | No app handed over yet |
| `authorization_required` | The owner has never authorized on this app |
| `authorization_pending` | A device flow is waiting for the owner (`authorizationUrl`, `expiresAt`) |
| `connected` | The owner's identity is verified with the server |
| `expired` | It worked before and no longer does; `reason`: `refresh_token_expired`, `token_revoked` or `authorization_lost` |
| `verification_failed` | A token exists but the server check failed (network or revoked); check again |
| `owner_mismatch` / `application_mismatch` | The CLI holds another user or app |

Connection listings include `usage: "owner_private"` for Feishu: its tools act as the owner, so a product must admit
calls only from the owner's private conversation, never groups, other senders or delegated work. This service cannot
see conversations; the product enforces it where it admits connector calls.

## Missing or expired authorization

Tools stay listed. A call fails with `feishu_personal_authorization_required` and `detail`:
`state` (`authorization_required`, `expired` with `reason`, or `scope_required`), a `message` saying re-authorization
is needed (需要重新授权), `action: "reauthorize"`, and the official `authorizationUrl` of a device flow it started.
The next status check or call completes that flow after the owner confirms.
