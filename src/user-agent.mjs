import { arch, platform, release } from "node:os";
import pkg from "../package.json" with { type: "json" };

const os = platform() === "win32" ? "windows" : platform();
export const defaultUserAgent = `Magpie/unknown (${os}-${release()}-${arch()}) magpie-wakatime/${pkg.version}`;

function normalize(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, "-") : "";
}

function modelToken(model) {
  model = normalize(model).replace(/^\/+|\/+$/g, "");
  if (!model) return "";

  // Keep named aliases and R1 variants in the DeepSeek family without guessing a release.
  const name = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1).replace(/^[-_.]+|[-_.]+$/g, "") : model;
  const deepseek = /^(deepseek)(?:[-_]+(.+))?$/i.exec(name) || /(?:^|\/)(deepseek)\/([^/]+)$/i.exec(model);
  if (deepseek) {
    const version = (deepseek[2] || "").split(/[-_]+/).filter(Boolean).join("-").replace(/^v(?=\d)/i, "") || "unknown";
    return `${deepseek[1]}/${version}`;
  }

  // Match wakatime-cli's aiModelUserAgentToken convention, including provider prefixes.
  if (/^[^/]+\/\d/.test(model)) return model;
  const parts = name.split(/[-_]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\D*)(\d.*)$/.exec(parts[i]);
    if (!match) continue;
    if (!match[1] && i === 0) return "";
    const product = !match[1] || (match[1].toLowerCase() === "v" && i > 0) ? parts[i - 1] : match[1];
    const version = [match[2], ...parts.slice(i + 1)].join("-");
    return `${product}/${version}`;
  }
  return "";
}

export function userAgent(model, effort) {
  let token = modelToken(model);
  if (!token) return defaultUserAgent;
  effort = normalize(effort).replace(/^[-_/.]+|[-_/.]+$/g, "");
  if (effort && !token.toLowerCase().endsWith(`-${effort.toLowerCase()}`)) token += `-${effort}`;
  return `${token} ${defaultUserAgent}`;
}
