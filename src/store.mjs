import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

// Explicit SQL: the bun transaction() wrapper keeps the WAL files locked after close().
function transaction(db, work) {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.run("COMMIT");
    return result;
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* keep the original error */ }
    throw error;
  }
}

export class Store {
  constructor(file, { capacity = 100_000, readonly = false } = {}) {
    this.capacity = capacity;
    this.db = new Database(file, { create: !readonly, readonly, strict: true });
    if (readonly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        due INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT, changed INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS queue_due ON queue(state, due);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires INTEGER);
    `);
    this.db.query("INSERT OR IGNORE INTO meta VALUES ('salt', ?)").run(JSON.stringify(randomBytes(32).toString("hex")));
  }

  get(key) {
    const row = this.db.query("SELECT value FROM meta WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : null;
  }

  set(key, value) {
    this.db.query("INSERT OR REPLACE INTO meta VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  activate(gateway, now) {
    transaction(this.db, () => {
      if (this.get("gateway") && this.get("gateway") !== gateway) throw new Error("source-changed");
      if (this.get("enabledAt") === null) {
        this.set("gateway", gateway);
        this.set("enabledAt", now);
      }
    });
  }

  ingest(items, progressKey, progress) {
    transaction(this.db, () => {
      let count = this.db.query("SELECT count(*) AS n FROM queue WHERE state != 'sent'").get().n;
      const find = this.db.query("SELECT payload, state FROM queue WHERE id=?");
      const insert = this.db.query("INSERT INTO queue(id, payload) VALUES (?, ?)");
      for (const { id, payload } of items) {
        const old = find.get(id);
        if (!old) {
          if (count >= this.capacity) throw new Error("queue-full");
          insert.run(id, JSON.stringify(payload));
          count++;
        } else {
          const previous = JSON.parse(old.payload);
          const different = previous.ai_input_tokens !== payload.ai_input_tokens || previous.ai_output_tokens !== payload.ai_output_tokens;
          if (different && old.state === "pending") {
            this.db.query("UPDATE queue SET payload=? WHERE id=?").run(JSON.stringify(payload), id);
          } else if (different) {
            this.db.query("UPDATE queue SET changed=1 WHERE id=?").run(id);
          }
        }
      }
      if (progressKey) this.set(progressKey, progress);
    });
  }

  pending(now, limit = 25) {
    return this.db.query("SELECT id, payload, attempts FROM queue WHERE state='pending' AND due<=? ORDER BY due, rowid LIMIT ?").all(now, limit);
  }

  ack(id, code, now, delay = 0) {
    const success = code >= 200 && code < 300;
    const permanent = code >= 400 && code < 500 && ![401, 403, 408, 429].includes(code);
    transaction(this.db, () => {
      this.db.query("UPDATE queue SET state=?, due=?, attempts=attempts+1, error=? WHERE id=? AND state='pending'")
        .run(success ? "sent" : permanent ? "rejected" : "pending", now + delay, success ? null : `http-${code}`, id);
      if (success) this.set("lastConfirmedAt", now);
    });
  }

  lease(owner, now) {
    return this.db.query(`INSERT INTO lease VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE
      SET owner=excluded.owner, expires=excluded.expires WHERE lease.expires<=? OR lease.owner=?`)
      .run(owner, now + 60_000, now, owner).changes === 1;
  }

  owns(owner, now) {
    return !!this.db.query("SELECT 1 FROM lease WHERE id=1 AND owner=? AND expires>?").get(owner, now);
  }

  release(owner) { this.db.query("DELETE FROM lease WHERE owner=?").run(owner); }

  status() {
    const counts = { pending: 0, sent: 0, rejected: 0, changed: 0 };
    for (const r of this.db.query("SELECT state, count(*) AS n FROM queue GROUP BY state").all()) counts[r.state] = r.n;
    counts.changed = this.db.query("SELECT count(*) AS n FROM queue WHERE changed=1").get().n;
    for (const key of ["enabledAt", "lastConfirmedAt", "lastCompleteDay", "backfillDay", "sourceError", "sendError", "credentials", "sendAfter", "runtime"]) counts[key] = this.get(key);
    counts.active = !!this.db.query("SELECT 1 FROM lease WHERE id=1 AND expires>?").get(Date.now());
    return counts;
  }

  close() { this.db.close(); }
}
