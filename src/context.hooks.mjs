import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { contextKey } from "./map.mjs";
import { analyzeLanguage } from "./language.mjs";
import { sessionDirectory } from "./session.mjs";

const exec = promisify(execFile);
let worker;
const languages = new Map();
const sessions = new Map();
const SESSION_CACHE_LIMIT = 100;
const LANGUAGE_CACHE_LIMIT = 100;
const LANGUAGE_TTL = 60_000;
const EMPTY_TTL = 10_000;
const FAILED_TTL = 5_000;

async function trackedFiles(cwd) {
  try {
    const { stdout } = await exec("git", ["-C", cwd, "ls-files", "--cached", "--others",
      "--exclude-standard", "--full-name", "-z", "--", "."], {
      encoding: "utf8", timeout: 600, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return { files: stdout, reason: null };
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    return { files: "", reason: /not a git repository|not a working tree/i.test(stderr) ? "not-git" : "failed" };
  }
}

function ttl(reason, language) {
  if (reason === "failed") return FAILED_TTL;
  if (reason === "not-git" || language) return LANGUAGE_TTL;
  return EMPTY_TTL;
}

function overrideLanguage(cwd, options) {
  let match = null;
  for (const [directory, language] of Object.entries(options?.languageByDirectory ?? {})) {
    if ((cwd === directory || cwd.startsWith(directory + sep)) &&
        (!match || directory.length > match.directory.length)) match = { directory, language };
  }
  return match?.language ?? null;
}

// Expired entries refresh on use. Scans are shared while in flight so a burst of
// requests cannot start the same Git listing several times.
export async function inspectDirectory(cwd, options, now = Date.now()) {
  const path = resolve(cwd);
  const override = overrideLanguage(path, options);
  if (override) return { language: override, source: "override", reason: null, counts: {} };
  const cached = languages.get(path);
  if (cached && (cached.promise || cached.expires > now)) return cached.promise ?? cached.result;
  const entry = { expires: Infinity, promise: null, result: null };
  languages.set(path, entry);
  if (languages.size > LANGUAGE_CACHE_LIMIT) languages.delete(languages.keys().next().value);
  entry.promise = trackedFiles(path).then(({ files, reason }) => {
    const analysis = reason ? { language: null, reason, counts: {} } : analyzeLanguage(files);
    entry.result = { ...analysis, source: "files" };
    entry.expires = now + ttl(analysis.reason, analysis.language);
    entry.promise = null;
    return entry.result;
  });
  return entry.promise;
}

export function bindWorker(value) {
  worker = value;
  languages.clear();
  sessions.clear();
}

function label(value) {
  return typeof value === "string" && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : "";
}

function requestDirectory(ctx, current) {
  const key = contextKey(ctx.agent, ctx.session, current.store.get("salt"));
  const explicit = ctx.cwd !== undefined && ctx.cwd !== null && ctx.cwd !== "";
  if (explicit && (typeof ctx.cwd !== "string" || !isAbsolute(ctx.cwd))) return null;
  if (!key) return explicit ? ctx.cwd : null;
  const cached = sessions.get(key);
  if (!explicit && cached && cached.expires > Date.now()) return cached.promise;
  const entry = { expires: explicit && ctx.agent !== "omp" ? Infinity : Date.now() + LANGUAGE_TTL, promise: null };
  entry.promise = explicit ? Promise.resolve(ctx.cwd) : sessionDirectory(ctx.agent, ctx.session, current.env).then((cwd) => {
    if (!cwd) entry.expires = Date.now() + FAILED_TTL;
    return cwd;
  });
  // Reserve before awaiting I/O: later requests see directory changes in arrival order.
  sessions.delete(key);
  sessions.set(key, entry);
  if (sessions.size > SESSION_CACHE_LIMIT) sessions.delete(sessions.keys().next().value);
  return entry.promise;
}

// Snapshot before routing; delayed usage scans must not read a newer HEAD.
export async function onRequest(_body, ctx) {
  const current = worker;
  if (!current || current.stopped || !current.enabled() || current.store.get("enabledAt") === null ||
      (ctx.origin !== "local" && ctx.origin !== "magpie-key") || current.options.excludeAgents.includes(ctx.agent) ||
      ctx.signal?.aborted) return;
  try {
    const cwd = await requestDirectory(ctx, current);
    if (!cwd || ctx.signal?.aborted || current !== worker || !(await stat(cwd)).isDirectory()) return;
    const git = async (...args) => {
      try {
        const { stdout } = await exec("git", ["-C", cwd, ...args], {
          encoding: "utf8", timeout: 400, maxBuffer: 4096, windowsHide: true, signal: ctx.signal,
        });
        return stdout.trim();
      } catch { return ""; }
    };
    const [location, branch, language] = await Promise.all([
      git("rev-parse", "--show-toplevel", "--git-common-dir"), git("symbolic-ref", "--quiet", "--short", "HEAD"),
      inspectDirectory(cwd, current.options),
    ]);
    const [root, common] = location.split(/\r?\n/);
    const projectRoot = common && basename(common) === ".git" ? dirname(resolve(cwd, common)) : root;
    const project = label(basename(projectRoot || cwd));
    if (!project || ctx.signal?.aborted || current !== worker || current.stopped) return;
    ctx.state.wakatime = { project };
    if (root && label(branch)) ctx.state.wakatime.branch = label(branch);
    if (language.language) ctx.state.wakatime.language = language.language;
  } catch { /* Context is optional; leave the agent request unchanged. */ }
}

export async function onResponse(reply, ctx) {
  if (!worker || worker.stopped || !worker.enabled() || ctx.signal?.aborted || !ctx.state.wakatime) return;
  const key = contextKey(ctx.agent, reply?.id || reply?.responseId, worker.store.get("salt"));
  if (!key) return;
  try { worker.store.set(key, ctx.state.wakatime); }
  catch { /* Usage polling continues when a best-effort notification is lost. */ }
}