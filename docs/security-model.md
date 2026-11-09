# Security model

## Assumptions

The Agent is not trusted. It reads untrusted mail, invoices and documents, so prompt injection is expected.
Anything readable or callable from the Agent's environment — files, environment variables, network — must be
safe to hand to an attacker. Router and this service are trusted; the owner's paired device is the only
place where approval decisions are made.

## What the Agent holds

Only the MCP URL and a caller token: EdDSA JWT, `typ: agent-connectors.caller+jwt`, at most one hour,
claims `sub` (Agent ID), `owner`, `connections`. A stolen token allows, until expiry, what the Agent itself
can do: read through the listed connections of that owner and *request* writes. It cannot approve anything.

The optional signed `readOnly: true` claim restricts both discovery and execution to reads, including refusal of pre-approved writes. `ConnectorReadClient` keeps these short-lived tokens in the trusted product server and returns tool results to the Agent instead. The product remains responsible for owner/Agent assignment and conversation admission.

## Keys

| Key | Signs | Holder |
| --- | --- | --- |
| Caller key | caller tokens | Router (delivery path) |
| Authority key | service tokens, approval grants | Router's approval path only |
| KMS wrapping key | encrypts per-value data keys | Google Cloud KMS; never exported to the service |
| Data key | AES-256-GCM credentials and operation contents | fresh per value; briefly in service memory |
| Development sealing key | local development only | loopback-bound service; file mode 0600 |

Caller and authority key sets must differ; the service refuses to start otherwise. Token types are checked
explicitly, so a caller token is never accepted as a grant or service token, and vice versa.

## Writes

1. The Agent calls a write tool. Arguments are validated once and canonicalized; that canonical JSON is what
   is stored, shown, approved and executed (it is never re-parsed). Tool schemas must convert to JSON Schema.
2. The service stores a pending operation and its digest:
   `sha256(canonical({v:1, id, owner, agentId, connectionId, tool, input}))`. Nothing has happened yet.
3. Router (service token) fetches the operation, including the connector-generated summary and arguments,
   and shows it on the owner's trusted device. Router must not use any summary supplied by the Agent.
4. After the owner confirms, Router signs a grant: `sub` = owner, `op` = operation ID, `dig` = digest,
   `apv` = approving device, lifetime ≤ 10 minutes.
5. The service decrypts the payload (its associated data binds ID, owner, Agent, connection, tool and digest,
   so altering any stored column fails), recomputes the digest, and checks it and the owner against the grant.
   The connection must still belong to that owner, the operation must be pending and unexpired, and the grant
   ID unused. It then moves the operation to `executing` with compare-and-set and runs it once.

Outcomes: `completed`, `failed` (a known `ConnectorError`: no effect), `uncertain` (unexpected error, or crash
while executing: may have taken effect, never retried), `denied`, `expired` (default 15 minutes).

Pre-approval (`autoApprove`) applies only to write tools that declare `targets` — the arguments deciding where
a write lands — and each rule must pin all of them to exact values. Keep it to destinations the owner controls,
such as one table. Pre-approved writes are recorded like any other operation; if an identical one ended
`uncertain`, the next one goes to the owner instead of running.

## At rest

- SQLite in a 0700 directory, file 0600, rollback journal (no separate WAL files with default modes).
- Credentials and operation payloads (arguments, summaries, results) are sealed with AES-256-GCM.
  The associated data binds each value to its connection or operation, so sealed values cannot be swapped.
- Logs must not contain arguments, results or tokens.
- OAuth state, PKCE verifiers, dynamic client registrations and refresh tokens use the same sealed credential
  store. Each authorization state expires after ten minutes and is consumed before token exchange. One process per
  state directory is required; per-connection queues serialize refresh-token rotation.
- Application credentials and Feishu CLI files use the encrypted `secretFiles` bundle in production.
  The CLI requires this store whenever KMS configuration references application or Feishu files.
  Local development without this store uses private files and provides no KMS protection for them.

## Production encryption

