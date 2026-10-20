import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { tempDirectory } from "./helpers.mjs";

const item = (id, tokens = 10) => ({ id, payload: { time: 123, ai_input_tokens: tokens, ai_output_tokens: 2 } });

test("persists the queue, activation boundary and dedup across restarts", () => {
  const directory = tempDirectory(), file = join(directory, "state.sqlite");
  let store;
  try {
    store = new Store(file);
    store.activate("http://127.0.0.1:3425", 1000);
    const salt = store.get("salt");
    store.ingest([item("a"), item("b")], "scan:test", { offset: 2 });
    store.close();
    store = new Store(file);
    store.activate("http://127.0.0.1:3425", 2000);
    store.ingest([item("a")]);
    expect(store.get("enabledAt")).toBe(1000);
    expect(store.get("salt")).toBe(salt);
    expect(store.get("scan:test")).toEqual({ offset: 2 });
    expect(store.pending(0)).toHaveLength(2);
    store.ack("a", 201, 0);
    store.ingest([item("a", 20), item("b", 20)]);
    expect(store.status()).toMatchObject({ pending: 1, sent: 1, changed: 1 });
    expect(JSON.parse(store.pending(0)[0].payload).ai_input_tokens).toBe(20);
    expect(() => store.activate("http://127.0.0.1:9999", 2000)).toThrow("source-changed");
  } finally { store?.close(); rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 }); }
});

test("rolls back a full page and scan progress when the queue is full", () => {
  const store = new Store(":memory:", { capacity: 2 });
  try {
    store.ingest([item("a")], "cursor", 1);
    expect(() => store.ingest([item("b"), item("c")], "cursor", 3)).toThrow("queue-full");
    expect(store.status().pending).toBe(1);
    expect(store.get("cursor")).toBe(1);
  } finally { store.close(); }
});

test("rejected rows retain deduplication without consuming pending capacity", () => {
  const store = new Store(":memory:", { capacity: 2 });
  try {
    store.ingest([item("a"), item("b")], "cursor", 2);
    store.ack("a", 400, 0);
    store.ingest([item("a"), item("c")], "cursor", 3);
    expect(store.status()).toMatchObject({ pending: 2, rejected: 1 });
    expect(store.pending(0).map((row) => row.id)).toEqual(["b", "c"]);
    expect(() => store.ingest([item("d")], "cursor", 4)).toThrow("queue-full");
    expect(store.get("cursor")).toBe(3);
    expect(store.status()).toMatchObject({ pending: 2, rejected: 1 });
  } finally { store.close(); }
});

test("flags a revision that only moves cached input tokens", () => {
  const store = new Store(":memory:");
  const version = (cacheRead) => ({ id: "a", payload: {
    time: 123, ai_input_tokens: 100, ai_output_tokens: 2, ai_cached_input_tokens: cacheRead } });
  try {
    store.ingest([version(10)]);
    store.ingest([version(25)]);
    expect(JSON.parse(store.pending(0)[0].payload).ai_cached_input_tokens).toBe(25);
    store.ack("a", 201, 0);
    store.ingest([version(40)]);
    expect(store.status()).toMatchObject({ sent: 1, changed: 1 });
  } finally { store.close(); }
});

test("refreshes pending model metadata without resending confirmed usage", () => {
  const store = new Store(":memory:");
  const original = item("a");
  const updated = { ...original, payload: { ...original.payload, user_agent: "gpt/5.4-high Magpie/unknown" } };
  try {
    store.ingest([original]);
    store.ingest([updated]);
    expect(JSON.parse(store.pending(0)[0].payload).user_agent).toBe("gpt/5.4-high Magpie/unknown");
    store.ack("a", 201, 0);
    store.ingest([{ ...updated, payload: { ...updated.payload, user_agent: "gpt/5.4-xhigh Magpie/unknown" } }]);
    expect(store.pending(0)).toHaveLength(0);
    expect(store.status()).toMatchObject({ sent: 1, changed: 1 });
  } finally { store.close(); }
});

test("coordinates independent SQLite connections and expires abandoned leases", () => {
  const directory = tempDirectory(), file = join(directory, "state.sqlite");
  const a = new Store(file), b = new Store(file);
  try {
    expect(a.lease("a", 1000)).toBe(true);
    expect(b.lease("b", 1001)).toBe(false);
    expect(a.lease("a", 2000)).toBe(true);
    expect(b.lease("b", 62001)).toBe(true);
    expect(a.owns("a", 62002)).toBe(false);
    a.release("a");
    expect(b.owns("b", 62003)).toBe(true);
    b.release("b");
    expect(a.lease("a", 62004)).toBe(true);
  } finally { a.close(); b.close(); rmSync(directory, { recursive: true }); }
});

test("refreshes pending project, branch and language metadata without resending confirmed usage", () => {
  const store = new Store(":memory:");
  try {
    store.ingest([item("a")]);
    const updated = { ...item("a"), payload: { ...item("a").payload, project: "repo", branch: "main", language: "TypeScript" } };
    store.ingest([updated]);
    expect(JSON.parse(store.pending(0)[0].payload)).toMatchObject({ project: "repo", branch: "main", language: "TypeScript" });
    store.ack("a", 201, 0);
    store.ingest([{ ...updated, payload: { ...updated.payload, branch: "next", language: "JavaScript" } }]);
    expect(store.status()).toMatchObject({ sent: 1, pending: 0, changed: 1 });
  } finally { store.close(); }
});

test("keeps failed rows until due and quarantines permanent item failures", () => {
  const store = new Store(":memory:");
  try {
    store.ingest([item("a"), item("b")]);
    store.ack("a", 500, 100, 5000);
    store.ack("b", 400, 100);
    expect(store.pending(5099)).toHaveLength(0);
    expect(store.pending(5100).map((r) => r.id)).toEqual(["a"]);
    expect(store.status()).toMatchObject({ pending: 1, rejected: 1, sent: 0 });
  } finally { store.close(); }
});
