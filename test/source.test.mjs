import { expect, test } from "bun:test";
import { collectDay } from "../src/source.mjs";
import { Store } from "../src/store.mjs";
import { readOptions } from "../src/config.mjs";

const day = "2026-10-15";
const row = (id) => ({ t: `${day}T10:00:00+08:00`, route_id: id, agent: "codex",
  provider: "mock", model: "mock", in: 10, out: 5, cache_read: 0, cache_write: 0 });

test("resumes paginated scans and rechecks a moving head without duplicating requests", async () => {
  let rows = Array.from({ length: 501 }, (_, i) => row(i));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    expect(url.pathname).toBe("/v1/magpie/usage/requests");
    expect(url.searchParams.get("period")).toBe("2026-10-15..2026-10-15");
    expect(url.searchParams.get("via")).toBe("through");
    expect(url.searchParams.get("computer")).toBe("this");
    const offset = Number(url.searchParams.get("offset"));
    return Response.json({ rows: rows.slice(offset, offset + 500), total: rows.length, offset });
  } });
  const store = new Store(":memory:");
  const options = readOptions({ gatewayUrl: server.url.origin });
  try {
    store.activate(options.gatewayUrl, Date.parse(`${day}T00:00:00+08:00`));
    expect(await collectDay(store, options, day, { budget: 1 })).toBe(false);
    expect(store.status().pending).toBe(500);
    rows.unshift(row(999));
    expect(await collectDay(store, options, day)).toBe(false);
    expect(await collectDay(store, options, day)).toBe(true);
    expect(store.status().pending).toBe(502);
  } finally { store.close(); server.stop(true); }
});

test("never queues pre-activation usage or advances on an incompatible response", async () => {
  let broken = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json(broken ? { data: [] } : { rows: [row(1)], total: 1, offset: 0 });
  } });
  const store = new Store(":memory:");
  const options = readOptions({ gatewayUrl: server.url.origin });
  try {
    store.activate(options.gatewayUrl, Date.parse(`${day}T11:00:00+08:00`));
    expect(await collectDay(store, options, day)).toBe(true);
    expect(store.status().pending).toBe(0);
    broken = true;
    await expect(collectDay(store, options, day)).rejects.toThrow("source-schema");
  } finally { store.close(); server.stop(true); }
});

test("does not follow a source redirect", async () => {
  let targetHits = 0;
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { targetHits++; return Response.json({}); } });
  const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(target.url); } });
  const store = new Store(":memory:");
  try {
    await expect(collectDay(store, readOptions({ gatewayUrl: source.url.origin }), day)).rejects.toThrow("source-http-302");
    expect(targetHits).toBe(0);
  } finally { store.close(); source.stop(true); target.stop(true); }
});
