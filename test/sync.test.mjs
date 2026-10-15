import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { sendBatch, Sync } from "../src/sync.mjs";
import { readOptions } from "../src/config.mjs";
import { tempDirectory } from "./helpers.mjs";

const payload = { entity: "magpie", type: "app", category: "ai coding", time: 1792026000.123,
  project: "Magpie", ai_input_tokens: 110, ai_cached_input_tokens: 20, ai_output_tokens: 30, is_write: false };
function enqueue(store, n) { store.ingest(Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, payload }))); }

test("sends at most 25 and confirms each bulk result independently", async () => {
  const store = new Store(":memory:");
  let posted;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    expect(request.headers.get("authorization")).toBe("Basic MTIzNDU=");
    expect(request.headers.get("user-agent")).toContain("Magpie/");
    expect(new URL(request.url).search).toBe("");
    posted = await request.json();
    return Response.json({ responses: posted.map((_, i) => [i === 0 ? { errors: { entity: ["bad"] } } : { data: { id: `${i}` } }, i === 0 ? 400 : 201]) }, { status: 201 });
  } });
  const fetcher = (url, init) => {
    expect(url).toBe("https://api.wakatime.com/api/v1/users/current/heartbeats.bulk");
    expect(init.redirect).toBe("manual");
    return fetch(server.url, init);
  };
  try {
    enqueue(store, 26);
    await sendBatch(store, "12345", { now: 1000, fetcher });
    expect(posted).toHaveLength(25);
    expect(posted[0]).toEqual(payload);
    expect(store.status()).toMatchObject({ pending: 1, sent: 24, rejected: 1 });
    expect(store.pending(1000)[0].id).toBe("row-25");
  } finally { store.close(); server.stop(true); }
});

test("honors Retry-After and retries original payload without erasing the queue", async () => {
  const store = new Store(":memory:");
  let requests = 0, retried;
  const fetcher = async (_url, init) => {
    requests++;
    if (requests === 1) return new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });
    retried = JSON.parse(init.body);
    return Response.json({ responses: [[{ data: { id: "ok" } }, 202]] }, { status: 202 });
  };
  try {
    enqueue(store, 1);
    await sendBatch(store, "test-key", { now: 1000, fetcher });
    await sendBatch(store, "test-key", { now: 60_999, fetcher });
    expect(requests).toBe(1);
    expect(store.status().pending).toBe(1);
    await sendBatch(store, "test-key", { now: 61_000, fetcher });
    expect(retried).toEqual([payload]);
    expect(store.status().sent).toBe(1);
  } finally { store.close(); }
});

test("does not confirm malformed or missing results and never stores error bodies", async () => {
  const store = new Store(":memory:");
  try {
    enqueue(store, 2);
    const fetcher = async () => Response.json({ responses: [[{ data: { id: "one" } }, 201]] }, { status: 201 });
    await sendBatch(store, "secret", { now: 1000, fetcher });
    expect(store.status()).toMatchObject({ pending: 1, sent: 1 });
    await sendBatch(store, "secret", { now: 1_000_000, fetcher: async () => { throw new Error("private error secret"); } });
    expect(JSON.stringify(store.status())).not.toContain("private");
    expect(store.status().pending).toBe(1);
  } finally { store.close(); }
});

test("pauses on authentication failure and rechecks ownership before sending", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const fetcher = async () => { calls++; return new Response("private", { status: 401 }); };
  try {
    enqueue(store, 1);
    await sendBatch(store, "secret", { now: 1000, fetcher, guard: () => false });
    expect(calls).toBe(0);
    expect((await sendBatch(store, "secret", { now: 2000, fetcher })).auth).toBe(true);
    expect(store.status()).toMatchObject({ pending: 1, sent: 0, sendError: "wakatime-http-401" });
  } finally { store.close(); }
});

test("missing credentials never activate collection; only one host uploads; disabled hosts stop", async () => {
  const directory = tempDirectory();
  const env = { WAKATIME_HOME: directory };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ rows: [], total: 0, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin });
  let enabled = true, uploads = 0;
  const fetcher = async () => {
    uploads++;
    return Response.json({ responses: [[{ data: { id: "ok" } }, 201]] }, { status: 201 });
  };
  const a = new Sync(directory, options, { env, enabled: () => enabled, fetcher });
  const b = new Sync(directory, options, { env, enabled: () => enabled, fetcher });
  try {
    const now = Date.now();
    await a.tick(now);
    expect(a.store.get("enabledAt")).toBeNull();
    expect(a.store.status().credentials).toBe("missing-key");
    env.WAKATIME_API_KEY = "fake-key";
    await a.tick(now + 1000);
    expect(a.store.get("enabledAt")).toBe(now + 1000);
    enqueue(a.store, 1);
    await Promise.all([a.tick(now + 2000), b.tick(now + 2000)]);
    expect(uploads).toBe(1);
    enabled = false;
    enqueue(a.store, 2);
    await a.tick(now + 4000);
    expect(uploads).toBe(1);
  } finally { await a.stop(); await b.stop(); server.stop(true); rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});
