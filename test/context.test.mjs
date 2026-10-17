import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { bindWorker, onRequest, onResponse } from "../src/context.hooks.mjs";
import { Sync } from "../src/sync.mjs";
import { Store } from "../src/store.mjs";
import { readOptions } from "../src/config.mjs";
import { collectDay, localDay } from "../src/source.mjs";
import { tempDirectory } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });

test("keeps request-time Git metadata across restart and matches the client response ID", async () => {
  const directory = tempDirectory(), repo = join(directory, "real-repo"), nested = join(repo, "src");
  mkdirSync(nested, { recursive: true });
  git(repo, "init", "-q", "--initial-branch=main");
  const now = Date.now();
  const rows = [
    { t: new Date(now).toISOString(), agent: "codex", model: "gpt-5.4", in: 10, out: 2,
      rid: "transport-request", response_id: "resp-original", session: "private-session" },
    { t: new Date(now).toISOString(), agent: "claude", in: 10, out: 2, response_id: "resp-original" },
    { t: new Date(now).toISOString(), agent: "codex", in: 10, out: 2, response_id: "unmatched" },
  ];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ rows, total: rows.length, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin });
  const worker = new Sync(directory, options);
  let store;
  try {
    worker.store.activate(options.gatewayUrl, now - 1);
    bindWorker(worker);
    const ctx = { origin: "local", agent: "codex", cwd: nested, state: {}, signal: new AbortController().signal };
    expect(await onRequest({ messages: ["private-prompt"] }, ctx)).toBeUndefined();
    git(repo, "symbolic-ref", "HEAD", "refs/heads/next");
    await onResponse({ id: "resp-original", choices: ["private-answer"] }, ctx);
    await worker.stop();
    store = new Store(join(directory, "magpie-wakatime", "state.sqlite"));
    await collectDay(store, options, localDay(now));
    const payloads = store.pending(now).map((r) => JSON.parse(r.payload));
    expect(payloads[0]).toMatchObject({ project: "real-repo", branch: "main" });
    expect(payloads.slice(1).map((p) => p.project)).toEqual(["Magpie", "Magpie"]);
    expect(payloads[1].branch).toBeUndefined();
    const metadata = JSON.stringify(store.db.query("SELECT * FROM meta").all());
    for (const secret of [directory, "private-prompt", "private-answer", "resp-original", "private-session"]) {
      expect(metadata).not.toContain(secret);
    }
  } finally {
    store?.close(); await worker.stop(); server.stop(true);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("uses a non-Git directory name and skips missing, remote, excluded or disabled context", async () => {
  const directory = tempDirectory(), cwd = join(directory, "plain-project");
  mkdirSync(cwd);
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = directory;
  let enabled = true;
  const options = readOptions({ excludeAgents: ["ignored"] });
  const worker = new Sync(directory, options, { enabled: () => enabled });
  try {
    worker.store.activate(options.gatewayUrl, Date.now());
    bindWorker(worker);
    const context = (extra = {}) => ({ origin: "local", agent: "codex", cwd, state: {}, ...extra });
    const ctx = context();
    await onRequest({}, ctx);
    await onResponse({ responseId: "gemini-response" }, ctx);
    expect(worker.store.db.query("SELECT value FROM meta WHERE key LIKE 'context:%'").all().map((r) => JSON.parse(r.value)))
      .toEqual([{ project: "plain-project" }]);
    for (const extra of [{ cwd: "" }, { cwd: "relative" }, { cwd: join(directory, "missing") },
      { origin: "remote" }, { origin: "gateway-key" }, { agent: "ignored" },
      { signal: AbortSignal.abort() }]) {
      const skipped = context(extra);
      await onRequest({}, skipped);
      await onResponse({ id: "should-not-save" }, skipped);
    }
    enabled = false;
    const skipped = context();
    await onRequest({}, skipped);
    await onResponse({ id: "disabled" }, skipped);
    expect(worker.store.db.query("SELECT count(*) AS n FROM meta WHERE key LIKE 'context:%'").get().n).toBe(1);
  } finally {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
    await worker.stop(); rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("keeps the repository project name in linked worktrees and omits detached branches", async () => {
  const directory = tempDirectory(), repo = join(directory, "real-repo"), worktree = join(directory, "checkout");
  mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=main");
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false",
    "commit", "-q", "--allow-empty", "-m", "Initial");
  git(repo, "worktree", "add", "-q", "-b", "feature/worktree", worktree);
  const options = readOptions(), worker = new Sync(directory, options);
  try {
    worker.store.activate(options.gatewayUrl, Date.now());
    bindWorker(worker);
    const ctx = { origin: "local", agent: "codex", cwd: worktree, state: {} };
    await onRequest({}, ctx);
    await onResponse({ id: "worktree-response" }, ctx);
    git(worktree, "checkout", "-q", "--detach");
    const detached = { ...ctx, state: {} };
    await onRequest({}, detached);
    await onResponse({ id: "detached-response" }, detached);
    expect(worker.store.db.query("SELECT value FROM meta WHERE key LIKE 'context:%' ORDER BY rowid").all()
      .map((r) => JSON.parse(r.value))).toEqual([
        { project: "real-repo", branch: "feature/worktree" }, { project: "real-repo" },
      ]);
  } finally {
    await worker.stop();
    const objects = join(repo, ".git", "objects");
    for (const file of readdirSync(objects, { recursive: true })) {
      const path = join(objects, file);
      if (statSync(path).isFile()) chmodSync(path, 0o600);
    }
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});
