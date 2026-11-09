// Runs every fixtures/*/ against js/txg.mjs and compares with expect.json.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { lint } from "../js/txg.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const key = (l) => l.map((f) => `${f.code}@${f.line}:${f.severity}`);
let failed = 0;
const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
for (const d of dirs) {
  const dir = join(root, d.name);
  const want = JSON.parse(readFileSync(join(dir, "expect.json"), "utf8"));
  const got = lint(join(dir, "flow.txg"));
  if (JSON.stringify(key(got)) !== JSON.stringify(key(want))) {
    failed++;
    console.error(`FAIL ${d.name}\n  want ${key(want)}\n  got  ${key(got)}`);
  }
}
console.log(`${dirs.length - failed}/${dirs.length} fixtures pass (js)`);
process.exit(failed ? 1 : 0);