Use an explicit KMS configuration:

```json
{
  "encryption": {
    "provider": "google-cloud-kms",
    "keyName": "projects/PROJECT_ID/locations/asia-east2/keyRings/mau/cryptoKeys/connectors",
    "workloadIdentity": {
      "audience": "//iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/mau-vke/providers/vke",
      "tokenFile": "/var/run/mau-identity/token"
    }
  },
  "secretFiles": {
    "file": "/data/application-files.envelope",
    "runtimeDirectory": "/run/connector-secrets"
  }
}
```

The token file is a Kubernetes projected ServiceAccount token, with the provider's allowed audience
and a short lifetime. Mount it only in the connector Pod. The SDK exchanges it at Google's STS;
there is no service-account private key, developer-login fallback, or metadata credential fallback.
Grant this exact workload `roles/cloudkms.cryptoKeyEncrypterDecrypter` on this key only.
Bind the identity provider to the cluster issuer and the connector's exact namespace and service account.
Agent service accounts must not match the provider condition or the key IAM binding.

Each sealed value gets a fresh 256-bit data key. AES-256-GCM encrypts the value locally; KMS encrypts
the data key with authenticated context. SQLite stores ciphertext and the wrapped data key together.
Only that random data key goes to KMS, not mail, tool arguments or results. The context binds the
service, envelope version, KMS key and credential/operation identity. CRC32C checks validate KMS transport
integrity. Data-key buffers are cleared after use; JavaScript and SDK internals may retain copies temporarily.

Startup performs an encrypt/decrypt check before listening. KMS failure never switches to a local key.
If persistence fails after a business write, the operation remains `uncertain` and is not replayed.
`kms-v2` refuses legacy ciphertext; no automatic migration or fallback is provided.
`development-file` is explicitly limited to `127.0.0.1` or `::1`.

KMS protects stolen disks, database copies and backups from an attacker without KMS access. It does
not protect plaintext from a compromised, currently authorized connector process. Network isolation,
restricted workload identity, least privilege and audit logging are still required. HTTPS protects
requests in transit, including requests passing through an HTTP CONNECT proxy.

Mount `secretFiles.runtimeDirectory` as Linux tmpfs, for example Kubernetes `emptyDir.medium: Memory`.
Production refuses a disk-backed directory. The bundle restores into a fresh 0700 subdirectory,
with files mode 0600. Connection `clientFile` and Feishu `directory` paths must be relative to that
bundle; absolute paths and parent traversal are rejected. Feishu `appSecretFile` is relative to its account
directory. The CLI rebinds the official CLI configuration to the fresh runtime directory on restart.

Import private application files once, from a trusted operator environment with the appropriate
KMS workload identity:

```sh
agent-connectors import-secret-files --config connectors.json --directory /private/account-files
```

The import refuses an existing bundle and does not delete its source. Handle the source separately;
do not place plaintext imports on production persistent volumes. Secrets are not accepted in command-line
arguments or returned by management APIs. In the bundle, for example, `google-oauth.json` matches
`settings.clientFile: "google-oauth.json"`; `feishu/credentials.json` matches `settings.directory: "feishu"`.

Official CLI operations, including authorization and refresh, are serialized and checkpoint the
encrypted bundle before returning. A failed checkpoint blocks further CLI operations until recovery;
a dispatched write remains uncertain. Snapshot paths reject symlinks and special files and have bounded
size and file count. Graceful shutdown removes the plaintext runtime directory. A crash may leave
runtime files in the Pod's memory volume until the Pod is removed; never mount that volume into an Agent.
Only one service process may use a persistent state directory/bundle.

For programmatic composition, use `SecretFiles` with `builtinConnectors`' `withSecretFiles` option and
its runtime directory as `baseDirectory`, then close the file store during shutdown. The generic `start`
API cannot enforce storage choices inside caller-supplied custom connectors.

