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
  get(): Json | undefined;
  /** Persists rotated tokens (e.g. OAuth refresh). */
  put(value: Json): void;
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
}

/** A known failure: the operation did not take effect. Other exceptions are treated as uncertain. */
export class ConnectorError extends Error {
  constructor(readonly code: string, readonly detail?: Json) {
    super(code);
  }
}
