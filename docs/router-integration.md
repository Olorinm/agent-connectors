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
