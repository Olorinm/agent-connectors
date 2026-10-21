import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonical, digest, type Json } from "./canonical.js";
import { ConnectorError, type ConnectionConfig, type Connector, type Credentials, type ToolDefinition } from "./connector.js";
import type { ValueSealer } from "./sealer.js";
import type { OperationRow, OperationStatus, Store } from "./store.js";
import type { Caller, Grant } from "./tokens.js";

export interface ServiceOptions {
  connectors: Connector[];
  connections: ConnectionConfig[];
  store: Store;
  sealer: ValueSealer;
  /** How long a write waits for the owner's decision. */
  operationTtlSeconds?: number;
  now?: () => Date;
}

export interface ExposedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: "read" | "write";
}

export type CallOutcome =
  | { status: "completed"; result: Json; operationId?: string }
  | { status: "failed"; error: string; detail?: Json; operationId?: string }
  | { status: "uncertain"; error: string; operationId?: string }
  | { status: "approval_required"; operationId: string; summary: string; expiresAt: string };

export interface OperationView {
  id: string;
  owner: string;
  agentId: string;
  connectionId: string;
  tool: string;
  digest: string;
  status: OperationStatus;
  summary: string;
  input: Json;
  createdAt: string;
  expiresAt: string;
  outcome?: CallOutcome;
}

interface Payload {
  input: Json;
  summary: string;
  outcome?: CallOutcome;
  definition?: string;
}

interface Entry {
  connection: ConnectionConfig;
  tool: ToolDefinition;
  schema: Record<string, unknown>;
}

export class ServiceError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
  }
}

const STATUS_TOOL = "operation_status";
const connectionId = /^[a-z0-9][a-z0-9-]{0,31}$/;
const reservedKeys = new Set(["__proto__", "constructor", "prototype"]);