This implementation covers connector OAuth state, operation payloads, application files and Feishu
CLI files when configured as above. It does not encrypt Mau/Router's own state. Deployment and real KMS
authorization tests are required separately from the repository's local tests.

## Cloudflare remote key wrapping

`encryption.provider: "cloudflare-worker-secrets"` uses the separate `cloudflare/src/key-vault.mjs` Worker to wrap 32-byte data keys. Configure a fixed HTTPS root `url`, a `keyId`, and a private `tokenFile` containing the caller token. The Worker requires matching `KEY_ID`, `WRAPPING_KEY` (32 random bytes in base64url), and `CALLER_TOKEN` secrets. Optional `LIMITER` uses the Workers rate-limit binding; it is not a global billing cap.

The master wrapping key resides in Worker Secrets. The connector sends only random data keys and their authenticated context, never OAuth tokens or mail. AES-256-GCM envelopes and the encrypted `secretFiles` bundle use the same bound envelope format as the KMS option, but this is **not non-exportable KMS**: a Cloudflare administrator or arbitrary Worker deployment can use/expose the key. An authorized connector process can unwrap data keys. Keep the Worker separate from the existing business read broker; never replace that broker with this entrypoint.

Requests require the private caller token, reject browser Origins, enforce exact key/context and bounded bodies, and do not follow redirects or automatically retry. Startup verifies wrapping and unwrapping. Production application files still require a private Linux tmpfs runtime directory. Keep the master key in independent recovery storage: replacing it without rewrapping existing data makes that data unreadable. Rotate the caller token separately. This option does not provision a Worker or Google application automatically.

## Remote MCP tools

Only exact reviewed tool names are imported from GitHub and Notion. Input is validated against the discovered
schema without coercion. Upstream annotations cannot weaken the locally assigned risk. Unknown tools and schemas that
cannot be validated are not exposed. Remote tools cannot be broadly auto-approved.

Pending operations retain an encrypted tool/account fingerprint. Schema or account changes invalidate execution.
Connect/disconnect deny pending operations. Credentials are bound to the configured owner, provider, endpoint, settings
and callback; changing that binding requires new authorization. Already dispatched writes may still complete.

The SDK handles OAuth/PKCE and MCP. Credential-bearing requests use a fixed provider origin allow-list and refuse
HTTP redirects. Provider errors are reduced to safe codes. The MCP transport does not automatically refresh and replay
business calls; tokens are refreshed beforehand, and any failure after a tool dispatch is conservatively uncertain.

## Google formal APIs

Google uses the official `google-auth-library` and product-specific `@googleapis/*` clients. Every tool has a local
schema, fixed SDK method, and explicit read/write risk. There is no generic URL, HTTP method, request-body passthrough
or Gmail `userId` argument. Account status verifies the OAuth token; product API availability is checked when used.

PKCE and token exchange use Google's SDK. Credentials have a separate `google-api-v1` binding, so preview-MCP
credentials cannot be reused silently. Refresh happens under the per-connection queue and persists before business
dispatch. Business SDK clients receive only the access token, never a refresh token; automatic transport retries and
auth-failure replay are disabled. The SDK transport retains multipart, proxy and download-size handling, with a
request interceptor that restricts HTTPS origins and refuses redirects. Any failure after a write dispatch remains
uncertain. Google tool definitions and account generations are included in the approval fingerprint.

## Browser (Cloudflare Browser Run)

The `browser` connector drives a remote Chromium on Cloudflare Browser Run with the official agent-browser CLI
(pinned), run by this service. The browser runs outside the Agent environment; the CLI and its daemon run here, as
this service's user, with a private home directory per connection (mode 0700), an explicit empty configuration file
and its local screencast disabled. The Cloudflare API token (Browser Rendering - Edit only) is read from a private
file and reaches the CLI only through `AGENT_BROWSER_CDP_HEADERS`; it is never an argument, never written to disk and
never returned. Session management and Live View use Browser Run's HTTP API from this service.

