# Agent Connectors

Business connectors for Agents — mail, Feishu and similar services — exposed as MCP tools,
with credentials and authorization kept outside the Agent's environment.

```text
Agent (sandbox) ──MCP + short-lived caller token──▶ Agent Connectors ──▶ Feishu / mail / …
                                                     ▲  holds OAuth credentials (encrypted)
Router ──service token: list/inspect operations──────┤
Owner's trusted device ─▶ Router ─approval grant─────┘
```

- **Credentials never enter the sandbox.** Connections and their OAuth tokens live here, sealed with AES-256-GCM.
- **Server-side authorization.** Each call carries a Router-signed caller token for one Agent, one owner and a list of connections. A connection is usable only by its owner.
- **Reads run, writes wait.** Tools declare `read` or `write`. A write returns `approval_required` with an operation ID; it runs only after Router presents the exact operation to the owner and posts an approval grant bound to the operation's digest. Grants are single use and short-lived. Passing `--yes` or similar from the model has no effect.
- **Narrow pre-approval.** A connection can pre-approve a write tool for exact argument values (for example, appending to one invoice table).
- **Uncertain outcomes are not retried.** An unexpected failure during a write is recorded as `uncertain`.

See [docs/security-model.md](docs/security-model.md) and [docs/router-integration.md](docs/router-integration.md).

## Components

| Component | Role |
| --- | --- |
| [Router](https://github.com/Olorinm/agent-router) | Identities and channels; issues caller tokens; presents approvals and issues grants |
| Agent Connectors | Holds connector credentials; enforces authorization; executes operations |
| [Agent Host](https://github.com/Olorinm/agent-host) | Runs the native kernel; receives only the MCP URL and a caller token |

Channels (receiving and replying to Feishu or mail messages) stay in Router. Business tools (calendar, documents, mailbox, reimbursement) belong here.

## Usage

```sh
npm install
npm test
agent-connectors init-key state/sealing.key
agent-connectors keygen --kid caller-2026-10 --out keys/caller        # private key goes to Router
agent-connectors keygen --kid authority-2026-10 --out keys/authority  # private key goes to Router's approval path
agent-connectors serve --config connectors.json
```

```json
{
  "listen": { "host": "127.0.0.1", "port": 18100 },
  "stateDirectory": "state",
  "keyFile": "state/sealing.key",
  "trust": {
    "issuer": "https://router.example",
    "callerKeys": "keys/caller/public.jwks.json",
    "authorityKeys": "keys/authority/public.jwks.json"
  },
  "connections": [
    {
      "id": "work-feishu", "kind": "feishu", "owner": "@alice:router.example",
      "autoApprove": [{ "tool": "base_append", "match": { "table": "tblInvoices" } }]
    }
  ]
}
```

Store a connection's credentials from stdin: `agent-connectors credential set work-feishu --config connectors.json < credentials.json`.

Programmatic use: `start(loadConfig(file), connectors)` from `@olorinm/agent-connectors`; token issuance for Router from `@olorinm/agent-connectors/issuer`.

## Status

`0.1.0-alpha.1`: authorization, approval, credential sealing and MCP transport. No built-in connector yet; Feishu tools move here from Router next, then mail.
