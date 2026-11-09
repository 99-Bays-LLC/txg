import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lint, parse, toMermaid } from "../js/txg.mjs";

const codes = (src, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "txg-"));
  writeFileSync(join(dir, "flow.txg"), "@skill: t\n" + src);
  return lint(join(dir, "flow.txg")).map((f) => f.code);
};

test("the three canonical examples lint without errors", () => {
  for (const d of ["code-review", "deploy-pipeline", "pdf-extract"]) {
    const found = lint(`examples/${d}/flow.txg`);
    assert.deepEqual(found.filter((f) => f.severity === "error"), [], d);
    assert.deepEqual(found, [], d);
  }
});

test("parallel group is wait-all: members hang off the group node", () => {
  const g = parse('@skill: t\nc: { a: [tool: bash("x")] & b: [tool: bash("y")] }\nc -> d: [done]\n');
  assert.deepEqual(g.edges.filter((e) => e.type === "par").map((e) => e.to).sort(), ["a", "b"]);
});

test("a loop without a bound is an error; with one it is fine", () => {
  assert.ok(codes("a: [A]\nb: [B]\na -> b\nb -> a\n").includes("TXG005"));
  assert.ok(!codes("a: [A]\nb: [B]\na -> b\nb -> a (max 2)\n").includes("TXG005"));
});

test("? exit needs a tool before it", () => {
  assert.ok(codes("a: [Think]\na -> ? exit { 0 => b: [B]\n _ => c: [C] }\n").includes("TXG006"));
});

test("fork without _ warns, undefined and duplicate ids are errors", () => {
  assert.ok(codes('t: [tool: bash("x")]\nt -> ? exit { 0 => a: [A] }\n').includes("TXG007"));
  assert.ok(codes("a: [A]\na -> nope\n").includes("TXG002"));
  assert.ok(codes("a: [A]\na: [B]\n").includes("TXG003"));
});

test("tool syntax is namespaced", () => {
  assert.ok(codes("a: [tool: npm run build]\n").includes("TXG013"));
  assert.deepEqual(codes('a: [tool: bash("npm run build")]\nb: [tool: mcp:github/create_issue]\na -> b\n'), []);
});

test("mermaid output has fail and bound labels", () => {
  const m = toMermaid(parse('@skill: t\na: [A]\nb: [B]\na -> b\nb -> a (max 3)\na -!> c: [C]\n'));
  assert.match(m, /max 3/);
  assert.match(m, /"fail"/);
});
