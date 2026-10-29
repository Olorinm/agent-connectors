import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../cloudflare/src/key-vault.mjs';
import { CloudflareSecretsWrapper } from '../dist/cloudflare-secrets.js';
import { EnvelopeSealer } from '../dist/index.js';

const env = () => ({ KEY_ID: 'test-key', CALLER_TOKEN: randomBytes(32).toString('base64url'), WRAPPING_KEY: randomBytes(32).toString('base64url') });
const context = 'a'.repeat(64);
const request = (e, path, body, headers = {}) => new Request('https://vault.example' + path, { method: 'POST', headers: { Authorization: `Bearer ${e.CALLER_TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
const input = (e, value) => ({ keyId: 'cloudflare-worker-secrets:' + e.KEY_ID, context, value });

test('Worker wraps fresh 32-byte data keys and binds ciphertext to key identity and context', async () => {
  const e = env(), data = randomBytes(32).toString('base64url');
  const first = await (await worker.fetch(request(e, '/v1/wrap', input(e, data)), e)).json();
  const second = await (await worker.fetch(request(e, '/v1/wrap', input(e, data)), e)).json();
  assert.notEqual(first.value, second.value); assert.ok(!first.value.includes(data));
  const decrypted = await worker.fetch(request(e, '/v1/unwrap', input(e, first.value)), e);
  assert.equal((await decrypted.json()).value, data);
  for (const patch of [{ context: 'b'.repeat(64) }, { keyId: 'cloudflare-worker-secrets:other' }, { value: first.value + '.extra' }, { value: 'v1.AA.AA' }, { extra: 'secret' }]) {
    assert.equal((await worker.fetch(request(e, '/v1/unwrap', { ...input(e, first.value), ...patch }), e)).status, 400);
  }
  assert.equal((await worker.fetch(request(e, '/v1/wrap', input(e, randomBytes(64).toString('base64url'))), e)).status, 400);
});
test('Worker refuses anonymous/browser callers, wrong endpoints, oversized requests, and throttled calls', async () => {
  const e = env(), value = input(e, randomBytes(32).toString('base64url'));
  assert.equal((await worker.fetch(request(e, '/v1/wrap', value, { Authorization: 'Bearer wrong' }), e)).status, 401);
  assert.equal((await worker.fetch(request(e, '/v1/wrap', value, { Origin: 'https://router.example' }), e)).status, 401);
  assert.equal((await worker.fetch(request(e, '/v1/export', value), e)).status, 404);
  assert.equal((await worker.fetch(request(e, '/v1/wrap?redirect=evil', value), e)).status, 404);
  assert.equal((await worker.fetch(request(e, '/v1/wrap', { ...value, value: 'x'.repeat(3000) }), e)).status, 400);
  assert.equal((await worker.fetch(request(e, '/v1/wrap', value), { ...e, LIMITER: { limit: async () => ({ success: false }) } })).status, 429);
  assert.equal((await worker.fetch(request(e, '/v1/wrap', value), { ...e, WRAPPING_KEY: '' })).status, 503);
});
test('remote wrapper composes with envelope encryption, never follows redirects or falls back on failure', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'connector-vault-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const e = env(), tokenFile = join(directory, 'token'); writeFileSync(tokenFile, e.CALLER_TOKEN, { mode: 0o600 });
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0, fail = false;
  globalThis.fetch = async (url, options) => { calls++; assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    if (fail) return new Response('sensitive provider detail', { status: 502 });
    return worker.fetch(new Request(url, options), e);
  };
  const config = { provider: 'cloudflare-worker-secrets', keyId: e.KEY_ID, tokenFile, url: 'https://vault.example' };
  const wrapper = new CloudflareSecretsWrapper(config), sealer = new EnvelopeSealer(wrapper);
  const encrypted = await sealer.seal('credential:owner-account', 'oauth-refresh-token');
  assert.equal(await sealer.open('credential:owner-account', encrypted), 'oauth-refresh-token');
  await assert.rejects(sealer.open('credential:other-account', encrypted), /credential_decryption_unavailable/);
  const before = calls; fail = true;
  await assert.rejects(sealer.open('credential:owner-account', encrypted), { message: 'credential_decryption_unavailable' });
  assert.equal(calls, before + 1);
  for (const url of ['http://vault.example', 'https://user:password@vault.example', 'https://vault.example/path', 'https://vault.example?token=secret'])
    assert.throws(() => new CloudflareSecretsWrapper({ ...config, url }), /wrapping_endpoint_invalid/);
  chmodSync(tokenFile, 0o644); assert.throws(() => new CloudflareSecretsWrapper(config), /wrapping_token_must_be_private/);
});