export class ConnectorService {
  readonly #tools = new Map<string, Entry>();
  readonly #connections = new Map<string, ConnectionConfig>();
  readonly #connectors = new Map<string, Connector>();
  readonly #now: () => Date;
  readonly #ttl: number;
  constructor(private readonly options: ServiceOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#ttl = options.operationTtlSeconds ?? 900;
    const kinds = new Map(options.connectors.map((c) => [c.kind, c]));
    for (const connection of options.connections) {
      if (!connectionId.test(connection.id) || this.#connections.has(connection.id)) throw new Error(`connection_id_invalid:${connection.id}`);
      const connector = kinds.get(connection.kind);
      if (!connector) throw new Error(`connector_kind_unknown:${connection.kind}`);
      for (const rule of connection.autoApprove ?? []) {
        const tool = connector.tools.find((t) => t.name === rule.tool);
        const keys = Object.keys(rule.match);
        if (tool?.risk !== "write" || !tool.targets?.length || keys.some((key) => reservedKeys.has(key)) ||
          !tool.targets.every((key) => Object.hasOwn(rule.match, key)))
          throw new Error(`auto_approve_rule_invalid:${connection.id}:${rule.tool}`);
      }
      this.#connections.set(connection.id, connection);
      this.#connectors.set(connection.id, connector);
      for (const tool of connector.tools) {
        let schema: Record<string, unknown>;
        try {
          // Arguments must be plain JSON end to end; schemas that cannot describe that are refused here.
          schema = tool.inputSchema ?? z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
        } catch {
          throw new Error(`tool_schema_invalid:${connector.kind}:${tool.name}`);
        }
        this.#tools.set(toolName(connection, tool), { connection, tool, schema });
      }
    }
    for (const name of this.#tools.keys()) if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`tool_name_invalid:${name}`);
    // A write interrupted by a crash may have taken effect.
    for (const row of options.store.operations("executing")) options.store.transition(row.id, "executing", "uncertain", this.#now());
  }

  /** Discover only the caller's connections. Missing authorization leaves status tools available. */
  async prepare(caller: Caller, signal: AbortSignal) {
    await Promise.all([...this.#connections.values()].filter((c) => this.#allowed(caller, c))
      .map((c) => this.#discover(c, signal).catch(() => undefined)));
  }

  async connections(signal: AbortSignal): Promise<Json[]> {
    return Promise.all([...this.#connections.values()].map(async (c) => ({
      id: c.id, kind: c.kind, owner: c.owner, label: c.label ?? c.id,
      account: this.#connectors.get(c.id)?.account ? await this.account(c.id, "status", signal) : { status: "account_management_unavailable" },
    })));
  }

  /** Trusted management only; not exposed as an Agent tool. */
  async account(id: string, action: "status" | "connect" | "disconnect", signal: AbortSignal): Promise<Json> {
    const connection = this.#connections.get(id), connector = this.#connectors.get(id);
    if (!connection || !connector?.account) throw new ServiceError("connection_account_unavailable", 404);
    if (action !== "status") {
      // Old approvals may not be used against a newly linked external account.
      for (const row of this.options.store.operations("pending"))
        if (row.connectionId === id) this.options.store.transition(row.id, "pending", "denied", this.#now());
      this.#clearDiscovered(connection);
    }
    try {
      return await connector.account[action]({ connection, credentials: this.#credentials(id), signal });
    } catch (error) {
      if (error instanceof ConnectorError) return { status: error.code, ...(error.detail ? { detail: error.detail } : {}) };
      return { status: "connection_check_failed" };
    }
  }

  async oauthCallback(state: string, code: string | undefined, signal: AbortSignal) {
    for (const connection of this.#connections.values()) {
      const callback = this.#connectors.get(connection.id)?.account?.callback;
      if (callback && await callback({ connection, credentials: this.#credentials(connection.id), signal }, state, code)) {
        this.#clearDiscovered(connection);
        return;
      }
    }
    throw new ServiceError("oauth_state_invalid_or_expired", 400);
  }

  #clearDiscovered(connection: ConnectionConfig) {
    const fixed = new Set(this.#connectors.get(connection.id)!.tools.map((t) => t.name));
    for (const [name, entry] of this.#tools)
      if (entry.connection.id === connection.id && !fixed.has(entry.tool.name)) this.#tools.delete(name);
  }

  async #discover(connection: ConnectionConfig, signal: AbortSignal) {
    const connector = this.#connectors.get(connection.id)!;
    if (!connector.discover) return;
    this.#clearDiscovered(connection);
    const discovered = await connector.discover({ connection, credentials: this.#credentials(connection.id), signal });
    const entries = discovered.map((tool): [string, Entry] => {
      const name = toolName(connection, tool);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || connector.tools.some((t) => t.name === tool.name))
        throw new Error("discovered_tool_name_invalid");
      return [name, { connection, tool, schema: tool.inputSchema ?? z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown> }];
    });
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error("discovered_tool_duplicate");
    for (const [name, entry] of entries) this.#tools.set(name, entry);
  }

  /** Tools visible to this caller: only connections it was issued for and its owner holds. */
  tools(caller: Caller): ExposedTool[] {
    const visible: ExposedTool[] = [];
    for (const [name, { connection, tool, schema }] of this.#tools) {
      if (!this.#allowed(caller, connection)) continue;
      visible.push({
        name, risk: tool.risk, inputSchema: schema,
        description: `${connection.label ?? connection.id}: ${tool.description}${tool.risk === "write" ? " Requires the owner's approval on a trusted device unless pre-approved; returns approval_required with an operationId. Never ask the owner to paste approvals into chat." : ""}`,
      });
    }
    visible.push({
      name: STATUS_TOOL, risk: "read", description: "Check an operation that required approval: pending, completed (with result), denied, expired or failed.",
      inputSchema: { type: "object", properties: { operationId: { type: "string" } }, required: ["operationId"], additionalProperties: false },
    });
    return visible;
  }

  async call(caller: Caller, name: string, args: unknown, signal: AbortSignal): Promise<CallOutcome> {
    if (name === STATUS_TOOL) {
      const parsed = z.object({ operationId: z.string().max(64) }).strict().safeParse(args ?? {});
      const view = parsed.success ? await this.#view(parsed.data.operationId) : undefined;
      if (!view || view.agentId !== caller.agentId || view.owner !== caller.owner) return { status: "failed", error: "operation_not_found" };
      const { input: _input, ...rest } = view;
      return { status: "completed", result: rest as unknown as Json };
    }
    const connection = [...this.#connections.values()].find((c) => name.startsWith(`${c.id.replaceAll("-", "_")}__`));
    if (connection && this.#allowed(caller, connection) && !this.#connectors.get(connection.id)!.tools.some((t) => toolName(connection, t) === name)) {
      try { await this.#discover(connection, signal); }
      catch (error) { return { status: "failed", error: error instanceof ConnectorError ? error.code : "connection_check_failed" }; }
    }
    const entry = this.#tools.get(name);
    if (!entry || !this.#allowed(caller, entry.connection)) return { status: "failed", error: "tool_not_available" };
    const parsed = entry.tool.input.safeParse(args ?? {});
    if (!parsed.success) return { status: "failed", error: "invalid_arguments", detail: JSON.parse(JSON.stringify(z.treeifyError(parsed.error))) };
    let input: Json;
    try {
      // What is stored, approved and executed is this canonical JSON; it is never re-parsed.
      input = JSON.parse(canonical(parsed.data)) as Json;
    } catch {
      return { status: "failed", error: "arguments_not_plain_json" };
    }
    if (entry.tool.risk === "read") return this.#execute(entry, input, signal);
    const now = this.#now(), id = randomUUID();
    const summary = (entry.tool.summarize?.(input, entry.connection) ?? `${entry.tool.name} on ${entry.connection.label ?? entry.connection.id}`).slice(0, 2000);
    const content = contentDigest(caller.owner, entry.connection.id, entry.tool.name, input);
    // Pre-approval never repeats a write whose earlier outcome is unknown; the owner decides.
    const auto = this.#preApproved(entry, input) && !this.options.store.hasStatus(content, "uncertain");
    const row: OperationRow = {
      id, owner: caller.owner, agentId: caller.agentId, connectionId: entry.connection.id, tool: entry.tool.name,
      status: auto ? "executing" : "pending", content,
      digest: operationDigest({ id, owner: caller.owner, agentId: caller.agentId, connectionId: entry.connection.id, tool: entry.tool.name, input }),
      createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + this.#ttl * 1000).toISOString(), payload: "",
    };
    const payload: Payload = { input, summary, ...(entry.tool.version ? { definition: entry.tool.version } : {}) };
    row.payload = await this.#seal(row, payload);
    this.options.store.insertOperation(row);
    if (auto) return this.#finish(row, entry, payload, signal);
    return { status: "approval_required", operationId: id, summary, expiresAt: row.expiresAt };
  }

  /** Trusted-service view, used to present the exact operation to its owner. */
  async operation(id: string): Promise<OperationView | undefined> {
    return this.#view(id);
  }

  async pending(): Promise<OperationView[]> {
    const views = await Promise.all(this.options.store.operations("pending").map((row) => this.#view(row.id)));
    return views.filter((v): v is OperationView => v?.status === "pending");
  }

  /** Executes a pending operation once, only for a grant bound to its owner, ID and digest. */
  async approve(grant: Grant, signal: AbortSignal): Promise<CallOutcome> {
    const now = this.#now();
    const row = this.#expire(this.options.store.operation(grant.operationId));
    if (!row) throw new ServiceError("operation_not_found", 404);
    // Opening fails if any bound column or the payload was altered; the digest is then recomputed from them.
    const payload = await this.#open(row);
    const recomputed = operationDigest({ id: row.id, owner: row.owner, agentId: row.agentId, connectionId: row.connectionId, tool: row.tool, input: payload.input });
    if (row.owner !== grant.owner || row.digest !== grant.digest || recomputed !== grant.digest) throw new ServiceError("grant_does_not_match_operation", 403);
    if (row.status !== "pending") throw new ServiceError(`operation_${row.status}`, 409);
    const connection = this.#connections.get(row.connectionId);
    if (connection) {
      try { await this.#discover(connection, signal); }
      catch { throw new ServiceError("connection_unavailable", 409); }
    }
    const entry = connection && this.#tools.get(toolName(connection, { name: row.tool }));
    if (!entry || entry.connection.owner !== row.owner) throw new ServiceError("connection_unavailable", 409);
    if (payload.definition !== entry.tool.version) throw new ServiceError("tool_or_account_changed", 409);
    if (!this.options.store.consume(grant.tokenId, grant.expiresAt, now)) throw new ServiceError("grant_already_used", 409);
    if (!this.options.store.transition(row.id, "pending", "executing", now)) throw new ServiceError("operation_not_pending", 409);
    return this.#finish(row, entry, payload, signal);
  }

  deny(id: string) {
    const row = this.#expire(this.options.store.operation(id));
    if (!row) throw new ServiceError("operation_not_found", 404);
    if (!this.options.store.transition(id, "pending", "denied", this.#now())) throw new ServiceError(`operation_${row.status}`, 409);
  }

  #allowed(caller: Caller, connection: ConnectionConfig) {
    return connection.owner === caller.owner && caller.connections.includes(connection.id);
  }

  #preApproved({ connection, tool }: Entry, input: Json) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return false;
    return (connection.autoApprove ?? []).some((rule) => rule.tool === tool.name &&
      Object.entries(rule.match).every(([key, value]) => Object.hasOwn(input, key) && canonical(input[key]) === canonical(value)));
  }

  async #finish(row: OperationRow, entry: Entry, payload: Payload, signal: AbortSignal): Promise<CallOutcome> {
    const outcome = { ...(await this.#execute(entry, payload.input, signal)), operationId: row.id };
    const final: OperationStatus = outcome.status === "completed" ? "completed" : outcome.status === "uncertain" ? "uncertain" : "failed";
    try {
      const sealed = await this.#seal(row, { ...payload, outcome });
      this.options.store.transition(row.id, "executing", final, this.#now(), sealed);
    } catch {
      // Dispatch already happened. A KMS/storage outage must never make a write retryable.
      this.options.store.transition(row.id, "executing", "uncertain", this.#now());
      return { status: "uncertain", error: "operation_result_not_persisted", operationId: row.id };
    }
    return outcome;
  }

  async #execute({ connection, tool }: Entry, input: Json, signal: AbortSignal): Promise<CallOutcome> {
    try {
      return { status: "completed", result: await tool.execute({ connection, credentials: this.#credentials(connection.id), signal }, input) };
    } catch (error) {
      if (error instanceof ConnectorError) return { status: "failed", error: error.code, ...(error.detail !== undefined ? { detail: error.detail } : {}) };
      // An unknown failure may have taken effect; never retry it automatically.
      return { status: tool.risk === "read" ? "failed" : "uncertain", error: "connector_unexpected_error" };
    }
  }

  #credentials(id: string): Credentials {
    const { store, sealer } = this.options;
    return {
      get: async () => {
        const sealed = store.credential(id);
        return sealed === undefined ? undefined : (JSON.parse(await sealer.open(`credential:${id}`, sealed)) as Json);
      },
      put: async (value) => store.putCredential(id, await sealer.seal(`credential:${id}`, JSON.stringify(value)), this.#now()),
    };
  }

  #expire(row: OperationRow | undefined): OperationRow | undefined {
    if (row?.status === "pending" && Date.parse(row.expiresAt) <= this.#now().getTime()) {
      this.options.store.transition(row.id, "pending", "expired", this.#now());
      return this.options.store.operation(row.id);
    }
    return row;
  }

  async #view(id: string): Promise<OperationView | undefined> {
    const row = this.#expire(this.options.store.operation(id));
    if (!row) return undefined;
    const payload = await this.#open(row);
    return {
      id: row.id, owner: row.owner, agentId: row.agentId, connectionId: row.connectionId, tool: row.tool, digest: row.digest,
      status: row.status, summary: payload.summary, input: payload.input, createdAt: row.createdAt, expiresAt: row.expiresAt,
      ...(payload.outcome ? { outcome: payload.outcome } : {}),
    };
  }

  /** The payload's associated data binds every identifying column, so no column can be changed independently. */
  #context(row: OperationRow) {
    return `operation:${canonical([row.id, row.owner, row.agentId, row.connectionId, row.tool, row.digest, row.content])}`;
  }
  #seal(row: OperationRow, payload: Payload) {
    return this.options.sealer.seal(this.#context(row), JSON.stringify(payload));
  }
  async #open(row: OperationRow): Promise<Payload> {
    try {
      return JSON.parse(await this.options.sealer.open(this.#context(row), row.payload)) as Payload;
    } catch {
      throw new ServiceError("operation_integrity_failed", 409);
    }
  }
}

function toolName(connection: ConnectionConfig, tool: { name: string }) {
  return `${connection.id.replaceAll("-", "_")}__${tool.name}`;
}

/** The digest an approval grant must carry. Binds who, where, what and the exact arguments. */
export function operationDigest(operation: { id: string; owner: string; agentId: string; connectionId: string; tool: string; input: Json }) {
  return digest({ v: 1, ...operation });
}

function contentDigest(owner: string, connectionId: string, tool: string, input: Json) {
  return digest({ v: 1, owner, connectionId, tool, input });
}
