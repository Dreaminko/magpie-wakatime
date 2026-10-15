import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function readOptions(options = {}) {
  const invalid = () => { throw new Error("invalid-config"); };
  if (!options || typeof options !== "object" || Array.isArray(options)) invalid();
  let url;
  try { url = new URL(options.gatewayUrl ?? "http://127.0.0.1:3425"); } catch { invalid(); }
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) invalid();
  const result = {
    gatewayUrl: url.origin, apiKeyEnv: options.apiKeyEnv ?? "WAKATIME_API_KEY",
    project: options.project ?? "Magpie", projectByAgent: options.projectByAgent ?? {},
    excludeAgents: options.excludeAgents ?? [],
  };
  const label = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 255;
  if (!label(result.project) || !/^[a-z_][a-z0-9_]*$/i.test(result.apiKeyEnv) ||
      !result.projectByAgent || typeof result.projectByAgent !== "object" || Array.isArray(result.projectByAgent) ||
      !Object.entries(result.projectByAgent).every(([k, v]) => label(k) && label(v)) ||
      !Array.isArray(result.excludeAgents) || !result.excludeAgents.every(label)) invalid();
  return result;
}

// The app stores keys entered in its sign-in prompt in plugin-auth.json.
function signInKey(directory) {
  let text;
  try { text = readFileSync(join(directory, "plugin-auth.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("key-config-unreadable"); }
  let list;
  try { list = JSON.parse(text); } catch { return null; }
  if (!list || typeof list !== "object") return null;
  const ids = ["wakatime", ...Object.keys(list).filter((id) => id.startsWith("wakatime#"))];
  for (const id of ids) {
    const entry = list[id];
    if (entry?.type === "api" && typeof entry.key === "string" && entry.key.trim()) return entry.key.trim();
  }
  return null;
}

export function readApiKey(directory, variable, env = process.env) {
  const signedIn = signInKey(directory);
  if (signedIn) return signedIn;
  if (env[variable]?.trim()) return env[variable].trim();
  const base = env.WAKATIME_HOME || env.USERPROFILE || env.HOME || homedir();
  if (!base) return null;
  let text;
  try { text = readFileSync(join(base, ".wakatime.cfg"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("key-config-unreadable"); }
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) section = header[1].toLowerCase();
    const entry = line.match(/^\s*api_key\s*=\s*(.*?)\s*$/i);
    if (section === "settings" && entry) return entry[1] || null;
  }
  return null;
}

export function pluginEnabled(directory, root) {
  try {
    const list = JSON.parse(readFileSync(join(directory, "plugins.json"), "utf8"));
    const normal = (s) => resolve(s.replace(/^file:\/\//, "")).replace(/\\/g, "/").toLowerCase();
    return list.plugins.some((p) => typeof p.spec === "string" && !p.off &&
      (/^magpie-wakatime(?:@[^/]+)?$/.test(p.spec) || normal(p.spec) === normal(root)));
  } catch { return false; }
}

export function defaultDirectory(env = process.env) {
  return join(env.XDG_CONFIG_HOME || join(env.USERPROFILE || env.HOME || homedir(), ".config"), "magpie");
}
