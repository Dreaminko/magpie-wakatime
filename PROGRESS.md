# Implementation status

Source plan: PLAN.md. This file records the current state; the status paragraph at the end of PLAN.md section 10 describes the plan-time situation only.

## Delivered

0.1.1 runs from this directory with no build step and no dependencies: `package.json`, `index.mjs`, `src/config.mjs`, `src/map.mjs`, `src/source.mjs`, `src/store.mjs`, `src/sync.mjs`, plus `README.md` and behavior tests in `test/`. The plugin also returns an `auth` hook whose only method is an API key prompt, so the app's 插件 page and `magpie plugin login wakatime` can store the WakaTime key for it. Heartbeats name the agent (`entity`) instead of always reporting `magpie`; heartbeats sent before that change used the fixed value, and an existing host keeps the old mapping until it restarts.

## Verified

- `bun test`: 22 pass, 0 fail.
- `npm pack --dry-run`: 8 files, only the entry, `src`, `README.md` and package metadata.
- Sign-in in an isolated host: `magpie plugin add` reports `wakatime (wakatime, 0 models) not signed in · magpie plugin login wakatime`, `magpie plugin --json` lists the `api` method with its label and placeholder, and `magpie plugin login wakatime` writes `{"wakatime":{"type":"api","key":...}}` to that sandbox's `plugin-auth.json`. The plugin then reads that key (checked by resolving the directory and the key from the signed-in file) and reports `credentials: configured`. The real Magpie configuration stayed byte-identical throughout.
- Real host, isolated configuration: `magpie plugin add|list|options|off|rm` loads the plugin, starts the uploader, and leaves no process behind.
- Incident on 2026-10-15: one `magpie plugin add` ran without the sandbox environment and landed in the user's real Magpie configuration. That instance has been uploading heartbeats to the user's real WakaTime account since then, and the entry is still installed. Removing the entry, restoring the `@magpie-community/opencode-zed-auth@latest` row that dropped out of `plugins.json`, and deleting those heartbeats are the user's decisions.
- Real usage API contract: response envelope and row keys checked against the locally running gateway.
- End-to-end collection and send: a local mock usage API produced three mapped heartbeats, which were queued and posted to `heartbeats.bulk` with an invalid test key. The upload returned HTTP 401, recorded `wakatime-http-401` and `invalid-key`, kept the rows pending, and wrote nothing to WakaTime (`sent=0`, `lastConfirmedAt` null).
- Missing key: the host runs the plugin, records `missing-key`, and does not activate collection (`enabledAt` stays null).
- Real upload with a valid WakaTime key: the user ran their own end-to-end test on 2026-10-15 and confirmed the heartbeats arrive.
- Agent-named entities: an isolated run (mock usage API, mock `heartbeats.bulk`) queued one `codex` request, `preview` printed `"entity": "codex"`, and the captured request body carried the same `entity` with the mapped token counts and salted session.

## Not verified

- npm publication and community listing, which stay outside the current scope.
