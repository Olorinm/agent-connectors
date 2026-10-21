# Router integration

```js
import { signCallerToken, signServiceToken, signGrant } from "@olorinm/agent-connectors/issuer";
```

1. **Before a run**, issue a caller token for the Agent and the connections the owner enabled for it,
   and pass it to Host with the MCP URL (`POST <base>/mcp`, `Authorization: Bearer <token>`).
   Refresh it before expiry; never write the private key into the Agent's environment.
2. **Discover approvals.** Poll `GET /v1/operations` (service token), or inspect an `approval_required`
   tool result surfaced by Host, then fetch `GET /v1/operations/:id`. Deliver only to that operation's owner.
3. **Present** the connector's `summary` and `input` on a device allowed to approve writes. Do not show
   or trust text produced by the Agent as the description of what will happen.
4. **Approve:** `POST /v1/operations/:id/approve` with `{"grant": signGrant({owner, operationId, digest, approver})}`.
   The response is the operation outcome. **Deny:** `POST /v1/operations/:id/deny` (service token).
5. The Agent can check the outcome with the `operation_status` tool.

## Account management

The trusted Router can use these endpoints with an authority-signed **service token**:

| Method | Path | Result |
| --- | --- | --- |
| GET | `/v1/connections` | Configured connections and safe status |
| GET | `/v1/connections/:id` | Configuration/authorization status; verifies upstream when authorized |
| POST | `/v1/connections/:id/connect` | Owner consent URL, or a configuration-required status |
| POST | `/v1/connections/:id/disconnect` | Clears local authorization and denies pending writes |

Router must authenticate the owner and check ownership before invoking these service-wide management endpoints.
Present consent links only to that owner. Do not give the Agent a service token or expose an endpoint that accepts
arbitrary owner IDs from the Agent. Provider tokens and PKCE verifiers are never returned.
The browser returns directly to the connector's configured `GET /oauth/callback` (single-use, expiring state).
Feishu uses the CLI's device flow; a later status check completes consent.

After successful connection, ask the native Host client to refresh `tools/list` or reconnect the MCP session.
Tool lists are prepared per owner; GitHub/Notion upstream schemas are filtered by the local capability catalog,
while Google uses local schemas over formal API SDK methods. Existing `kind: "google"` settings select the API
adapter; reconnect old preview-MCP grants and refresh the tool list after upgrading.
The current transport is stateless and does not push `tools/list_changed` notifications.

Connect/disconnect deny old pending approvals. Changed upstream schemas or account generations require a fresh
write request and approval. Never automatically retry an `uncertain` operation.
See [accounts](accounts.md) for the CLI and required application configuration.
