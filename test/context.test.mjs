import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindWorker, inspectDirectory, onRequest, onResponse } from "../src/context.hooks.mjs";
import { Sync, sendBatch } from "../src/sync.mjs";
import { Store } from "../src/store.mjs";
import { readOptions } from "../src/config.mjs";
import { collectDay, localDay } from "../src/source.mjs";
import { tempDirectory } from "./helpers.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });

test("keeps request-time Git metadata across restart and matches the client response ID", async () => {
  const directory = tempDirectory(), repo = join(directory, "real-repo"), nested = join(repo, "src");
  mkdirSync(nested, { recursive: true });
  git(repo, "init", "-q", "--initial-branch=main");
  for (const file of ["a.ts", "b.ts", "c.js"]) writeFileSync(join(nested, file), "");
  git(repo, "add", "src");
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
    const ctx = { origin: "magpie-key", agent: "codex", cwd: nested, state: {}, signal: new AbortController().signal };
    expect(await onRequest({ messages: ["private-prompt"] }, ctx)).toBeUndefined();
    git(repo, "symbolic-ref", "HEAD", "refs/heads/next");
    await onResponse({ id: "resp-original", choices: ["private-answer"] }, ctx);
    await worker.stop();
    store = new Store(join(directory, "magpie-wakatime", "state.sqlite"));
    await collectDay(store, options, localDay(now));
    const payloads = store.pending(now).map((r) => JSON.parse(r.payload));
    expect(payloads[0]).toMatchObject({ project: "real-repo", branch: "main", language: "TypeScript" });
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
      { origin: "remote" }, { origin: "gateway-key" }, { origin: "unknown" }, { origin: "" }, { agent: "ignored" },
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

test("includes untracked Swift files and refreshes a cached empty result", async () => {
  const directory = tempDirectory(), repo = join(directory, "swift-repo"), empty = join(directory, "empty-repo");
  mkdirSync(repo); mkdirSync(empty);
  try {
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitignore"), "Ignored.swift\n");
    writeFileSync(join(repo, "New.swift"), "");
    writeFileSync(join(repo, "Ignored.swift"), "");
    git(empty, "init", "-q");
    bindWorker(undefined);
    expect(await inspectDirectory(repo, {}, 0)).toMatchObject({ language: "Swift", source: "files", counts: { Swift: 1 } });
    expect(await inspectDirectory(empty, {}, 0)).toMatchObject({ language: null, reason: "none" });
    writeFileSync(join(empty, "App.swift"), "");
    expect(await inspectDirectory(empty, {}, 9_000)).toMatchObject({ language: null, reason: "none" });
    expect(await inspectDirectory(empty, {}, 10_001)).toMatchObject({ language: "Swift", source: "files" });
  } finally {
    bindWorker(undefined);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("applies the longest directory language override without scanning", async () => {
  const directory = tempDirectory(), app = join(directory, "app"), app2 = join(directory, "app2");
  mkdirSync(app); mkdirSync(app2);
  git(app2, "init", "-q");
  const options = readOptions({ languageByDirectory: { [app]: "swift" } });
  try {
    bindWorker(undefined);
    expect(await inspectDirectory(app, options, 0)).toMatchObject({ language: "Swift", source: "override" });
    writeFileSync(join(app2, "main.ts"), "");
    expect(await inspectDirectory(app2, options, 0)).toMatchObject({ language: "TypeScript", source: "files" });
  } finally {
    bindWorker(undefined);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("records untracked Swift from a request without counting dependency sources", async () => {
  const directory = tempDirectory(), repo = join(directory, "swift-app"), app = join(repo, "App"), pods = join(app, "Pods");
  mkdirSync(pods, { recursive: true });
  git(repo, "init", "-q", "--initial-branch=main");
  writeFileSync(join(app, "App.swift"), "");
  writeFileSync(join(pods, "Legacy.m"), "");
  git(repo, "add", "App/Pods");
  const now = Date.now();
  const rows = [{ t: new Date(now).toISOString(), agent: "codex", in: 10, out: 2, response_id: "swift-response" }];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ rows, total: rows.length, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin }), worker = new Sync(directory, options);
  let store;
  try {
    worker.store.activate(options.gatewayUrl, now - 1);
    bindWorker(worker);
    const ctx = { origin: "local", agent: "codex", cwd: app, state: {} };
    await onRequest({}, ctx);
    await onResponse({ id: "swift-response" }, ctx);
    expect(worker.store.db.query("SELECT value FROM meta WHERE key LIKE 'context:%'").all()
      .map((r) => JSON.parse(r.value))).toEqual([{ project: "swift-app", branch: "main", language: "Swift" }]);
    await worker.stop();
    store = new Store(join(directory, "magpie-wakatime", "state.sqlite"));
    await collectDay(store, options, localDay(now));
    expect(store.pending(now).map((r) => JSON.parse(r.payload)))
      .toMatchObject([{ project: "swift-app", branch: "main", language: "Swift" }]);
  } finally {
    store?.close(); await worker.stop(); server.stop(true);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
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

test("snapshots session directories in request order and isolates other agents and sessions", async () => {
  const directory = tempDirectory(), first = join(directory, "first"), second = join(directory, "second");
  mkdirSync(first); mkdirSync(second);
  for (const cwd of [first, second]) git(cwd, "init", "-q", "--initial-branch=main");
  const now = Date.now();
  const rows = ["first", "inherited", "second", "other-agent", "other-session", "invalid", "remote"].map((id, i) => ({
    t: new Date(now + i).toISOString(), agent: id === "other-agent" ? "claude" : "codex",
    in: 10, out: 2, response_id: id, session: "private-session",
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ rows, total: rows.length, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin, languageByDirectory: { [first]: "TypeScript", [second]: "Swift" } });
  const worker = new Sync(directory, options, { env: { HOME: directory } });
  let store;
  try {
    worker.store.activate(options.gatewayUrl, now - 1);
    bindWorker(worker);
    const ctx = (extra = {}) => ({ origin: "local", agent: "codex", session: "private-session", state: {}, ...extra });
    const requests = [ctx({ cwd: first }), ctx(), ctx({ cwd: second }), ctx({ agent: "claude" }),
      ctx({ session: "different-session" }), ctx({ cwd: "relative" }), ctx({ origin: "remote" })];
    await Promise.all(requests.map((request) => onRequest({}, request)));
    for (let i = requests.length - 1; i >= 0; i--) await onResponse({ id: rows[i].response_id }, requests[i]);
    const latest = ctx();
    await onRequest({}, latest);
    expect(latest.state.wakatime).toEqual({ project: "second", branch: "main", language: "Swift" });
    await worker.stop();
    store = new Store(join(directory, "magpie-wakatime", "state.sqlite"));
    await collectDay(store, options, localDay(now));
    const payloads = store.pending(now + 10).map((r) => JSON.parse(r.payload));
    expect(payloads.slice(0, 3).map(({ project, language }) => ({ project, language }))).toEqual([
      { project: "first", language: "TypeScript" }, { project: "first", language: "TypeScript" },
      { project: "second", language: "Swift" },
    ]);
    for (const payload of payloads.slice(3)) expect(payload).toMatchObject({ project: "Magpie" });
    for (const payload of payloads.slice(3)) expect(payload.language).toBeUndefined();
    const metadata = JSON.stringify(store.db.query("SELECT * FROM meta").all());
    expect(metadata).not.toContain(directory);
    expect(metadata).not.toContain("private-session");
  } finally {
    bindWorker(undefined); store?.close(); await worker.stop(); server.stop(true);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("recovers Omp projects from session headers after restart and sends their languages", async () => {
  const directory = tempDirectory(), first = join(directory, "swift-app"), second = join(directory, "ts-app");
  mkdirSync(first); mkdirSync(second);
  for (const [repo, file] of [[first, "App.swift"], [second, "app.ts"]]) {
    git(repo, "init", "-q", "--initial-branch=main");
    writeFileSync(join(repo, file), "");
  }
  const session = "00000000-0000-4000-8000-000000000001";
  const bucket = join(directory, ".omp", "agent", "sessions", "project");
  mkdirSync(bucket, { recursive: true });
  const file = join(bucket, `2026-11-18T00-00-00-000Z_${session}.jsonl`);
  const header = (cwd) => [JSON.stringify({ type: "title", title: "private title" }),
    JSON.stringify({ type: "session", id: session, cwd }),
    JSON.stringify({ type: "message", cwd: directory, content: "private conversation" }), ""].join("\n");
  writeFileSync(file, header(first));
  const now = Date.now();
  const rows = ["before-restart", "after-restart"].map((response_id, i) => ({
    t: new Date(now + i).toISOString(), agent: "omp", in: 10, out: 2, response_id, session,
  }));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ rows, total: rows.length, offset: 0 });
  } });
  const options = readOptions({ gatewayUrl: server.url.origin }), env = { HOME: directory };
  let worker = new Sync(directory, options, { env });
  try {
    worker.store.activate(options.gatewayUrl, now - 1);
    bindWorker(worker);
    const request = async (id) => {
      const ctx = { origin: "magpie-key", agent: "omp", session, state: {} };
      await onRequest({}, ctx);
      await onResponse({ id }, ctx);
    };
    await request("before-restart");
    await worker.stop();
    writeFileSync(file, header(second));
    worker = new Sync(directory, options, { env });
    bindWorker(worker);
    await request("after-restart");
    await collectDay(worker.store, options, localDay(now));
    let sent;
    await sendBatch(worker.store, "test-key", { now: now + 10, fetcher: async (_url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ responses: sent.map(() => [{}, 201]) }, { status: 201 });
    } });
    expect(sent.map(({ project, branch, language }) => ({ project, branch, language }))).toEqual([
      { project: "swift-app", branch: "main", language: "Swift" },
      { project: "ts-app", branch: "main", language: "TypeScript" },
    ]);
    const metadata = JSON.stringify(worker.store.db.query("SELECT * FROM meta").all());
    for (const secret of [directory, session, "private title", "private conversation"]) expect(metadata).not.toContain(secret);
  } finally {
    bindWorker(undefined); await worker.stop(); server.stop(true);
    rmSync(directory, { recursive: true, maxRetries: 5, retryDelay: 50 });
  }
});
