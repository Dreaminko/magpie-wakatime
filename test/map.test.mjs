import { expect, test } from "bun:test";
import { mapRow, sourceId } from "../src/map.mjs";

const options = { project: "Magpie", projectByAgent: {}, excludeAgents: [] };
const row = {
  t: "2026-10-15T01:02:03.456+08:00", route_id: 42, agent: "codex",
  provider: "example", model: "test-model", in: 100, out: 30,
  cache_read: 20, cache_write: 10, reasoning: 12, status: 200,
  session: "private-session", providerAccount: "private@example.com",
};

test("splits cached input from uncached input and preserves the source time", () => {
  const result = mapRow(row, options, "salt");
  expect(result).toMatchObject({
    entity: "codex", type: "app", category: "ai coding", project: "Magpie",
    time: Date.parse(row.t) / 1000, ai_input_tokens: 110, ai_cached_input_tokens: 20,
    ai_output_tokens: 30, is_write: false,
  });
  // The three WakaTime components stay additive: 110 + 20 + 30 equals the row total.
  expect(result.ai_session).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("private");
  expect(Object.keys(result).sort()).toEqual([
    "ai_cached_input_tokens", "ai_input_tokens", "ai_output_tokens", "ai_session",
    "category", "entity", "is_write", "project", "time", "type", "user_agent",
  ]);
});

test("encodes the served model and effort using WakaTime CLI user-agent tokens", () => {
  const result = mapRow({ ...row, model: "gateway-alias", served: "openai/gpt-5.4", effort: "high" }, options, "salt");
  expect(result.user_agent).toMatch(/^gpt\/5\.4-high Magpie\/unknown \(.+\) magpie-wakatime\/\S+$/);
  expect(result.user_agent).not.toContain("gateway-alias");
  expect(result.user_agent).not.toContain("openai/");
});

test("falls back to the recorded model and supports model naming conventions", () => {
  for (const [model, effort, token] of [
    ["gpt-5.4", "high", "gpt/5.4-high"],
    ["gpt-5.4-high", "HIGH", "gpt/5.4-high"],
    ["claude-sonnet-4-6", "", "sonnet/4-6"],
    ["claude-3-7-sonnet", undefined, "claude/3-7-sonnet"],
    ["gemini-2.5-pro", "low", "gemini/2.5-pro-low"],
    ["DeepSeek-V4.1-Flash", undefined, "DeepSeek/4.1-Flash"],
    ["qwen3.5-397b", undefined, "qwen/3.5-397b"],
    ["gpt/5.4", "xhigh", "gpt/5.4-xhigh"],
  ]) {
    expect(mapRow({ ...row, model, effort }, options, "salt").user_agent).toStartWith(`${token} Magpie/`);
  }
});

test("does not invent a model version from missing or unversioned names", () => {
  for (const model of [undefined, null, 7, "", "gateway-alias"]) {
    expect(mapRow({ ...row, model, effort: "high" }, options, "salt").user_agent).toStartWith("Magpie/unknown ");
  }
});

test("omits cached input tokens when the row read none", () => {
  const plain = mapRow({ ...row, cache_read: 0, cache_write: 0 }, options, "salt");
  expect(plain.ai_input_tokens).toBe(100);
  expect("ai_cached_input_tokens" in plain).toBe(false);
  expect(mapRow(row, options, "salt").ai_input_tokens).toBe(110);
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

test("names the entity after the agent and falls back when it is unusable", () => {
  expect(mapRow({ ...row, agent: " claude " }, options, "salt").entity).toBe("claude");
  for (const agent of [undefined, "", "   ", 7, "x".repeat(256)]) {
    expect(mapRow({ ...row, agent }, options, "salt").entity).toBe("magpie");
  }
});

test("uses request project metadata while keeping explicit agent overrides", () => {
  const context = { project: "real-repo", branch: "feature/context", language: "TypeScript" };
  expect(mapRow(row, options, "salt", context)).toMatchObject(context);
  expect(mapRow(row, { ...options, projectByAgent: { codex: "Work" } }, "salt", context))
    .toMatchObject({ project: "Work", branch: "feature/context", language: "TypeScript" });
  expect(mapRow(row, options, "salt").branch).toBeUndefined();
  expect(mapRow(row, options, "salt").language).toBeUndefined();
});

test("deduplicates price/token revisions but preserves separate provider attempts", () => {
  const id = sourceId(row, "salt");
  expect(id).toBe(sourceId({ ...row, in: 200, cost: 0.5, agentName: "renamed" }, "salt"));
  expect(id).not.toBe(sourceId({ ...row, provider: "fallback" }, "salt"));
  expect(id).not.toBe(sourceId({ ...row, rid: "second-attempt" }, "salt"));
  expect(id).not.toBe(sourceId(row, "another-install"));
});
