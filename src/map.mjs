import { createHmac } from "node:crypto";

function digest(value, salt) {
  return createHmac("sha256", salt).update(JSON.stringify(value)).digest("hex");
}

export function sourceId(row, salt) {
  return digest([row.t, row.route_id ?? "", row.agent ?? "", row.provider ?? "",
    row.host ?? "", row.model ?? "", row.rid || row.response_id || ""], salt);
}

export function mapRow(row, options, salt) {
  if (row.computer || row.rejected || (row.source && row.source !== "through") ||
      (row.via && row.via !== "through") || options.excludeAgents.includes(row.agent)) return null;
  const time = typeof row.t === "string" ? Date.parse(row.t) / 1000 : NaN;
  const values = [row.in, row.out, row.cache_read ?? 0, row.cache_write ?? 0];
  if (!Number.isFinite(time) || time <= 0 || values.some((n) => !Number.isSafeInteger(n) || n < 0)) {
    throw new Error("invalid-row");
  }
  const input = values[0] + values[2] + values[3];
  if (!Number.isSafeInteger(input)) throw new Error("invalid-row");
  if (input + values[1] === 0) return null;
  const agent = typeof row.agent === "string" && row.agent.trim().length <= 255 ? row.agent.trim() : "";
  const payload = {
    entity: agent || "magpie", type: "app", category: "ai coding", time,
    project: Object.hasOwn(options.projectByAgent, row.agent) ? options.projectByAgent[row.agent] : options.project,
    ai_input_tokens: input, ai_output_tokens: values[1], is_write: false,
  };
  const session = row.native_session || row.session;
  if (session) payload.ai_session = digest([row.agent ?? "", session], salt);
  return payload;
}
