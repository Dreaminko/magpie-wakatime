import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readOptions, pluginEnabled } from "./src/config.mjs";
import { Sync } from "./src/sync.mjs";
import { bindWorker } from "./src/context.hooks.mjs";

export default async function MagpieWakaTime({ directory }, options) {
  const root = dirname(fileURLToPath(import.meta.url));
  const worker = new Sync(directory, readOptions(options), { enabled: () => pluginEnabled(directory, root) });
  bindWorker(worker);
  worker.start();
  return {
    // The sign-in row in the app is the intended way to hand over a WakaTime key.
    // It has no models; the provider exists only so magpie stores the key in
    // plugin-auth.json.
    auth: {
      provider: "wakatime",
      methods: [{ type: "api", label: "WakaTime API key", placeholder: "waka_..." }],
      loader: async () => ({}),
    },
  };
}
