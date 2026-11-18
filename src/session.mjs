import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

async function entries(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch { return []; }
}

async function headerDirectory(file, session) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // Omp may put a title before its session header. Never parse transcript entries.
    for (const line of buffer.toString("utf8", 0, bytesRead).split("\n", 2)) {
      const header = JSON.parse(line);
      if (header.type === "title") continue;
      return header.type === "session" && header.id === session &&
        typeof header.cwd === "string" && isAbsolute(header.cwd) ? header.cwd : null;
    }
  } catch { /* Missing, incomplete or malformed metadata is optional. */ }
  finally { await handle?.close(); }
  return null;
}

export async function sessionDirectory(agent, session, env = process.env) {
  if (agent !== "omp" || typeof session !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(session)) return null;
  const home = env.USERPROFILE || env.HOME || homedir();
  const config = join(home, env.PI_CONFIG_DIR || ".omp");
  const profile = (env.OMP_PROFILE ?? env.PI_PROFILE ?? "").trim().toLowerCase();
  if (profile && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) return null;
  const named = profile && profile !== "default";
  let root = named ? join(config, "profiles", profile, "agent") : resolve(env.PI_CODING_AGENT_DIR || join(config, "agent"));
  if (env.XDG_DATA_HOME && (named || !env.PI_CODING_AGENT_DIR) && process.platform !== "win32") {
    const data = named ? join(env.XDG_DATA_HOME, "omp", "profiles", profile) : join(env.XDG_DATA_HOME, "omp");
    try { if ((await stat(data)).isDirectory()) root = data; } catch { /* Use the standard layout. */ }
  }
  root = join(root, "sessions");
  let cwd = null;
  for (const project of await entries(root)) {
    if (!project.isDirectory()) continue;
    const directory = join(root, project.name);
    for (const file of await entries(directory)) {
      if (!file.isFile() || !file.name.endsWith(`_${session}.jsonl`)) continue;
      const found = await headerDirectory(join(directory, file.name), session);
      if (found && cwd && found !== cwd) return null;
      if (found) cwd = found;
    }
  }
  return cwd;
}
