import { mkdirSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function tempDirectory() {
  const root = fileURLToPath(new URL("../.work/tests/", import.meta.url));
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "case-"));
}
