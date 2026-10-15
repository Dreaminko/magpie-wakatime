import { mapRow, sourceId } from "./map.mjs";

export function localDay(value = Date.now(), offset = 0) {
  const date = new Date(value);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function page(options, day, offset, signal) {
  const url = new URL("/v1/magpie/usage/requests", options.gatewayUrl);
  url.search = new URLSearchParams({ period: `${day}..${day}`, via: "through", computer: "this", offset, limit: 500 });
  let response;
  try {
    response = await fetch(url, { redirect: "manual", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  } catch { throw new Error(signal?.aborted ? "stopped" : "source-network"); }
  if (!response.ok) throw new Error(`source-http-${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error("source-schema"); }
  if (!Array.isArray(body?.rows) || body.rows.length > 500 || !Number.isSafeInteger(body.total) ||
      body.total < body.rows.length || body.offset !== Math.min(offset, body.total) ||
      body.rows.some((r) => !r || typeof r !== "object")) throw new Error("source-schema");
  if (body.rows.length === 0 && offset < body.total) throw new Error("source-schema");
  return body;
}

export async function collectDay(store, options, day, { budget = 20, signal } = {}) {
  const key = `scan:${day}`, salt = store.get("salt");
  let cursor = store.get(key) ?? { offset: 0 };
  for (let n = 0; n < budget; n++) {
    signal?.throwIfAborted();
    const body = await page(options, day, cursor.offset, signal);
    const head = body.rows.length ? sourceId(body.rows[0], salt) : null;
    if (cursor.offset === 0) cursor = { offset: 0, head, total: body.total };
    const items = [];
    for (const row of body.rows) {
      const payload = mapRow(row, options, salt);
      if (payload && payload.time * 1000 >= store.get("enabledAt")) items.push({ id: sourceId(row, salt), payload });
    }
    cursor = { ...cursor, offset: cursor.offset + body.rows.length };
    store.ingest(items, key, cursor);
    if (cursor.offset >= body.total) {
      const check = await page(options, day, 0, signal);
      const stable = check.total === cursor.total && (check.rows.length ? sourceId(check.rows[0], salt) : null) === cursor.head;
      store.set(key, null);
      if (stable && day >= (store.get("lastCompleteDay") ?? "")) store.set("lastCompleteDay", day);
      return stable;
    }
  }
  return false;
}
