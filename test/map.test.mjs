import { expect, test } from "bun:test";
import { mapRow, sourceId } from "../src/map.mjs";

const options = { project: "Magpie", projectByAgent: {}, excludeAgents: [] };
const row = {
  t: "2026-10-15T01:02:03.456+08:00", route_id: 42, agent: "codex",
  provider: "example", model: "test-model", in: 100, out: 30,
  cache_read: 20, cache_write: 10, reasoning: 12, status: 200,
  session: "private-session", providerAccount: "private@example.com",
};

test("maps all input tokens once and preserves the source time", () => {
  const result = mapRow(row, options, "salt");
  expect(result).toMatchObject({
    entity: "magpie", type: "app", category: "ai coding", project: "Magpie",
    time: Date.parse(row.t) / 1000, ai_input_tokens: 130, ai_output_tokens: 30,
    is_write: false,
  });
  expect(result.ai_session).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(Object.keys(result).sort()).toEqual([
    "ai_input_tokens", "ai_output_tokens", "ai_session", "category", "entity",
    "is_write", "project", "time", "type",
  ]);
});

test("filters imported, remote, excluded, rejected and zero-token records", () => {
  for (const extra of [{ source: "log" }, { source: "reported" }, { computer: "remote" },
    { via: "direct" }, { rejected: true }, { in: 0, out: 0, cache_read: 0, cache_write: 0 }]) {
    expect(mapRow({ ...row, ...extra }, options, "salt")).toBeNull();
  }
  expect(mapRow(row, { ...options, excludeAgents: ["codex"] }, "salt")).toBeNull();
  expect(mapRow({ ...row, status: 500 }, options, "salt").ai_output_tokens).toBe(30);
});

test("rejects invalid tokens and timestamps instead of uploading fabricated values", () => {
  for (const extra of [{ in: -1 }, { out: 1.5 }, { in: "100" }, { t: "bad" }, { in: undefined }]) {
    expect(() => mapRow({ ...row, ...extra }, options, "salt")).toThrow("invalid-row");
  }
});

test("uses agent project labels and stable salted session identities", () => {
  const mapped = mapRow(row, { ...options, projectByAgent: { codex: "Work" } }, "salt");
  expect(mapped.project).toBe("Work");
  expect(mapped.ai_session).toBe(mapRow(row, options, "salt").ai_session);
  expect(mapped.ai_session).not.toBe(mapRow(row, options, "other").ai_session);
  expect(mapRow({ ...row, session: undefined }, options, "salt").ai_session).toBeUndefined();
});

test("deduplicates price/token revisions but preserves separate provider attempts", () => {
  const id = sourceId(row, "salt");
  expect(id).toBe(sourceId({ ...row, in: 200, cost: 0.5, agentName: "renamed" }, "salt"));
  expect(id).not.toBe(sourceId({ ...row, provider: "fallback" }, "salt"));
  expect(id).not.toBe(sourceId({ ...row, rid: "second-attempt" }, "salt"));
  expect(id).not.toBe(sourceId(row, "another-install"));
});
