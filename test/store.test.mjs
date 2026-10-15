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
