import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { signCallerToken } from "./issuer.js";

export const readClientSchema = z.object({ url: z.url(), issuer: z.string().min(1), audience: z.string().min(1), callerKeyFile: z.string().min(1) }).strict();
const principalSchema = z.object({ agentId: z.string().min(1).max(256), owner: z.string().min(1).max(256),
  connections: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/)).min(1).max(64) }).strict();
export type ReadPrincipal = z.infer<typeof principalSchema>;

/** Trusted product-side SDK client. The Agent receives tool results, never a token or signing key. */
export class ConnectorReadClient {
  private readonly url: URL;
  private readonly key: Parameters<typeof signCallerToken>[0]["key"];
  constructor(private readonly config: z.infer<typeof readClientSchema>) {
    this.url = new URL(config.url);
    if ((this.url.protocol !== "https:" && !(this.url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(this.url.hostname))) ||
      this.url.username || this.url.password || this.url.hash || this.url.search || this.url.pathname !== "/") throw new Error("connector_read_endpoint_invalid");
    if (statSync(config.callerKeyFile).mode & 0o077) throw new Error("connector_caller_key_must_be_private");
    const privateJwk = z.object({ kid: z.string().min(1), kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().min(1), d: z.string().min(1) })
      .parse(JSON.parse(readFileSync(config.callerKeyFile, "utf8")));
    this.key = { kid: privateJwk.kid, privateJwk };
  }
  private async session<T>(principal: ReadPrincipal, work: (client: Client, signal: AbortSignal) => Promise<T>): Promise<T> {
    const who = principalSchema.parse(principal);
    const token = await signCallerToken({ key: this.key, issuer: this.config.issuer, audience: this.config.audience, ...who, readOnly: true, ttlSeconds: 120 });
    const signal = AbortSignal.timeout(90_000), endpoint = new URL("/mcp", this.url);
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.href !== endpoint.href) throw new Error("connector_read_endpoint_refused");
        const response = await fetch(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
        if (!response.body) return response;
        const reader = response.body.getReader(), chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2_100_000) throw new Error("connector_read_response_too_large");
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
      } });
    const client = new Client({ name: "agent-connectors-read-client", version: "1" });
    try { await client.connect(transport, { signal }); return await work(client, signal); }
    catch { throw new Error("connector_read_unavailable"); }
    finally { await client.close().catch(() => {}); }
  }
  async tools(principal: ReadPrincipal) {
    return this.session(principal, async (client, signal) => {
      const result = await client.listTools({}, { signal });
      if (result.nextCursor || result.tools.length > 300) throw new Error("connector_tool_catalog_invalid");
      return result.tools.filter(tool => tool.name !== "operation_status" && tool.annotations?.readOnlyHint === true)
        .map(({ name, description, inputSchema }) => ({ name, description: description ?? "", inputSchema }));
    });
  }
  async call(principal: ReadPrincipal, name: string, input: Record<string, unknown>) {
    return this.session(principal, async (client, signal) => {
      const tools = await client.listTools({}, { signal });
      if (tools.nextCursor || tools.tools.length > 300) throw new Error("connector_tool_catalog_invalid");
      if (name === "operation_status" || !tools.tools.some(tool => tool.name === name && tool.annotations?.readOnlyHint === true))
        return { status: "failed", error: "tool_not_available" };
      // The signed readOnly claim is enforced again in ConnectorService; annotations alone are not the boundary.
      const result = await client.callTool({ name, arguments: input }, undefined, { signal, timeout: 60_000 });
      if (!result.structuredContent || JSON.stringify(result.structuredContent).length > 1_000_000) throw new Error("connector_read_result_invalid");
      return result.structuredContent;
    });
  }
}
