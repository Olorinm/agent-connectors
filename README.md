# Agent Connectors

Business connectors for Agents — GitHub, Google Workspace, Feishu and Notion — exposed as MCP tools,
with credentials and authorization kept outside the Agent's environment.

```text
Agent (sandbox) ──MCP + short-lived caller token──▶ Agent Connectors ──▶ Feishu / mail / …
                                                     ▲  holds OAuth credentials (encrypted)
Router ──service token: list/inspect operations──────┤
Owner's trusted device ─▶ Router ─approval grant─────┘
```

- **ConnectorService credentials never enter the sandbox.** Google API and remote MCP OAuth tokens use AES-256-GCM envelope encryption with Google Cloud KMS in the production configuration. Application configuration and Feishu CLI files use an encrypted file bundle, restored into a private memory-backed directory. This describes the configured service, not evidence that KMS has been provisioned on a particular deployment.
- **Server-side authorization.** Each call carries a Router-signed caller token for one Agent, one owner and a list of connections. A connection is usable only by its owner.
- **Reads run, writes wait.** Tools declare `read` or `write`. A write returns `approval_required` with an operation ID; it runs only after Router presents the exact operation to the owner and posts an approval grant bound to the operation's digest. Grants are single use and short-lived. Passing `--yes` or similar from the model has no effect.
- **Narrow pre-approval.** A connection can pre-approve a write tool for exact argument values (for example, appending to one invoice table).
- **Uncertain outcomes are not retried.** An unexpected failure during a write is recorded as `uncertain`.

Start with [the four-service setup guide](docs/accounts.md). See also [security](docs/security-model.md) and [Router integration](docs/router-integration.md).

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
  "encryption": { "provider": "development-file", "keyFile": "state/sealing.key" },
  "trust": {
    "issuer": "https://router.example",
    "callerKeys": "keys/caller/public.jwks.json",
    "authorityKeys": "keys/authority/public.jwks.json"
  },
  "connections": [
    {
      "id": "work-feishu", "kind": "feishu", "owner": "@alice:router.example",
      "settings": { "directory": "state/feishu" }
    }
  ]
}
```

Feishu uses the official CLI's private account directory inside the configured secret file store. For GitHub, Google and Notion, use
`agent-connectors connection connect <id> --config connectors.json --authority-key keys/authority/private.jwk.json`.
Use `agent-connectors init --out <new-directory> --owner <owner-id>` to generate a complete four-service configuration.
The generic `credential set` command is for custom connectors; it is refused for the three OAuth connectors.

The example and `init` use a development key and must bind to loopback. Production uses
`encryption.provider: "google-cloud-kms"` with a key resource name and a projected workload identity token;
see [the encryption configuration](docs/security-model.md#production-encryption).

Programmatic use: `start(loadConfig(file), connectors)` from `@olorinm/agent-connectors`; token issuance for Router from `@olorinm/agent-connectors/issuer`.

## Connectors

- [Feishu](docs/feishu.md): the official lark-cli as the owner; the CLI's own risk declaration decides read vs write.
- [Google](docs/accounts.md): formal Google APIs through official Node SDKs, for personal and Workspace accounts.
  No MCP preview eligibility is needed; the local Agent interface remains MCP.
- [GitHub and Notion](docs/accounts.md): official remote MCP, operator-owned OAuth configuration or
  dynamic registration, typed tool discovery and locally reviewed read/write policy.

## Status

Two public read adapters can also be composed into a trusted product server:

- `@olorinm/agent-connectors/business-data`: `BusinessDataClient` accepts a fixed MCP
  endpoint and private `tokenFile`; it exposes only the reviewed business read
  operations and validates their upstream input schemas. `call("tools", {})`
  returns those schemas. Redirects and caller-selected endpoints are refused.
- `@olorinm/agent-connectors/feishu-bot-reader`: `FeishuBotReader` runs the pinned
  official CLI using a fixed bot identity. Help, schemas and skills use an
  unconfigured CLI. Actual commands require both a read risk declaration and a
  read-only dry-run plan. Writes, identity changes and host file paths are refused.

These adapters are not a deployment of ConnectorService: they reuse server-side
credential files and do not provide KMS encryption, user OAuth, approval execution
or caller-token verification. The composing server must authorize the Agent,
owner and conversation before invoking them. Agent environments receive tool
results, never the credential files. Other credentials, including model access,
are outside this guarantee.

`0.1.0-alpha.2`: four connector kinds, OAuth lifecycle and approval-bound tools. Real accounts still require
operator setup and owner consent. Mau/Router's connection UI, token delivery and approval presentation remain integration work.

## Cloudflare read broker

[The Cloudflare deployment](cloudflare/README.md) is a separate, narrow read broker.
It uses Worker secrets for its fixed upstream credentials and does not need KMS.
It supports the business-data and Feishu bot readers; it does not deploy the general
OAuth connection store or the approval-bound write service described above.
