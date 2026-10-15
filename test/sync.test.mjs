import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { sendBatch, Sync } from "../src/sync.mjs";
import { readOptions } from "../src/config.mjs";
import { localDay } from "../src/source.mjs";
import { mapRow } from "../src/map.mjs";
import { tempDirectory } from "./helpers.mjs";

const payload = { entity: "magpie", type: "app", category: "ai coding", time: 1792026000.123,
  project: "Magpie", ai_input_tokens: 110, ai_cached_input_tokens: 20, ai_output_tokens: 30, is_write: false };
function enqueue(store, n) { store.ingest(Array.from({ length: n }, (_, i) => ({ id: `row-${i}`, payload }))); }

test("continues to today's usage when backfill contains an invalid row", async () => {
  const directory = tempDirectory();
  const now = Date.now(), today = localDay(now), yesterday = localDay(now, -1);
  const requestedDays = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const day = new URL(request.url).searchParams.get("period").split("..")[0];
    requestedDays.push(day);
    const rows = day === yesterday ? [{ t: "bad", in: 10, out: 2 }] :
      [{ t: new Date(now).toISOString(), agent: "codex", in: 10, out: 2 }];
    return Response.json({ rows, total: rows.length, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin });
  const worker = new Sync(directory, options);
  try {
    worker.store.activate(options.gatewayUrl, new Date(`${yesterday}T00:00:00`).getTime());
    await worker.scan(now);
    expect(requestedDays).toContain(today);
    expect(worker.store.status()).toMatchObject({ pending: 1, lastCompleteDay: today,
      lastInvalidRow: { day: yesterday, error: "invalid-row" } });
  } finally { await worker.stop(); server.stop(true); rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});

test("preserves each model in a mixed bulk request and its retry", async () => {
  const store = new Store(":memory:");
  const options = readOptions();
  const row = { t: "2026-10-15T01:02:03Z", agent: "codex", in: 10, out: 2 };
  const items = [
    { id: "gpt", payload: mapRow({ ...row, model: "gpt-5.4", effort: "high" }, options, "salt") },
    { id: "claude", payload: mapRow({ ...row, model: "claude-sonnet-4-6", effort: "low" }, options, "salt") },
  ];
  const requests = [];
  const fetcher = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    if (requests.length === 1) return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
    return Response.json({ responses: [[{}, 201], [{}, 201]] }, { status: 201 });
  };
  try {
    store.ingest(items);
    await sendBatch(store, "test-key", { now: 1000, fetcher });
    await sendBatch(store, "test-key", { now: 61_000, fetcher });
    expect(requests).toHaveLength(2);
    expect(requests[0][0].user_agent).toStartWith("gpt/5.4-high Magpie/");
    expect(requests[0][1].user_agent).toStartWith("sonnet/4-6-low Magpie/");
    expect(requests[1]).toEqual(requests[0]);
    expect(store.status()).toMatchObject({ sent: 2, pending: 0 });
  } finally { store.close(); }
});

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

test("uses the bound account and resumes after its rejected key is rotated", async () => {
  const directory = tempDirectory(), file = join(directory, "plugin-auth.json");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ rows: [], total: 0, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin, authAccount: "wakatime#new" });
  const accounts = { wakatime: { type: "api", key: "old-key" }, "wakatime#new": { type: "api", key: "expired-key" } };
  const usedKeys = [];
  const worker = new Sync(directory, options, { env: { WAKATIME_HOME: directory }, fetcher: async (_url, init) => {
    const key = Buffer.from(init.headers.Authorization.slice(6), "base64").toString();
    usedKeys.push(key);
    return key === "rotated-key" ? Response.json({ responses: [[{}, 201]] }, { status: 201 }) :
      new Response(null, { status: 401 });
  } });
  try {
    writeFileSync(file, JSON.stringify(accounts));
    enqueue(worker.store, 1);
    const now = Date.now();
    await worker.tick(now);
    expect(worker.store.status()).toMatchObject({ credentials: "invalid-key", pending: 1, sent: 0 });
    await worker.tick(now + 1000);
    expect(usedKeys).toEqual(["expired-key"]);
    accounts["wakatime#new"].key = "rotated-key";
    writeFileSync(file, JSON.stringify(accounts));
    await worker.tick(now + 2000);
    expect(usedKeys).toEqual(["expired-key", "rotated-key"]);
    expect(worker.store.status()).toMatchObject({ credentials: "configured", pending: 0, sent: 1 });
    delete accounts["wakatime#new"];
    writeFileSync(file, JSON.stringify(accounts));
    enqueue(worker.store, 2);
    await worker.tick(now + 4000);
    expect(usedKeys).toHaveLength(2);
    expect(worker.store.status()).toMatchObject({ credentials: "key-account-missing", pending: 1 });
  } finally { await worker.stop(); server.stop(true); rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});

test("does not use an old key when a new login creates another account", async () => {
  const directory = tempDirectory();
  let uploads = 0;
  const worker = new Sync(directory, readOptions(), { env: { WAKATIME_HOME: directory }, fetcher: async () => { uploads++; } });
  try {
    writeFileSync(join(directory, "plugin-auth.json"), JSON.stringify({
      wakatime: { type: "api", key: "old-key" }, "wakatime#new": { type: "api", key: "new-key" },
    }));
    enqueue(worker.store, 1);
    await worker.tick();
    expect(uploads).toBe(0);
    expect(worker.store.status()).toMatchObject({ credentials: "key-account-ambiguous", pending: 1 });
    expect(worker.store.get("enabledAt")).toBeNull();
  } finally { await worker.stop(); rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});
