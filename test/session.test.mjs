import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirectory } from "../src/session.mjs";
import { tempDirectory } from "./helpers.mjs";

const session = "00000000-0000-4000-8000-000000000001";

function writeSession(root, bucket, header) {
  const directory = join(root, bucket);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `2026-11-18_${session}.jsonl`), typeof header === "string" ? header : `${JSON.stringify(header)}\n`);
}

test("ignores mismatched, malformed and ambiguous Omp session metadata", async () => {
  const directory = tempDirectory(), root = join(directory, ".omp", "agent", "sessions"), env = { HOME: directory };
  try {
    writeSession(root, "project", { type: "session", id: "another-session", cwd: directory });
    expect(await sessionDirectory("omp", session, env)).toBeNull();
    writeSession(root, "project", "{incomplete");
    expect(await sessionDirectory("omp", session, env)).toBeNull();
    writeSession(root, "project", { type: "message", id: session, cwd: directory });
    expect(await sessionDirectory("omp", session, env)).toBeNull();
    writeSession(root, "project", { type: "session", id: session, cwd: "relative" });
    expect(await sessionDirectory("omp", session, env)).toBeNull();
    writeSession(root, "project", { type: "session", id: session, cwd: directory });
    writeSession(root, "duplicate", { type: "session", id: session, cwd: join(directory, "other") });
    expect(await sessionDirectory("omp", session, env)).toBeNull();
    for (const id of [undefined, "", "../escape", `${session}/../../escape`]) {
      expect(await sessionDirectory("omp", id, env)).toBeNull();
    }
    expect(await sessionDirectory("codex", session, env)).toBeNull();
  } finally { rmSync(directory, { recursive: true }); }
});

test("bounds metadata reads and never searches messages for a working directory", async () => {
  const directory = tempDirectory(), root = join(directory, ".omp", "agent", "sessions"), env = { HOME: directory };
  const header = JSON.stringify({ type: "session", id: session, cwd: directory });
  try {
    writeSession(root, "project", `${JSON.stringify({ type: "title", title: "x".repeat(16 * 1024) })}\n${header}\n`);
    expect(await sessionDirectory("omp", session, env)).toBeNull();
    writeSession(root, "project", `${JSON.stringify({ type: "message", content: "private conversation" })}\n${header}\n`);
    expect(await sessionDirectory("omp", session, env)).toBeNull();
  } finally { rmSync(directory, { recursive: true }); }
});

test("resolves Omp agent directory overrides and named profiles", async () => {
  const directory = tempDirectory(), custom = join(directory, "custom-agent"), cwd = join(directory, "app");
  const header = { type: "session", id: session, cwd };
  try {
    writeSession(join(custom, "sessions"), "project", header);
    expect(await sessionDirectory("omp", session, { HOME: directory, PI_CODING_AGENT_DIR: custom })).toBe(cwd);
    writeSession(join(directory, ".custom", "profiles", "work", "agent", "sessions"), "project", header);
    expect(await sessionDirectory("omp", session, { HOME: directory, PI_CONFIG_DIR: ".custom", OMP_PROFILE: "work" })).toBe(cwd);
    expect(await sessionDirectory("omp", session, { HOME: directory, OMP_PROFILE: "../work" })).toBeNull();
    if (process.platform !== "win32") {
      const data = join(directory, "data");
      writeSession(join(data, "omp", "sessions"), "project", header);
      expect(await sessionDirectory("omp", session, { HOME: directory, XDG_DATA_HOME: data })).toBe(cwd);
    }
  } finally { rmSync(directory, { recursive: true }); }
});
