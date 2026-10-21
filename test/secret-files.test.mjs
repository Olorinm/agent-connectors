import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Sealer } from "../dist/sealer.js";
import { SecretFiles, secretPath } from "../dist/secret-files.js";
import { FeishuAccount, loadFeishuCredentials } from "../dist/connectors/feishu/account.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "connector-secret-files-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"), runtime = join(directory, "runtime"), file = join(directory, "encrypted/bundle");
  mkdirSync(source, { mode: 0o700 }); mkdirSync(runtime, { mode: 0o700 });
  const sealer = new Sealer(randomBytes(32));
  return { directory, source, runtime, file, sealer };
}

test("application and CLI files persist encrypted, refresh survives restart and runtime files are removed", async (t) => {
  const f = fixture(t);
  mkdirSync(join(f.source, "feishu"));
  writeFileSync(join(f.source, "google.json"), '{"client_secret":"google-secret"}');
  writeFileSync(join(f.source, "feishu/token.json"), '{"refresh_token":"old-token"}');
  await SecretFiles.import(f.source, f.file, f.sealer);
  await assert.rejects(SecretFiles.import(f.source, f.file, f.sealer), /already_exists/);
  let vault = await SecretFiles.open(f.file, f.runtime, f.sealer, false);
  assert.equal(statSync(join(vault.directory, "google.json")).mode & 0o777, 0o600);
  await vault.run(async () => writeFileSync(join(vault.directory, "feishu/token.json"), '{"refresh_token":"new-token"}'));
  const sealed = readFileSync(f.file, "utf8");
  for (const value of ["google-secret", "old-token", "new-token"]) assert.ok(!sealed.includes(value));
  const oldDirectory = vault.directory;
  await vault.close();
  assert.equal(existsSync(oldDirectory), false);
  vault = await SecretFiles.open(f.file, f.runtime, f.sealer, false);
  assert.notEqual(vault.directory, oldDirectory);
  assert.equal(JSON.parse(readFileSync(join(vault.directory, "feishu/token.json"))).refresh_token, "new-token");
  await vault.close();
});

test("file writes are serialized; persistence failure prevents subsequent execution", async (t) => {
  const f = fixture(t);
  let offline = false, executed = 0;
  const sealer = { open: (...args) => f.sealer.open(...args), seal: (...args) => {
    if (offline) throw new Error("sensitive-upstream-error");
    return f.sealer.seal(...args);
  } };
  const vault = await SecretFiles.open(f.file, f.runtime, sealer, false);
  const sequence = [];
  await Promise.all([1, 2].map((n) => vault.run(async () => {
    sequence.push(`start${n}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeFileSync(join(vault.directory, "token"), String(n));
    sequence.push(`end${n}`);
  })));
  assert.deepEqual(sequence, ["start1", "end1", "start2", "end2"]);
  offline = true;
  await assert.rejects(vault.run(async () => { executed++; writeFileSync(join(vault.directory, "token"), "rotated"); }),
    { message: "secret_file_persistence_failed" });
  await assert.rejects(vault.run(async () => { executed++; }), /secret_file_store_unavailable/);
  assert.equal(executed, 1);
  await vault.close();
});

test("secret paths, symlinks, wrong context and non-memory production mounts are refused", async (t) => {
  const f = fixture(t);
  assert.equal(secretPath("feishu/app-secret"), "feishu/app-secret");
  for (const path of ["", "/", "../x", "a/../b", "a//b", "./x", "a\\b", "c:x", "a\nb"])
    assert.throws(() => secretPath(path), /path_invalid/);
  symlinkSync("/etc/hosts", join(f.source, "link"));
  await assert.rejects(SecretFiles.import(f.source, f.file, f.sealer), /link_refused/);
  assert.equal(existsSync(f.file), false);
  mkdirSync(join(f.directory, "encrypted"));
  writeFileSync(f.file, f.sealer.seal("another-purpose", "{}"));
  await assert.rejects(SecretFiles.open(f.file, f.runtime, f.sealer, false));
  assert.deepEqual(readdirSync(f.runtime), []);
  // This suite runs on a disk-backed temporary directory; deployment acceptance tests Linux tmpfs.
  if (process.platform !== "linux") await assert.rejects(SecretFiles.open(f.file, f.runtime, f.sealer), /require_tmpfs/);
});

test("restored Feishu configuration uses the new runtime secret path and retains rotated CLI tokens", async (t) => {
  const f = fixture(t), source = join(f.source, "feishu");
  mkdirSync(source);
  writeFileSync(join(source, "credentials.json"), JSON.stringify({
    version: 1, appId: "cli_test", appSecretFile: "app-secret", domain: "feishu", ownerOpenId: "ou_test",
  }));
  writeFileSync(join(source, "app-secret"), "private-app-secret");
  await SecretFiles.import(f.source, f.file, f.sealer);
  let vault = await SecretFiles.open(f.file, f.runtime, f.sealer, false);
  const runner = async (_args, { env }) => {
    const config = JSON.parse(readFileSync(join(env.LARKSUITE_CLI_CONFIG_DIR, "config.json")));
    assert.equal(readFileSync(config.apps[0].appSecret.id, "utf8"), "private-app-secret");
    writeFileSync(join(env.LARKSUITE_CLI_DATA_DIR, "token.json"), '{"token":"rotated-token"}');
    return { code: 0, stdout: JSON.stringify({ appId: "cli_test", identities: { user: {
      openId: "ou_test", available: true, tokenStatus: "valid",
    } } }), stderr: "" };
  };
  const account = () => {
    const loaded = loadFeishuCredentials(join(vault.directory, "feishu/credentials.json"));
    return new FeishuAccount(loaded.credentials, loaded.directory, runner);
  };
  await vault.run(() => account().status());
  await vault.close();
  vault = await SecretFiles.open(f.file, f.runtime, f.sealer, false);
  assert.equal(JSON.parse(readFileSync(join(vault.directory, "feishu/cli-data/token.json"))).token, "rotated-token");
  assert.equal((await vault.run(() => account().status())).authorized, true);
  const credentialsPath = join(vault.directory, "feishu/credentials.json");
  const credentials = JSON.parse(readFileSync(credentialsPath));
  credentials.appSecretFile = "../outside";
  writeFileSync(credentialsPath, JSON.stringify(credentials));
  assert.throws(() => loadFeishuCredentials(credentialsPath), /path_invalid/);
  await vault.close();
});
