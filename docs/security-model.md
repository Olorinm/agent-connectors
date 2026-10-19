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

## Keys

| Key | Signs | Holder |
| --- | --- | --- |
| Caller key | caller tokens | Router (delivery path) |
| Authority key | service tokens, approval grants | Router's approval path only |
| Sealing key | credentials and operation contents at rest | this service; file mode 0600 required |

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

## HTTP

Requests carrying an `Origin` header are refused, as is an unexpected `Host` when `allowedHosts` is set.
Bind to a private interface, and allow only Router and Agent environments in the firewall.

## Not covered here

- Enforcing that the sandbox cannot read the caller token or reach other services: environment isolation
  (Host user separation, egress allow-list) belongs to Host and Environment.
- Which devices may approve which risk levels: Router policy.
- Rate limits and per-owner quotas: planned.
