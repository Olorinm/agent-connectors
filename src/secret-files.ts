import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { ValueSealer } from "./sealer.js";

const CONTEXT = "agent-connectors:secret-files:v1";
const MAX_BYTES = 16 * 1024 * 1024;
const filesSchema = z.record(z.string(), z.string());

/** No links, absolute paths, dot segments or platform-dependent path separators. */
export function secretPath(path: string): string {
  if (!path || isAbsolute(path) || /[\\:\u0000-\u001f]/.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === ".."))
    throw new Error("secret_file_path_invalid");
  return path;
}

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null);
  let bytes = 0;
  function visit(relative: string) {
    const path = join(directory, relative);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("secret_file_link_refused");
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) {
      secretPath(relative);
      bytes += stat.size;
      if (bytes > MAX_BYTES || Object.keys(files).length >= 2048) throw new Error("secret_files_too_large");
      files[relative] = readFileSync(path).toString("base64");
    } else throw new Error("secret_file_type_refused");
  }
  visit("");
  return files;
}

function parse(value: string): Record<string, string> {
  if (Buffer.byteLength(value) > MAX_BYTES * 2) throw new Error("secret_files_too_large");
  const files = filesSchema.parse(JSON.parse(value));
  let size = 0;
  if (Object.keys(files).length > 2048) throw new Error("secret_files_too_large");
  for (const [path, encoded] of Object.entries(files)) {
    secretPath(path);
    const content = Buffer.from(encoded, "base64");
    if (content.toString("base64") !== encoded) throw new Error("secret_file_encoding_invalid");
    size += content.length;
    if (size > MAX_BYTES) throw new Error("secret_files_too_large");
  }
  return files;
}

function atomicWrite(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.partial`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, value); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally { rmSync(temporary, { force: true }); }
}

/** Encrypted durable files; plaintext exists only in a dedicated memory-backed runtime directory. */
export class SecretFiles {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private closed = false;
  private digest = "";
  private constructor(readonly file: string, runtimeDirectory: string, private readonly sealer: ValueSealer) {
    this.directory = mkdtempSync(join(runtimeDirectory, "secrets-"));
    chmodSync(this.directory, 0o700);
  }
  static async open(file: string, runtimeDirectory: string, sealer: ValueSealer, requireMemory = true) {
    // Production accepts Linux tmpfs only, including Kubernetes emptyDir.medium: Memory.
    if (requireMemory && (process.platform !== "linux" || statfsSync(runtimeDirectory).type !== 0x01021994))
      throw new Error("secret_files_require_tmpfs");
    const vault = new SecretFiles(resolve(file), runtimeDirectory, sealer);
    try {
      if (existsSync(file)) {
        const files = parse(await sealer.open(CONTEXT, readFileSync(file, "utf8")));
        for (const [path, content] of Object.entries(files)) {
          const target = join(vault.directory, path);
          mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, Buffer.from(content, "base64"), { mode: 0o600, flag: "wx" });
        }
      }
      vault.digest = vault.hash();
      return vault;
    } catch (error) { await vault.close(); throw error; }
  }
  static async import(directory: string, file: string, sealer: ValueSealer) {
    if (existsSync(file)) throw new Error("secret_file_bundle_already_exists");
    atomicWrite(file, await sealer.seal(CONTEXT, JSON.stringify(snapshot(directory))));
  }
  /** Serialize all official CLI file changes, including token refresh, and checkpoint before returning. */
  run<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.closed || this.failed) throw new Error("secret_file_store_unavailable");
      try { return await operation(); }
      finally {
        try {
          const contents = JSON.stringify(snapshot(this.directory));
          const digest = createHash("sha256").update(contents).digest("hex");
          if (digest !== this.digest) {
            atomicWrite(this.file, await this.sealer.seal(CONTEXT, contents));
            this.digest = digest;
          }
        } catch {
          // A refresh/write may have succeeded. Refuse subsequent calls until the operator recovers.
          this.failed = true;
          throw new Error("secret_file_persistence_failed");
        }
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
  private hash() { return createHash("sha256").update(JSON.stringify(snapshot(this.directory))).digest("hex"); }
  async close() {
    this.closed = true;
    await this.queue;
    rmSync(this.directory, { recursive: true, force: true });
  }
}
