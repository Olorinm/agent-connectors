import type { z } from "zod";
import type { Json } from "./canonical.js";

/**
 * read: no external side effect; runs directly.
 * write: changes something outside (send, submit, delete); runs only with an owner grant
 * unless the owner's policy allows its operation or the connection's autoApprove rules match the exact arguments.
 */
export type Risk = "read" | "write";

export interface ConnectionConfig {
  /** Stable lowercase ID, e.g. "work-mail". Appears in tool names. */
  id: string;
  kind: string;
  owner: string;
  label?: string;
  settings?: Record<string, Json>;
  /** Write calls whose arguments contain exactly these values run without a grant. */
  autoApprove?: Array<{ tool: string; match: Record<string, Json> }>;
}

export interface Credentials {
  get(): Json | undefined | Promise<Json | undefined>;
  /** Persists rotated tokens (e.g. OAuth refresh). */
  put(value: Json): void | Promise<void>;
}

export interface ToolContext {
  connection: ConnectionConfig;
  credentials: Credentials;
  signal: AbortSignal;
}

export interface ToolDefinition<Input = any> {
  name: string;
  description: string;
  risk: Risk;
  /**
   * Owner-adjustable operations this tool can perform (IDs from the connector's `operations` catalog), used to hide
   * the tool when the owner allows none of them. `[]` marks a tool outside the policy (status, guidance).
   */
  operations?: string[];
  /**
   * The operation one call performs, decided before anything runs; null when the call has no effect worth a policy
   * (help, schema, dry run). Without it, a tool with exactly one entry in `operations` performs that one.
   * Throws ConnectorError for arguments the tool would refuse anyway.
   */
  operation?(context: ToolContext, input: Input): string | null | Promise<string | null>;
  input: z.ZodType<Input>;
  /** Original upstream schema; input must validate it without transforming arguments. */
  inputSchema?: Record<string, unknown>;
  /** Binds pending approvals to an account generation and upstream tool definition. */
  version?: string;
  /**
   * Top-level arguments that decide where a write lands (table, mailbox, recipient).
   * autoApprove rules must pin all of them; a write without targets cannot be pre-approved.
   */
  targets?: string[];
  /** Owner-facing description of the exact effect, shown on the approval device. */
  summarize?(input: Input, connection: ConnectionConfig): string;
  /** Receives the canonical JSON that was validated (and, for writes, approved); it is not re-parsed. */
  execute(context: ToolContext, input: Input): Promise<Json>;
}

/**
 * owner_private: the tools act as the owner's personal identity. Products must admit calls only from the owner's
 * private conversation (never groups, other senders or delegated work); this service reports it, products enforce it.
 */
export type ConnectionUsage = "owner_private";

/** read and write as for tools; destructive marks writes that delete or cannot be undone. */
export type OperationRisk = "read" | "write" | "destructive";
export type PolicySetting = "allow" | "ask" | "deny";

export interface OperationGroup { id: string; label: string; labelZh: string }

/**
 * One owner-adjustable operation: allow runs it directly, ask needs the owner's approval for each call, deny hides
 * and refuses it. The default is allow for reads and ask otherwise.
 */
export interface OperationSpec {
  id: string;
  /** A group ID, or "background" for work the connector does on its own. */
  group: string;
  label: string;
  labelZh: string;
  risk: OperationRisk;
  /** Upstream authorization scopes, any one of which permits the operation. */
  scopes?: string[];
  /** The narrowest scope to request when the owner adds this operation to an existing authorization. */
  grantScope?: string;
  /** Listed for completeness; this connector does not offer it. */
  supported?: false;
}

export interface OperationCatalog { groups: OperationGroup[]; operations: OperationSpec[] }

export interface Connector {
  kind: string;
  tools: ToolDefinition[];
  usage?: ConnectionUsage;
  discover?(context: ToolContext): Promise<ToolDefinition[]>;
  /** Operations the owner can set per connection. Without it every tool is one of two operations by its risk. */
  operations?(connection: ConnectionConfig): OperationCatalog;
  account?: {
    status(context: ToolContext): Promise<Json>;
    /** `scopes` adds upstream scopes to the existing authorization (incremental consent) when `scopes` below exists. */
    connect(context: ToolContext, input?: { scopes?: string[] }): Promise<Json>;
    /** Scopes granted (or, before authorization, requested); undefined when the connector does not track scopes. */
    scopes?(context: ToolContext): Promise<string[] | undefined>;
    disconnect(context: ToolContext): Promise<Json>;
    /** Finishes a consent flow that has no browser callback (device flow). */
    complete?(context: ToolContext): Promise<Json>;
    /** Trusted product hand-over of application configuration; never returns secrets. */
    configure?(context: ToolContext, input: unknown): Promise<Json>;
    /** Returns false for a state belonging to another connection. */
    callback?(context: ToolContext, state: string, code?: string): Promise<boolean>;
  };
}

/** A known failure: the operation did not take effect. Other exceptions are treated as uncertain. */
export class ConnectorError extends Error {
  constructor(readonly code: string, readonly detail?: Json) {
    super(code);
  }
}
