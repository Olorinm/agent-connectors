# Cloudflare read broker

This Worker authorizes one configured Agent and owner, then runs the reviewed
business-data and Feishu bot readers in a trusted container. Agent guests do not
receive upstream credentials. This deployment requires Workers Paid. It is separate
from ConnectorService's OAuth store and approval-bound write workflow.

Run `npm ci`, `npm run check` and `npm test` here. Build and test the parent package
with `npm ci && npm test && npm pack`. Keep the package private in R2, and set its
object key and SHA-256 in a private copy of `wrangler.example.jsonc`. Configure the
account, the exact Agent/owner principal, and the immutable source commit.

Upload `CALLER_TOKEN` and `READ_CREDENTIALS` using `wrangler secret bulk` from a
mode-0600 JSON file outside this repository. `READ_CREDENTIALS` is a JSON string
with the configuration consumed by `src/cloudflare-reader.ts` in the parent package.
Use a distinct random caller token of at least 32 bytes. Only the trusted Mau server
receives that token. Never give the caller Cloudflare administration credentials.

Deploy with the pinned local CLI:

```sh
./node_modules/.bin/wrangler deploy --config /private/connectors.wrangler.json
./node_modules/.bin/wrangler secret bulk /private/connector-secrets.json --config /private/connectors.wrangler.json
```

The example `main` path must be resolved against this checkout when the private
configuration is elsewhere. Replace all placeholders. A changed package checksum
invalidates the programs-only container snapshot. The snapshot is taken before
credentials enter the container. Reads have a fixed principal and allowlist; raw
SQL, writes, arbitrary upstream endpoints, Origin-bearing requests and incorrect
caller credentials are refused. Keep invocation logs disabled. `/health` reports
the configured source revision, never credentials.

Worker secrets are managed configuration protection. A compromised authorized
Worker can still use its credentials. They do not replace end-user authorization,
least-privilege upstream grants, audit checks or an independent recovery copy.
