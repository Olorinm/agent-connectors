import type { z } from "zod";
import type { Json } from "./canonical.js";

/**
 * read: no external side effect; runs directly.
 * write: changes something outside (send, submit, delete); runs only with an owner grant
 * unless the connection's autoApprove rules match the exact arguments.
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

export interface Connector {
  kind: string;
  tools: ToolDefinition[];
  discover?(context: ToolContext): Promise<ToolDefinition[]>;
  account?: {
    status(context: ToolContext): Promise<Json>;
    connect(context: ToolContext): Promise<Json>;
    disconnect(context: ToolContext): Promise<Json>;
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
