# Agent Connectors

Read `README.md` and `docs/security-model.md` before changing public boundaries.

- Credentials, grants and authorization stay in this service. Never add a path that returns a credential,
  a signing key or a sealed value to a caller.
- Every tool declares its risk. Anything with an external effect (send, submit, delete, approve, pay) is `write`.
  Do not mark a write as `read` to avoid approval.
- Prefer narrow, typed tools over generic passthrough (for example raw API or CLI argument lists).
  If a passthrough is unavoidable, classify its write subcommands as `write` in code, not in descriptions.
- Throw `ConnectorError` only when the operation certainly had no effect; anything else becomes `uncertain`.
- Reuse official SDKs and CLIs for each service; do not write custom protocol clients when an official one exists.
- Do not commit credentials, tokens, real mailbox content, private conversations or machine-local state.

Runtime changes: run `npm test`. Tests must exercise both the allowed and the refused path of every security check.
