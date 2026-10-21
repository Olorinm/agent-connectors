import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";

// Reviewed operations of the existing business-data service. An upstream annotation
// cannot add a write or expand this list. Credentials are held by the trusted caller.
export const businessDataTools = ["catalog", "schema", "rows", "sql", "novel_chapters", "novel_production", "outline_novel", "script_content"] as const;
export const businessDataOptionsSchema = z.object({
  endpoint: z.url(), tokenFile: z.string().min(1), allowPrivateHttp: z.boolean().default(false),
}).strict();
export type BusinessDataOptions = z.input<typeof businessDataOptionsSchema>;
export type BusinessTool = { name: string; description?: string; inputSchema: { type: "object"; [key: string]: unknown } };

/** Server-side, read-only bridge for the existing business MCP. Not an OAuth vault. */
export class BusinessDataClient {
  private readonly endpoint: URL;
  private readonly options: z.output<typeof businessDataOptionsSchema>;
  constructor(options: BusinessDataOptions) {
    this.options = businessDataOptionsSchema.parse(options);
    this.endpoint = new URL(this.options.endpoint);
    const h = this.endpoint.hostname;
    const privateIP = isIP(h) === 4 && /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    if (this.endpoint.username || this.endpoint.password || this.endpoint.hash || this.endpoint.search ||
        !(this.endpoint.protocol === "https:" || this.endpoint.protocol === "http:" && this.options.allowPrivateHttp && privateIP))
      throw new Error("business_endpoint_invalid");
  }
  private async session<T>(work: (client: Client) => Promise<T>): Promise<T> {
    const token = readFileSync(this.options.tokenFile, "utf8").trim();
    if (!token || token.length > 16384 || /\s/.test(token)) throw new Error("business_credential_invalid");
    const endpoint = this.endpoint;
    const transport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname)
          throw new Error("business_endpoint_changed");
        return fetch(input, { ...init, redirect: "error" });
      },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    const client = new Client({ name: "agent-connectors-business-data", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: 15_000 });
      return await work(client);
    } catch { throw new Error("business_data_unavailable"); }
    finally { await client.close().catch(() => {}); }
  }
  async tools(): Promise<BusinessTool[]> {
    return this.session(async client => {
      const page = await client.listTools({}, { timeout: 15_000 });
      if (page.nextCursor) throw new Error("business_catalog_invalid");
      return page.tools.filter(t => (businessDataTools as readonly string[]).includes(t.name))
        .map(({ name, description, inputSchema }) => ({ name, ...(description ? { description } : {}), inputSchema }));
    });
  }
  async call(name: string, input: unknown) {
    if (name === "tools") {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new Error("business_arguments_invalid");
      return { isError: false, content: [{ type: "text", text: JSON.stringify(await this.tools()) }] };
    }
    if (!(businessDataTools as readonly string[]).includes(name)) throw new Error("business_tool_not_allowed");
    return this.session(async client => {
      const page = await client.listTools({}, { timeout: 15_000 });
      const tool = page.tools.find(t => t.name === name);
      if (!tool || page.nextCursor || typeof input !== "object" || !input || Array.isArray(input) ||
          !new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(input).valid)
        return { isError: true, content: [{ type: "text", text: "invalid_business_arguments" }] };
      const result = await client.callTool({ name, arguments: input as Record<string, unknown> }, undefined, { timeout: 60_000 });
      // Only plain textual results cross the boundary; no credentials, resource URLs or callbacks.
      return { isError: result.isError === true, content: (Array.isArray(result.content) ? result.content : [])
        .filter((c: any) => c.type === "text" && typeof c.text === "string") };
    });
  }
}
