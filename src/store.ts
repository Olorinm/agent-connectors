import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OperationStatus = "pending" | "executing" | "completed" | "failed" | "uncertain" | "denied" | "expired";

export interface OperationRow {
  id: string;
  owner: string;
  agentId: string;
  connectionId: string;
  tool: string;
  digest: string;
  /** Digest of owner, connection, tool and input, without the operation ID: finds repeats. */
  content: string;
  status: OperationStatus;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  /** Sealed {input, summary, result?, error?}; never stored in plaintext. */
  payload: string;
}

/** SQLite state. Rollback journal (not WAL) so every file on disk keeps the 0600 mode. */
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const file = join(directory, "connectors.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS credentials (connection_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent_id TEXT NOT NULL, connection_id TEXT NOT NULL, tool TEXT NOT NULL,
        digest TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS operations_status ON operations (status, owner);
      CREATE INDEX IF NOT EXISTS operations_content ON operations (content, status);
      CREATE TABLE IF NOT EXISTS consumed_tokens (jti TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
    `);
  }
  credential(connectionId: string): string | undefined {
    const row = this.db.prepare("SELECT sealed FROM credentials WHERE connection_id = ?").get(connectionId) as { sealed: string } | undefined;
    return row?.sealed;
  }
  putCredential(connectionId: string, sealed: string, now: Date) {
    this.db.prepare(
      "INSERT INTO credentials (connection_id, sealed, updated_at) VALUES (?, ?, ?) ON CONFLICT(connection_id) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at",
    ).run(connectionId, sealed, now.toISOString());
  }
  insertOperation(row: OperationRow) {
    this.db.prepare(
      "INSERT INTO operations (id, owner, agent_id, connection_id, tool, digest, content, status, created_at, expires_at, updated_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(row.id, row.owner, row.agentId, row.connectionId, row.tool, row.digest, row.content, row.status, row.createdAt, row.expiresAt, row.updatedAt, row.payload);
  }
  operation(id: string): OperationRow | undefined {
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Record<string, string> | undefined;
    return row && fromRow(row);
  }
  operations(status: OperationStatus): OperationRow[] {
    return (this.db.prepare("SELECT * FROM operations WHERE status = ? ORDER BY created_at").all(status) as Record<string, string>[]).map(fromRow);
  }
  hasStatus(content: string, status: OperationStatus): boolean {
    return this.db.prepare("SELECT 1 FROM operations WHERE content = ? AND status = ? LIMIT 1").get(content, status) !== undefined;
  }
  /** Compare-and-set; returns false when another caller already moved the operation. */
  transition(id: string, from: OperationStatus, to: OperationStatus, now: Date, payload?: string): boolean {
    const result = payload === undefined
      ? this.db.prepare("UPDATE operations SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(to, now.toISOString(), id, from)
      : this.db.prepare("UPDATE operations SET status = ?, updated_at = ?, payload = ? WHERE id = ? AND status = ?").run(to, now.toISOString(), payload, id, from);
    return result.changes === 1;
  }
  /** Records a single-use token ID; returns false when it was already used. */
  consume(jti: string, expiresAt: Date, now: Date): boolean {
    // Keep IDs past expiry plus the verifier's clock tolerance.
    this.db.prepare("DELETE FROM consumed_tokens WHERE expires_at < ?").run(new Date(now.getTime() - 120_000).toISOString());
    return this.db.prepare("INSERT OR IGNORE INTO consumed_tokens (jti, expires_at) VALUES (?, ?)").run(jti, expiresAt.toISOString()).changes === 1;
  }
  close() {
    this.db.close();
  }
}

function fromRow(row: Record<string, string>): OperationRow {
  return {
    id: row.id!, owner: row.owner!, agentId: row.agent_id!, connectionId: row.connection_id!, tool: row.tool!, digest: row.digest!, content: row.content!,
    status: row.status as OperationStatus, createdAt: row.created_at!, expiresAt: row.expires_at!, updatedAt: row.updated_at!, payload: row.payload!,
  };
}