Site cookies and local storage are the connection's credential. After every command the connector saves them with
`agent-browser state save` into a private file, seals them and deletes the file; a new remote browser receives them
through `state load` the same way. They are never returned to callers.

The Agent passes agent-browser arguments, checked against an allowlist before anything runs:

- Allowed: `open`/`goto`/`navigate`, `back`, `forward`, `reload`, `tab` (list, new, close, switch), `snapshot`,
  `read` of the current page, `get` (except `cdp-url`), `is`, `find`, `wait` (selector, time, `--url`, `--load`,
  `--text`), `click`, `dblclick`, `fill`, `type`, `press`, `keydown`/`keyup`, `keyboard type|inserttext`, `hover`,
  `focus`, `check`, `uncheck`, `select`, `drag`, `scroll`, `scrollintoview`, `mouse`, `frame`, `dialog`,
  `set viewport|device|media|geo|offline`, `diff snapshot`, `screenshot`, `pdf`, `download`, `close`, `skills
  list|get` and `--help`/`--version`; each with its own reviewed flags. `upload` only through the write tool.
- Refused, because they export or replace credentials and session data: `cookies`, `storage`, `state`, `auth`.
- Refused, because page JavaScript can read `document.cookie`, local storage and authenticated responses:
  `eval`, `wait --fn`, `addinitscript`, `--init-script`, `--enable`.
- Refused, because they intercept or rewrite traffic: `network`, `set headers`, `set credentials`, `--headers`.
- Refused, because they select another browser, profile, file or configuration: `connect`, `close --all`,
  `session`, `profiles` and every global flag except `--json` (`--cdp`, `--cdp-headers`, `--profile`, `--state`,
  `--session`, `--restore`, `--namespace`, `--executable-path`, `--extension`, `--args`, `--proxy`, `--config`,
  `--download-path`, `--screenshot-dir`, `--allow-file-access`, `-p`, …).
- Refused, because they manage the installation or open other control channels: `install`, `upgrade`, `doctor`,
  `plugin`, `mcp`, `chat`, `dashboard`, `stream`, `inspect`, `batch` (it would bypass per-command checks), and
  debugging or recording commands.

Navigation URLs (`open`, `goto`, `navigate`, `tab new`) must be http(s) without embedded credentials, and loopback,
private, link-local and `.internal` hosts are refused before a browser is attached; a bare host gets `https://`
and the checked URL is what the CLI receives. Output paths (`screenshot`, `pdf`, `download`) are replaced by a file
in a private per-call directory; only the requested file name is kept, the files are returned and the directory is
deleted.

