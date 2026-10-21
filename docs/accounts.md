# GitHub, Google, Feishu and Notion

This service exposes approved business tools through `/mcp`. OAuth and account management run on the
connector host. The Agent receives only a short-lived caller token, never a provider token or application secret.

| Kind | Implementation | Setup needed once by the product operator |
| --- | --- | --- |
| `github` | [Official remote MCP](https://github.com/github/github-mcp-server), `https://api.githubcopilot.com/mcp/` | GitHub OAuth App, or compatible GitHub App user authorization credentials |
| `google` | [Official Google APIs and Node SDKs](https://github.com/googleapis/google-api-nodejs-client) | Google Cloud OAuth web client and enabled product APIs; works with personal Google accounts |
| `feishu` | Official `@larksuite/cli`, pinned version | Feishu app, app secret, permitted scopes, expected owner's `open_id` |
| `notion` | [Official remote MCP](https://developers.notion.com/guides/mcp/build-mcp-client), `https://mcp.notion.com/mcp` | No manually registered app needed for the default dynamic registration flow |

End users follow a consent link after this operator setup. They do not create OAuth applications themselves.
Notion uses OAuth dynamic client registration. GitHub and Google use the application's registered client ID
and secret. No hosted connector broker is involved.

## Initialize

Use Node 24 or later. From this repository:

```sh
npm ci
npm run build
node dist/cli.js init --out .local-four-services --owner '@alice:router.example'
node dist/cli.js serve --config .local-four-services/connectors.json
```

The new directory contains private sealing/signing keys, an ignored `secrets/` directory, and nine connections:
GitHub, six Google products (Gmail, Drive, Docs, Sheets, Slides, Calendar), Feishu and Notion.
Initialization refuses an existing directory. Nothing is authorized automatically.
It uses `encryption.provider: "development-file"` and may listen only on loopback.
For production, replace it with the [Google Cloud KMS configuration](security-model.md#production-encryption).
Replace the sample issuer in `connectors.json` with your Router issuer before wiring Router.
Owner IDs must match Router's caller-token owner exactly.

The default OAuth callback is `http://127.0.0.1:18100/oauth/callback`, suitable when the browser and
connector service run on the same machine. For a server, supply
`--redirect-url https://connectors.example/oauth/callback` and add that public host to `allowedHosts`.
Register this exact callback in GitHub and Google. Expose only `GET /oauth/callback` publicly through your
reverse proxy; keep `/mcp` and `/v1/*` on the trusted network. Disable query-string logging for the callback
because it contains the short-lived authorization code. Callback output never includes that code or any token.

## Configure applications

GitHub: place this object in `secrets/github-oauth.json`, relative to `connectors.json`:

```json
{ "client_id": "YOUR_APPLICATION_CLIENT_ID", "client_secret": "YOUR_APPLICATION_CLIENT_SECRET" }
```

Google uses formal APIs through `google-auth-library` and the official `@googleapis/gmail`, `drive`, `docs`,
`sheets`, `slides`, and `calendar` SDKs. The Agent-facing interface remains this service's MCP endpoint.
No Google MCP preview application or hosted broker is required.

Set up the application once:

1. Create a Google Cloud project and enable the APIs for the products used: Gmail, Drive, Docs, Sheets,
   Slides and Calendar. There are no additional MCP services to enable.
2. Configure the OAuth consent screen. For ordinary personal Gmail accounts, use the **External** audience.
   During development, add the intended accounts as test users.
3. Create an OAuth **Web application** client with the exact `/oauth/callback` URL configured here.
4. Save the application credentials on the connector host. Users then open the returned Google consent link.

Use the same format as GitHub in `secrets/google-oauth.json`, or save the downloaded Google web-client JSON
with its `web` wrapper. Set both files to mode `0600`. They are read only by the connector service.
The six Google connections share the application configuration but have separate user grants and scope sets.
Authorize the products you use; remove unused connections from the configuration.

Optional `settings.scopes` replaces a connection's default scopes. Defaults allow the reviewed read/write
operations (GitHub `repo read:user`; Google scopes are listed in `src/connectors/google/account.ts`).
Use narrower scopes for read-only or public-repository access. An unavailable scope produces an upstream
permission failure, never an automatic scope expansion during a business call.

For public production use, complete Google's OAuth verification as required by the requested scopes.
While an External application is in **Testing**, these Google API grants normally have refresh tokens that expire
after seven days; use the appropriate production publishing/verification process for durable end-user access.
See [Google's OAuth guide](https://developers.google.com/identity/protocols/oauth2) and
[web-server authorization](https://developers.google.com/identity/protocols/oauth2/web-server).
These are standard API application requirements, separate from MCP preview eligibility.

Existing `kind: "google"` configuration IDs, `product`, `clientFile`, and optional `scopes` continue to work.
The old preview-MCP credential envelope is deliberately not reused; reconnect any previously authorized Google
connection. Tool names/arguments now follow the local typed API adapters; refresh the Agent's tool list.

For Feishu, either point `settings.directory` at an existing Router account directory, or create
`state/feishu/credentials.json`:

```json
{
  "version": 1,
  "appId": "YOUR_FEISHU_APP_ID",
  "appSecretFile": "app-secret",
  "domain": "feishu",
  "ownerOpenId": "EXPECTED_OWNER_OPEN_ID"
}
```

Place the secret alone in `state/feishu/app-secret`. Keep the directory `0700`, both files `0600`.
The CLI checks that authorization belongs to this expected owner. See [Feishu](feishu.md) for reuse of
Router's existing configuration and its separate token storage.

## Connect and inspect

Run these on the trusted host; `--authority-key` never goes to an Agent:

```sh
node dist/cli.js connection status \
  --config .local-four-services/connectors.json \
  --authority-key .local-four-services/keys/authority/private.jwk.json

node dist/cli.js connection connect notion \
  --config .local-four-services/connectors.json \
  --authority-key .local-four-services/keys/authority/private.jwk.json
```

Open the returned `authorizationUrl` in the owner's browser. For GitHub, Google and Notion the browser returns
to `/oauth/callback`. For Feishu, consent uses the official device flow; the next status check completes it.
Check one connection by adding its ID after `status`. Use `github`, `google-gmail`, `google-drive`,
`google-docs`, `google-sheets`, `google-slides`, `google-calendar`, `feishu` or `notion`.

`connection disconnect <id>` clears the local user tokens and cancels pending approvals. Revoke the grant
in the provider's settings as well if you want to remove upstream consent. Notion's dynamic client registration
is retained for reconnecting. All connect/disconnect operations also invalidate pending writes; they do not
cancel a business request already dispatched upstream.

Important statuses:

| Status | Meaning |
| --- | --- |
| `oauth_callback_not_configured` | Set the service callback URL |
| `oauth_client_not_configured` / `oauth_client_file_missing_or_invalid` | Operator must provide application credentials |
| `feishu_configuration_required` | Provide the Feishu directory and expected owner |
| `authorization_required` / `authorization_pending` | Owner consent is absent or incomplete |
| `connected` | GitHub/Notion passed MCP initialization and tool listing, Feishu verified the owner, or Google verified its OAuth token |
| `upstream_access_denied` / `google_api_access_denied` | Upstream rejected access; check enabled APIs, scopes and organization policy |
| `upstream_unavailable` | Upstream transport could not be verified; no claim of successful connection |

The remote `connection_status` tool is safe for Agents, but connect/disconnect are trusted management actions.
No generic credential-import command is accepted for the three OAuth connectors.
Google status includes `backend: "google-api"`, `verification: "oauth"`, and `apiAccess: "checked_on_use"`;
an OAuth status check cannot prove that every product API is enabled or every document is accessible.

## Capabilities and approval

The service exposes individual typed tools after authorization, such as
`github__issue_read`, `google_gmail__search_threads`, and `notion__notion-create-pages`.
GitHub and Notion tools use upstream-discovered schemas. Google tools use local schemas and fixed SDK methods:

| Product | Included tools |
| --- | --- |
| Gmail | Search/read threads and messages, list drafts/labels, create a plain-text draft, modify message labels |
| Drive | Search files, read metadata/content, create a text file, copy a file |
| Docs | Read/create a document, append text |
| Sheets | Read metadata/values, update or append values (RAW by default; USER_ENTERED is explicit) |
| Slides | Read/create a presentation, replace text |
| Calendar | List calendars/events, read/create/delete events; notification choice is part of approved arguments |

There is no raw URL/API passthrough or cross-user Gmail ID parameter. Gmail creates drafts; sending mail is not
exposed by this adapter. Feishu retains `cli_read` and `cli_write`.

Only exact names in the code-reviewed catalog are exposed. New upstream tools remain unavailable until reviewed.
Upstream schemas validate input without transforming it. Google schemas apply documented defaults before the exact
arguments are stored for approval. Upstream `readOnlyHint` does not override local policy. GitHub, Google and Notion
writes require explicit approval; no broad `autoApprove` is supported for these discovered tools.
Approvals bind the exact arguments and additionally check the tool definition and account generation before execution.

OAuth client registrations, user tokens, PKCE verifiers and pending state are sealed in SQLite. Refresh is serialized
per connection; rotating refresh tokens are saved before another call runs. Do not run multiple service processes
against the same state directory. In production, application files and Feishu's official CLI directory use
the encrypted `secretFiles` bundle and a memory-backed runtime directory; see [production encryption](security-model.md#production-encryption).
Run the service as a dedicated OS user, outside Agent environments.

## Integration status

This repository provides the executable connectors, CLI and trusted management API. Mau/Router's end-user
connection screen, caller-token distribution and approval UI still need to call these public interfaces;
starting this repository does not automatically modify an existing Mau deployment.
See [Router integration](router-integration.md).

Tests use the real MCP/OAuth and Google SDKs against deterministic simulated providers, plus the existing Feishu CLI tests.
Real-account acceptance requires application configuration and owner consent; it is not implied by a passing test suite.
