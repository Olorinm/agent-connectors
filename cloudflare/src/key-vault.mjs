// Dedicated Worker: never deploy this entrypoint over the existing read broker.
// No mail, provider tokens or operation bodies are accepted; only 32-byte envelope data keys.
const json = (value, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const bytes = value => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
  const raw = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const result = Uint8Array.from(raw, c => c.charCodeAt(0));
  if (encoded(result) !== value) throw Error();
  return result;
};
const encoded = value => btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
async function equal(a, b) {
  const digest = value => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  const first = new Uint8Array(x), second = new Uint8Array(y); let different = 0;
  for (let i = 0; i < first.length; i++) different |= first[i] ^ second[i];
  return different === 0;
}
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return json({ service: "agent-connectors-key-vault", revision: env.SOURCE_REVISION ?? null });
  if (!env.CALLER_TOKEN || !env.WRAPPING_KEY || !env.KEY_ID) return json({ error: "not_configured" }, 503);
  if (request.headers.has("Origin") || !await equal(request.headers.get("Authorization") ?? "", `Bearer ${env.CALLER_TOKEN}`)) return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST" || !["/v1/wrap", "/v1/unwrap"].includes(url.pathname) || url.search) return json({ error: "not_found" }, 404);
  if (env.LIMITER && !(await env.LIMITER.limit({ key: "key-vault" })).success) return json({ error: "rate_limited" }, 429);
  try {
    if (Number(request.headers.get("Content-Length")) > 2048 || !request.body) return json({ error: "invalid_request" }, 400);
    const reader = request.body.getReader(); let text = ""; const decoder = new TextDecoder();
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      text += decoder.decode(value, { stream: true }); if (text.length > 2048) throw Error(); }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const input = JSON.parse(text), keyId = `cloudflare-worker-secrets:${env.KEY_ID}`;
    if (Object.keys(input).sort().join(",") !== "context,keyId,value" || input.keyId !== keyId || !/^[0-9a-f]{64}$/.test(input.context) || typeof input.value !== "string" || input.value.length > 512) throw Error();
    const rawKey = bytes(env.WRAPPING_KEY);
    if (rawKey.length !== 32) throw Error();
    let key;
    try { key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt", "decrypt"]); }
    finally { rawKey.fill(0); }
    const additionalData = new TextEncoder().encode(JSON.stringify({ version: 1, keyId, context: input.context }));
    if (url.pathname === "/v1/wrap") {
      const data = bytes(input.value), iv = crypto.getRandomValues(new Uint8Array(12));
      if (data.length !== 32) throw Error();
      try {
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, data);
        return json({ keyId, value: `v1.${encoded(iv)}.${encoded(new Uint8Array(ciphertext))}` });
      } finally { data.fill(0); }
    }
    const parts = input.value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") throw Error();
    const iv = bytes(parts[1]), ciphertext = bytes(parts[2]);
    if (iv.length !== 12 || ciphertext.length !== 48) throw Error();
    const data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData }, key, ciphertext));
    try { if (data.length !== 32) throw Error(); return json({ keyId, value: encoded(data) }); }
    finally { data.fill(0); }
  } catch { return json({ error: "key_operation_refused" }, 400); }
} };
