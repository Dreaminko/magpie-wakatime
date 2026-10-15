#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Store } from "./store.mjs";
import { collectDay, localDay } from "./source.mjs";
import { readApiKey, defaultDirectory } from "./config.mjs";
import { defaultUserAgent } from "./user-agent.mjs";

function retryDelay(attempt, header, now) {
  const seconds = header && Number(header);
  const server = header ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now) : 0;
  const backoff = Math.min(300_000, 5000 * 2 ** Math.min(attempt, 6));
  return Math.max(5000, Math.min(300_000, backoff * (0.8 + Math.random() * 0.4)), Number.isFinite(server) ? server : 0);
}

export async function sendBatch(store, key, { now = Date.now(), fetcher = fetch, signal, guard = () => true } = {}) {
  if ((store.get("sendAfter") ?? 0) > now || !guard()) return { sent: 0 };
  const batch = store.pending(now);
  if (!batch.length) return { sent: 0 };
  let response, codes, error = null, retryAfter;
  try {
    response = await fetcher("https://api.wakatime.com/api/v1/users/current/heartbeats.bulk", {
      method: "POST", redirect: "manual",
      headers: {
        "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(key).toString("base64")}`,
        "User-Agent": defaultUserAgent,
      },
      body: `[${batch.map((r) => r.payload).join(",")}]`,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
    retryAfter = response.headers.get("retry-after");
    if ([401, 403].includes(response.status)) {
      store.set("sendError", `wakatime-http-${response.status}`);
      return { sent: 0, auth: true };
    }
    if ([201, 202].includes(response.status)) {
      const body = await response.json();
      if (!Array.isArray(body?.responses) || body.responses.length > batch.length) throw new Error("schema");
      codes = batch.map((_, i) => {
        const entry = body.responses[i];
        return Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[1]) && entry[1] >= 200 && entry[1] <= 599 ? entry[1] : 0;
      });
      if (codes.includes(0)) error = "wakatime-schema";
    } else {
      codes = batch.map(() => response.status);
      error = `wakatime-http-${response.status}`;
      await response.body?.cancel();
    }
  } catch {
    if (signal?.aborted) return { sent: 0 };
    codes = batch.map(() => 0);
    error = response ? "wakatime-schema" : "wakatime-network";
  }
  let sent = 0, auth = false, pause = 1000;
  for (let i = 0; i < batch.length; i++) {
    const code = codes[i];
    if ([401, 403].includes(code)) { auth = true; error = `wakatime-http-${code}`; continue; }
    const success = code >= 200 && code < 300;
    const delay = retryDelay(batch[i].attempts, retryAfter, now);
    store.ack(batch[i].id, code, now, delay);
    if (success) sent++;
    else {
      error ??= code ? `wakatime-http-${code}` : "wakatime-schema";
      if (code === 0 || code === 408 || code === 429 || code >= 500 || code < 400) pause = Math.max(pause, delay);
    }
  }
  store.set("sendAfter", now + pause);
  store.set("sendError", error);
  return { sent, auth };
}

export class Sync {
  constructor(directory, options, { env = process.env, enabled = () => true, fetcher = fetch } = {}) {
    const state = join(directory, "magpie-wakatime");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    this.store = new Store(join(state, "state.sqlite"));
    this.directory = directory;
    this.options = options;
    this.env = env;
    this.enabled = enabled;
    this.fetcher = fetcher;
    this.owner = randomUUID();
    this.abort = new AbortController();
    this.nextScan = 0;
    this.nextReview = 0;
    this.stopped = false;
  }

  async scan(now) {
    const today = localDay(now), first = localDay(this.store.get("enabledAt"));
    let day = this.store.get("backfillDay") ?? first;
    let scannedToday = false;
    for (let n = 0; n < 3 && day <= today; n++) {
      const complete = await collectDay(this.store, this.options, day, { signal: this.abort.signal });
      if (day === today) { scannedToday = true; break; }
      if (!complete) break;
      day = localDay(`${day}T12:00:00`, 1);
      this.store.set("backfillDay", day);
    }
    if (!scannedToday) await collectDay(this.store, this.options, today, { signal: this.abort.signal });
    if (now >= this.nextReview) {
      this.nextReview = now + 600_000;
      for (const offset of [-1, -2]) {
        const previous = localDay(now, offset);
        if (previous >= first) await collectDay(this.store, this.options, previous, { signal: this.abort.signal });
      }
    }
  }

  async tick(now = Date.now()) {
    if (this.stopped) return;
    if (!this.enabled()) { this.store.set("runtime", "disabled"); this.abort.abort(); return; }
    if (!this.store.lease(this.owner, now)) return;
    let key;
    try { key = readApiKey(this.directory, this.options.apiKeyEnv, this.env, this.options.authAccount); }
    catch (error) {
      this.store.set("credentials", ["key-account-missing", "key-account-ambiguous"].includes(error.message) ? error.message : "key-config-unreadable");
      this.store.release(this.owner);
      return;
    }
    if (!key) {
      this.store.set("credentials", "missing-key");
      this.store.release(this.owner);
      return;
    }
    this.store.set("credentials", key === this.blockedKey ? "invalid-key" : "configured");
    this.store.set("runtime", "running");
    try { this.store.activate(this.options.gatewayUrl, now); }
    catch { this.store.set("sourceError", "source-changed"); return; }
    if (now >= this.nextScan) {
      this.nextScan = now + 30_000;
      try { await this.scan(now); this.store.set("sourceError", null); }
      catch (error) {
        this.store.set("sourceError", /^(source-|invalid-row|queue-full)/.test(error.message) ? error.message : "scan-stopped");
      }
    }
    if (key === this.blockedKey) return;
    const result = await sendBatch(this.store, key, {
      now, fetcher: this.fetcher, signal: this.abort.signal,
      guard: () => !this.stopped && this.enabled() && this.store.owns(this.owner, Date.now()),
    });
    if (result.auth) { this.blockedKey = key; this.store.set("credentials", "invalid-key"); }
  }

  start() {
    const poll = () => {
      if (this.working || this.stopped) return;
      this.working = this.tick().catch(() => this.store.set("sourceError", "internal-error")).finally(() => {
        this.working = null;
        if (this.abort.signal.aborted) void this.stop();
      });
    };
    this.timer = setInterval(poll, 1000);
    this.renewal = setInterval(() => {
      try {
        if (!this.enabled() || (this.store.owns(this.owner, Date.now()) && !this.store.lease(this.owner, Date.now()))) void this.stop();
      } catch { void this.stop(); }
    }, 10_000);
    poll();
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.renewal);
    this.abort.abort();
    await this.working;
    this.store.release(this.owner);
    this.store.close();
  }
}

function cli(args) {
  const command = args.shift();
  if (!command || command === "--help") {
    console.log("magpie-wakatime status|preview [--directory <Magpie config directory>] [--limit 5]");
    return;
  }
  let directory = defaultDirectory(), limit = 5;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (flag === "--directory" && value) directory = resolve(value);
    else if (flag === "--limit" && /^[1-9]\d*$/.test(value ?? "") && Number(value) <= 100) limit = Number(value);
    else throw new Error("invalid-arguments");
  }
  if (!["status", "preview"].includes(command)) throw new Error("invalid-arguments");
  const file = join(directory, "magpie-wakatime", "state.sqlite");
  if (!existsSync(file)) { console.log(JSON.stringify(command === "status" ? { runtime: "not-started" } : [], null, 2)); return; }
  const store = new Store(file, { readonly: true });
  try {
    const result = command === "status" ? store.status() : store.pending(Number.MAX_SAFE_INTEGER, limit).map((r) => JSON.parse(r.payload));
    console.log(JSON.stringify(result, null, 2));
  } finally { store.close(); }
}

if (import.meta.main) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message === "invalid-arguments" ? "invalid-arguments" : "state-unreadable"); process.exitCode = 1; }
}
