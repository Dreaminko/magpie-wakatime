import { platform, release } from "node:os";
import pkg from "../package.json" with { type: "json" };

export const defaultUserAgent = `Magpie/unknown (${platform()} ${release()}) magpie-wakatime/${pkg.version}`;

function normalize(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, "-") : "";
}

export function userAgent(model, effort) {
  model = normalize(model).replace(/^\/+|\/+$/g, "");
  if (!model) return defaultUserAgent;
  effort = normalize(effort).replace(/^[-_/.]+|[-_/.]+$/g, "");
  if (effort && !model.toLowerCase().endsWith(`-${effort.toLowerCase()}`)) model += `-${effort}`;

  // Match wakatime-cli's aiModelUserAgentToken convention, including provider prefixes.
  if (/^[^/]+\/\d/.test(model)) return `${model} ${defaultUserAgent}`;
  if (model.includes("/")) model = model.slice(model.lastIndexOf("/") + 1).replace(/^[-_.]+|[-_.]+$/g, "");
  const parts = model.split(/[-_]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const match = /^(\D*)(\d.*)$/.exec(parts[i]);
    if (!match) continue;
    if (!match[1] && i === 0) return defaultUserAgent;
    const product = !match[1] || (match[1].toLowerCase() === "v" && i > 0) ? parts[i - 1] : match[1];
    const version = [match[2], ...parts.slice(i + 1)].join("-");
    return `${product}/${version} ${defaultUserAgent}`;
  }
  return defaultUserAgent;
}
