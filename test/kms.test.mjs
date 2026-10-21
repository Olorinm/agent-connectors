import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { EnvelopeSealer, Sealer, ConnectorService, loadConfig } from "../dist/index.js";
import { GoogleKmsWrapper, crc32c } from "../dist/google-kms.js";
import { setup } from "./fixture.mjs";

function wrapper() {
  const master = new Sealer(randomBytes(32));
  const used = [];
  return {
    keyId: "test-kms-key", used, offline: false,
    async wrap(key, context) {
      if (this.offline) throw new Error("SDK request with secret-token");
      used.push(key);
      return master.seal(context, key.toString("base64"));
    },
    async unwrap(value, context) {
      if (this.offline) throw new Error("SDK response with secret-token");
      const key = Buffer.from(master.open(context, value), "base64");
      used.push(key);
      return key;
    },
  };
}

test("envelopes use fresh data keys, bind context and clear key buffers", async () => {
  const keys = wrapper(), sealer = new EnvelopeSealer(keys);
  const first = await sealer.seal("credential:alice", "refresh-secret");
  const second = await sealer.seal("credential:alice", "refresh-secret");
  assert.notEqual(first, second);
  assert.ok(!first.includes("refresh-secret"));
  assert.equal(await sealer.open("credential:alice", first), "refresh-secret");
  await assert.rejects(sealer.open("credential:bob", first), /credential_decryption_unavailable/);
  for (const key of keys.used) assert.deepEqual(key, Buffer.alloc(32));
});

test("envelope parsing refuses tampering, extra fields, wrong key and legacy ciphertext", async () => {
  const sealer = new EnvelopeSealer(wrapper());
  const sealed = await sealer.seal("row", "value");
  for (const patch of [
    { version: "v1" }, { keyId: "other-key" }, { wrapped: "altered" }, { iv: "AA" },
    { tag: "A".repeat(22) }, { body: "A".repeat(7) }, { extra: true }, { body: "!invalid" },
  ]) {
    await assert.rejects(sealer.open("row", JSON.stringify({ ...JSON.parse(sealed), ...patch })), /credential_decryption_unavailable/);
  }
  await assert.rejects(sealer.open("row", new Sealer(randomBytes(32)).seal("row", "old")), /credential_decryption_unavailable/);
});

test("KMS outages fail closed and never expose SDK errors", async () => {
  const keys = wrapper(), sealer = new EnvelopeSealer(keys);
  const sealed = await sealer.seal("row", "value");
  keys.offline = true;
  await assert.rejects(sealer.seal("row", "value"), { message: "credential_encryption_unavailable" });
  await assert.rejects(sealer.open("row", sealed), { message: "credential_decryption_unavailable" });
  assert.ok(keys.used.every((key) => key.every((byte) => byte === 0)));
});

test("KMS failure after a write records uncertainty and blocks replay", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const keys = wrapper();
  const connector = { kind: "kms-test", tools: [{
    ...s.connector.tools.find((tool) => tool.name === "send"),
    execute: async (_context, input) => { s.effects.push(input); keys.offline = true; return { sent: true }; },
  }] };
  const connections = [{ id: "alice-notes", kind: "kms-test", owner: "@alice" }];
  const service = new ConnectorService({ connectors: [connector], connections, store: s.store, sealer: new EnvelopeSealer(keys) });
  const caller = { owner: "@alice", agentId: "agent", connections: ["alice-notes"] };
  const pending = await service.call(caller, "alice_notes__send", { to: "x", text: "hello" }, new AbortController().signal);
  const view = await service.operation(pending.operationId);
  const grant = { owner: "@alice", operationId: view.id, digest: view.digest, tokenId: "once", expiresAt: new Date(Date.now() + 60_000) };
  const result = await service.approve(grant, new AbortController().signal);
  assert.equal(result.status, "uncertain");
  assert.equal(s.store.operation(view.id).status, "uncertain");
  keys.offline = false;
  await assert.rejects(service.approve(grant, new AbortController().signal), /operation_uncertain/);
  assert.equal(s.effects.length, 1);
});

const keyName = "projects/test-project/locations/asia-southeast1/keyRings/mau/cryptoKeys/connectors";
test("Google KMS sends bound AAD and verifies response identity and CRC32C", async () => {
  assert.equal(crc32c(Buffer.from("123456789")), 0xe3069283);
  const key = randomBytes(32), encrypted = Buffer.from("kms-ciphertext");
  let corrupt = false;
  const client = {
    async encrypt(request) {
      assert.equal(request.name, keyName);
      assert.equal(request.plaintextCrc32c.value, crc32c(key));
      assert.equal(request.additionalAuthenticatedData.toString(), "bound-context");
      return [{
        name: `${corrupt ? "wrong" : keyName}/cryptoKeyVersions/1`,
        ciphertext: encrypted, ciphertextCrc32c: { value: crc32c(encrypted) },
        verifiedPlaintextCrc32c: true, verifiedAdditionalAuthenticatedDataCrc32c: true,
      }];
    },
    async decrypt(request) {
      assert.equal(request.name, keyName);
      assert.deepEqual(request.ciphertext, encrypted);
      return [{ plaintext: key, plaintextCrc32c: { value: crc32c(key) + (corrupt ? 1 : 0) } }];
    },
  };
  const kms = new GoogleKmsWrapper({ keyName }, client);
  const sealed = await kms.wrap(key, "bound-context");
  assert.deepEqual(await kms.unwrap(sealed, "bound-context"), key);
  corrupt = true;
  await assert.rejects(kms.wrap(key, "bound-context"), { message: "kms_encrypt_failed" });
  await assert.rejects(kms.unwrap(sealed, "bound-context"), { message: "kms_decrypt_failed" });
  await assert.rejects(kms.unwrap("not valid base64", "bound-context"), /kms_decrypt_failed/);
});

test("configuration requires explicit encryption and refuses public development keys", async (t) => {
  const s = await setup(); t.after(s.cleanup);
  const file = join(s.directory, "config.json");
  const base = {
    listen: { host: "0.0.0.0", port: 18100 }, stateDirectory: "state",
    trust: { issuer: "https://router.example", callerKeys: "caller.json", authorityKeys: "authority.json" }, connections: [],
  };
  writeFileSync(file, JSON.stringify({ ...base, encryption: { provider: "development-file", keyFile: "key" } }));
  assert.throws(() => loadConfig(file), /development_encryption_requires_loopback/);
  writeFileSync(file, JSON.stringify({ ...base, keyFile: "old-format" }));
  assert.throws(() => loadConfig(file));
  writeFileSync(file, JSON.stringify({ ...base, encryption: { provider: "google-cloud-kms", keyName,
    workloadIdentity: { audience: "https://attacker.example", tokenFile: "token" } } }));
  assert.throws(() => loadConfig(file));
});