Next to agent-browser the connector keeps one minimal Chrome DevTools Protocol connection to the same Browser Run
session (`src/connectors/browser/cdp.ts`, Node's built-in WebSocket, the token only in its Authorization header). It
covers what agent-browser cannot do against a remote browser; it is not a second automation path:

- **Navigation guard.** Every document request in the browser is paused (`Fetch`, browser-wide, so new tabs and
  redirect hops are included) and failed with `BlockedByClient` when its URL is not http(s), carries credentials, or
  targets a loopback, private, link-local or `.internal` host. This applies to clicks, `click --new-tab`, form posts,
  script navigations and redirects, not only to URLs the Agent types. Commands do not run unless the guard is
  connected; a dropped connection is restored before the next command. Subresources (images, scripts, fetch/XHR) are
  not intercepted, matching the earlier connector.
- **Downloads.** Browser Run saves a download on its own machine and blocks reading it back, so agent-browser's
  `download` cannot deliver the file. For `download <element> <name>` agent-browser clicks the element while the
  guard, for that command only, also pauses document responses: an attachment (or any non-HTML document) is read with
  `Fetch.getResponseBody`, answered with an empty 204 so the page stays, and returned (links on any site, form posts,
  redirects checked hop by hop). Script-generated downloads (`blob:`/`data:` URLs) are read inside the page, through a
  small hook that keeps created blobs readable after the page revokes their URL; the remote download is cancelled. At
  most 10 MB.
- **Structured handoff.** `Cloudflare.handoff` shows the Agent's instructions with Done/Failed buttons in the live
  view; `handoff_status` reads `Cloudflare.getHandoffState` and the `Cloudflare.handoffComplete` outcome.

`upload` lets agent-browser select the file input and name the files, then a fixed page script places the approved
bytes into that input, because the remote browser cannot read this host's files. Page scripts are part of this
service; Agent input reaches them only as JSON values.

**Deliberate exception to "anything with an external effect is a write".** By product decision, matching how
comparable assistants behave, navigation, clicks, typing, `screenshot`, `pdf` and `download` run without approval,
so a click can submit a form or place an order on a site the owner is signed in to. Only `upload` (sending a file to
a site) is a write: the owner approves the exact files and origin, and execution refuses a page whose origin differs
from the approved `site`. Treat a browser connection as trusted with everything its stored sign-ins allow; do not
store sign-ins for banking, payment or accounts where an unattended click is unacceptable.

`handoff_start` returns a Live View URL of the current tab that grants control of the browser until it expires. It
is meant for the owner only, so a composer must deliver it to the owner directly, not to the model. The owner ends it
with Done or Failed; `handoff_cancel` revokes it by closing that tab.

agent-browser's npm package carries every platform's native binary (about 116 MB). Images keep only their own
platform's binary (the Dockerfile deletes the others and marks it executable; about 18 MB for linux-x64).

## HTTP

Requests carrying an `Origin` header are refused, as is an unexpected `Host` when `allowedHosts` is set.
Bind to a private interface, and allow only Router and Agent environments in the firewall.
The sole public browser entry point is the configured GET `/oauth/callback`, using a top-level redirect without
an `Origin` header. It requires a valid single-use state, returns no credentials, and sets no-store/no-referrer.
The reverse proxy must omit callback query strings from logs. All `/v1/connections` management routes require a
service token; a caller token cannot connect or disconnect an account.

## Not covered here

- Enforcing that the sandbox cannot read the caller token or reach other services: environment isolation
  (Host user separation, egress allow-list) belongs to Host and Environment.
- Which devices may approve which risk levels: Router policy.
- Rate limits and per-owner quotas: planned.


## Cloudflare trusted read deployment

`cloudflare/src/index.ts` is a separate, bounded read gateway. Mau authenticates with a
random caller credential; the gateway binds it to one configured Agent and owner. It
permits the official Feishu CLI's locally classified read commands. Arbitrary upstream
URLs and writes are refused. This deployment
does not expose the generic OAuth-management API or claim that new Google/Notion
accounts have been authorized.

Upstream credentials are Worker Secrets. A trusted connector container receives them
only for one command, writes the official clients' credential files to private tmpfs,
and removes those files afterwards. Agent containers cannot address this container or
read its environment. Its reusable snapshot contains programs only, created before
credential injection. Programs are rebuilt from the integrity-checked archive before
that snapshot expires. Read results have a size bound and redact common credential,
email and phone fields; that is not a guarantee that arbitrary business prose contains
no personal data. Apply upstream source grants as well.

The gateway admits at most 500 reads per UTC day and one concurrent read for its
principal. Logs contain operation kind, success and safe error codes; neither input,
result bodies nor credential values are logged. The generic connector service has
separate policies and is not covered by this deployment's quota.

Worker Secrets are managed encrypted storage, not a non-exportable KMS key. Trusted
runtime code can use the plaintext. Someone able to deploy arbitrary Worker code can
access its secrets. Protect Cloudflare administrators and deployment credentials;
restrict deployment roles and use MFA. Agent isolation does not protect against a
compromised Cloudflare administrator, upstream business server or Mau operator.

To revoke this route, rotate `CALLER_TOKEN` and Mau's private caller-token file during
maintenance. To revoke upstream access, replace `READ_CREDENTIALS` and revoke the old
upstream grant at its provider. Rotating only the caller credential does not revoke an
upstream token. Preserve unrelated monitor/service grants when doing so.
