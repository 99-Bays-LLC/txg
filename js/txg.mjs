#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 99 Bays LLC
//
// txg.mjs: parser, linter and Mermaid exporter for TXG (.txg) v0.1.1.
// Zero dependencies, Node 20+.
//
//   node txg.mjs lint    <flow.txg | skill-dir> [--json]
//   node txg.mjs mermaid <flow.txg>
//   node txg.mjs json    <flow.txg>          (the parsed graph, for renderers)
//
// It reads and reports. It never runs a command, tool call or instruction that a
// .txg file describes. The grammar is in SPEC.md; every lint code is listed at
// the bottom of that file.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export class TxgError extends Error {
  constructor(message, line, code = "TXG001") {
    super(message);
    this.line = line;
    this.code = code;
  }
}

// ---------------------------------------------------------------- tokens
export function tokenize(src) {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  const push = (t, v, l = line) => toks.push({ t, v, line: l });
  while (i < n) {
    const c = src[i];
    if (c === "\n") { push("NL", "\n"); line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "@" && (i === 0 || src[i - 1] === "\n")) {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      push("DIR", src.slice(i + 1, j).replace(/\r$/, "").trim());
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\n") throw new TxgError("string is not closed on its line", line);
        if (src[j] === "\\" && j + 1 < n) { s += src[j + 1]; j += 2; } else s += src[j++];
      }
      if (j >= n) throw new TxgError("string is not closed", line);
      push("STR", s);
      i = j + 1;
      continue;
    }
    if (c === "[") {
      // A box runs to the matching "]" outside quotes, so bash("a[0]") is fine.
      let j = i + 1;
      let q = false;
      while (j < n) {
        const d = src[j];
        if (d === "\n") throw new TxgError("box is not closed on its line", line);
        if (d === "\\" && q) { j += 2; continue; }
        if (d === '"') q = !q;
        else if (!q && d === "]") break;
        j++;
      }
      if (j >= n) throw new TxgError("box is not closed", line);
      push("BOX", src.slice(i + 1, j).trim());
      i = j + 1;
      continue;
    }
    if (src.startsWith("-!>", i)) { push("FAIL", "-!>"); i += 3; continue; }
    if (src.startsWith("->", i)) { push("ARROW", "->"); i += 2; continue; }
    if (src.startsWith("=>", i)) { push("FAT", "=>"); i += 2; continue; }
    if ("?{}&,():".includes(c)) { push(c, c); i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (/[0-9]/.test(src[j] ?? "")) j++;
      push("INT", Number(src.slice(i, j)));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && (/\w/.test(src[j]) || (src[j] === "-" && !">!".includes(src[j + 1] ?? "")))) j++;
      push("ID", src.slice(i, j));
      i = j;
      continue;
    }
    throw new TxgError(`unexpected "${c}"`, line);
  }
  push("EOF", "");
  return toks;
}

// ---------------------------------------------------------------- parser
const TOOL_BASH = /^bash\(\s*"((?:[^"\\]|\\.)*)"\s*\)$/s;
const TOOL_MCP = /^mcp:([\w.-]+)\/([\w.-]+)$/;

function boxNode(body, line) {
  const m = /^(file|tool)\s*:\s*(.+)$/s.exec(body);
  if (!m) return { kind: "step", label: body, line };
  const [, kind, arg] = m;
  if (kind === "file") return { kind: "file", path: arg.trim(), label: arg.trim(), line };
  const bash = TOOL_BASH.exec(arg.trim());
  if (bash) return { kind: "tool", tool: { type: "bash", command: bash[1].replace(/\\(.)/g, "$1") }, label: arg.trim(), line };
  const mcp = TOOL_MCP.exec(arg.trim());
  if (mcp) return { kind: "tool", tool: { type: "mcp", server: mcp[1], name: mcp[2] }, label: arg.trim(), line };
  throw new TxgError(`tool must be bash("...") or mcp:server/tool, got "${arg.trim()}"`, line, "TXG013");
}

export function parse(src) {
  const toks = tokenize(src);
  let i = 0;
  let anon = 0;
  let forks = 0;
  const g = { directives: {}, nodes: new Map(), edges: [], reads: [], refs: [], decls: [] };
  const peek = (o = 0) => toks[i + o];
  const next = () => toks[i++];
  const fail = (msg, t = peek()) => { throw new TxgError(msg, t.line); };
  const expect = (t, what = t) => (peek().t === t ? next() : fail(`expected ${what}, found "${peek().v || peek().t}"`));
  const skipNL = () => { while (peek().t === "NL") i++; };

  const declare = (id, node) => {
    node.id = id;
    if (g.nodes.has(id)) g.decls.push({ dup: true, id, line: node.line });
    else g.nodes.set(id, node);
    return id;
  };

  function parseGroup() {
    const open = expect("{");
    const members = [];
    skipNL();
    members.push(parseMember());
    skipNL();
    while (peek().t === "&") { next(); skipNL(); members.push(parseMember()); skipNL(); }
    expect("}", '"}"');
    if (members.length < 2) fail("a parallel group needs at least two steps joined by &", open);
    return { kind: "group", members, label: "run together", line: open.line };
  }

  function parseMember() {
    const t = peek();
    if (t.t === "{") fail("parallel groups cannot be nested", t);
    return parseNode();
  }

  function parseNode() {
    const t = peek();
    if (t.t === "ID" && peek(1).t === ":" && (peek(2).t === "BOX" || peek(2).t === "{")) {
      next(); next();
      const body = peek().t === "BOX" ? boxNode(next().v, t.line) : parseGroup();
      return declare(t.v, body);
    }
    if (t.t === "ID") { next(); g.refs.push({ id: t.v, line: t.line }); return t.v; }
    if (t.t === "BOX") { next(); return declare(`_n${++anon}`, boxNode(t.v, t.line)); }
    if (t.t === "{") return declare(`_n${++anon}`, parseGroup());
    return fail(`expected a step, found "${t.v || t.t}"`);
  }

  function parseBound() {
    next();
    const kw = expect("ID", '"max"');
    if (kw.v !== "max") fail('only (max N) is allowed here', kw);
    const n = expect("INT", "a number");
    expect(")", '")"');
    return n.v;
  }

  function addEdge(from, to, type, line, extra = {}) {
    g.edges.push({ from, to, type, line, ...extra });
  }

  // cur --edge--> next, repeated. Returns the last node.
  function parseChain(cur) {
    while (peek().t === "ARROW" || peek().t === "FAIL") {
      const arrow = next();
      const type = arrow.t === "FAIL" ? "fail" : "ok";
      skipNL();
      if (peek().t === "?") {
        const fk = parseFork(cur, arrow.line);
        addEdge(cur, fk, type, arrow.line);
        return fk;
      }
      const to = parseNode();
      const bound = peek().t === "(" ? parseBound() : null;
      addEdge(cur, to, type, arrow.line, bound === null ? {} : { bound });
      cur = to;
    }
    return cur;
  }

  function parseFork(from, line) {
    next(); // ?
    const kind = expect("ID", '"exit" or "judge"');
    let test;
    let criteria = null;
    if (kind.v === "exit") test = "exit";
    else if (kind.v === "judge") { test = "judge"; criteria = expect("STR", "the criteria in quotes").v; }
    else fail('a fork is "? exit" or "? judge \\"criteria\\""', kind);
    skipNL();
    expect("{", '"{"');
    const id = `_f${++forks}`;
    const fork = { kind: "fork", test, criteria, from, arms: [], label: test === "exit" ? "exit code" : criteria, line };
    declare(id, fork);
    skipNL();
    while (peek().t !== "}") {
      const p = next();
      let pattern;
      if (p.t === "INT") pattern = p.v;
      else if (p.t === "STR") pattern = p.v;
      else if (p.t === "ID" && p.v === "_") pattern = "_";
      else fail(`expected 0, _ or a quoted answer, found "${p.v || p.t}"`, p);
      expect("FAT", '"=>"');
      const to = parseNode();
      const bound = peek().t === "(" ? parseBound() : null;
      addEdge(id, to, "ok", p.line, { label: String(pattern), ...(bound === null ? {} : { bound }) });
      fork.arms.push({ pattern, to, line: p.line });
      parseChain(to);
      while (peek().t === "NL" || peek().t === ",") i++;
    }
    expect("}", '"}"');
    return id;
  }

  function parseStatement() {
    const first = parseNode();
    if (peek().t === "ID" && peek().v === "reads" && peek(1).t === ":") {
      const kw = next(); next();
      const list = [];
      do {
        skipNL();
        list.push(parseNode());
      } while (peek().t === "," && next());
      for (const to of list) g.reads.push({ from: first, to, line: kw.line });
    } else {
      parseChain(first);
    }
    if (peek().t !== "NL" && peek().t !== "EOF") fail(`unexpected "${peek().v || peek().t}"`);
  }

  while (peek().t !== "EOF") {
    const t = peek();
    if (t.t === "NL") { next(); continue; }
    if (t.t === "DIR") {
      next();
      const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(t.v);
      if (!m) fail("a directive looks like @name: value", t);
      g.directives[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
      continue;
    }
    parseStatement();
  }
  g.nodes.forEach((n, id) => {
    if (n.kind === "group") n.members.forEach((m) => g.edges.push({ from: id, to: m, type: "par", line: n.line }));
  });
  return g;
}

// ---------------------------------------------------------------- lint
const frontmatter = (dir) => {
  const p = join(dir, "SKILL.md");
  if (!existsSync(p)) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(p, "utf8"));
  if (!m) return { name: null, allowed: null };
  const name = /^name:\s*(.+)$/m.exec(m[1])?.[1].trim().replace(/^["']|["']$/g, "") ?? null;
  let allowed = null;
  const inline = /^allowed-tools:[ \t]*(.*)$/m.exec(m[1]);
  if (inline) {
    allowed = inline[1].trim()
      ? inline[1].split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean)
      : [...m[1].matchAll(/^\s+-\s+(.+)$/gm)].map((x) => x[1].trim());
  }
  return { name, allowed };
};

const toolAllowed = (node, allowed) => {
  const t = node.tool;
  return allowed.some((a) => {
    if (t.type === "bash") {
      if (a === "Bash") return true;
      const m = /^Bash\((.*)\)$/.exec(a);
      if (!m) return false;
      const prefix = m[1].replace(/:?\*$/, "").trim();
      return t.command.startsWith(prefix);
    }
    return a === `mcp__${t.server}` || a === `mcp__${t.server}__${t.name}` || a === `mcp__${t.server}__*`;
  });
};

function walkFiles(dir, root, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walkFiles(p, root, out);
    else out.push(relative(root, p).split("\\").join("/"));
  }
  return out;
}

export function lint(file) {
  const dir = dirname(file);
  const out = [];
  const add = (severity, code, line, message) => out.push({ severity, code, line, message });
  let g;
  try {
    g = parse(readFileSync(file, "utf8"));
  } catch (e) {
    if (e instanceof TxgError) return [{ severity: "error", code: e.code, line: e.line, message: e.message }];
    throw e;
  }

  // Ids
  for (const d of g.decls) if (d.dup) add("error", "TXG003", d.line, `"${d.id}" is declared twice`);
  for (const r of g.refs) if (!g.nodes.has(r.id)) add("error", "TXG002", r.line, `"${r.id}" is used but never declared (write ${r.id}: [what it does])`);

  // @skill and the SKILL.md next to it
  const fm = frontmatter(dir);
  if (!g.directives.skill) add("error", "TXG011", 1, "missing @skill: name");
  else if (fm?.name && fm.name !== g.directives.skill) add("error", "TXG011", 1, `@skill "${g.directives.skill}" does not match name "${fm.name}" in SKILL.md`);

  // Entry and reachability (reads edges are not control flow)
  const entry = g.nodes.has("skill") ? "skill" : g.nodes.keys().next().value;
  const out_ = new Map();
  for (const e of g.edges) {
    if (!out_.has(e.from)) out_.set(e.from, []);
    out_.get(e.from).push(e);
  }
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    for (const e of out_.get(id) ?? []) stack.push(e.to);
  }
  const readTargets = new Set(g.reads.map((r) => r.to));
  for (const [id, n] of g.nodes) {
    if (!seen.has(id) && !readTargets.has(id) && n.kind !== "file") add("warning", "TXG004", n.line, `"${id}" can never be reached from "${entry}"`);
  }

  // Cycles need a bound
  const color = new Map();
  const dfs = (id) => {
    color.set(id, 1);
    for (const e of out_.get(id) ?? []) {
      if (color.get(e.to) === 1 && e.bound == null) add("error", "TXG005", e.line, `"${e.from}" loops back to "${e.to}" with no bound: write ${e.to} (max N)`);
      else if (!color.has(e.to)) dfs(e.to);
    }
    color.set(id, 2);
  };
  if (entry) dfs(entry);
  for (const e of g.edges) if (e.bound != null && e.bound < 1) add("error", "TXG005", e.line, "(max N) needs N of at least 1");

  // Forks
  for (const [id, n] of g.nodes) {
    if (n.kind !== "fork") continue;
    if (n.test === "exit") {
      const src = g.nodes.get(n.from);
      if (!src || src.kind !== "tool") add("error", "TXG006", n.line, `? exit reads a tool's exit code, but "${n.from}" is not a tool`);
      if (n.arms.some((a) => typeof a.pattern === "string" && a.pattern !== "_")) add("error", "TXG012", n.line, "? exit arms are numbers or _");
    } else if (n.arms.some((a) => typeof a.pattern === "number")) {
      add("error", "TXG012", n.line, '? judge arms are quoted answers (or _), not numbers');
    }
    if (!n.arms.some((a) => a.pattern === "_")) add("warning", "TXG007", n.line, `fork "${id}" has no _ arm; say what happens for any other result`);
  }

  // Files: declared ones exist, and nothing in references/ etc. is orphaned
  const mentioned = [];
  for (const n of g.nodes.values()) {
    if (n.kind === "file" && !existsSync(resolve(dir, n.path))) add("error", "TXG008", n.line, `file "${n.path}" does not exist`);
    mentioned.push(n.path ?? "", n.tool?.command ?? "", n.label ?? "");
  }
  for (const sub of ["references", "schemas", "scripts", "guidelines", "assets"]) {
    const root = join(dir, sub);
    if (!existsSync(root)) continue;
    for (const f of walkFiles(root, dir)) {
      if (!mentioned.some((m) => m.includes(f))) add("warning", "TXG009", 1, `"${f}" is in the skill folder but no node mentions it`);
    }
  }

  // Tools against allowed-tools
  if (fm?.allowed) {
    for (const [id, n] of g.nodes) {
      if (n.kind === "tool" && !toolAllowed(n, fm.allowed)) add("warning", "TXG010", n.line, `"${id}" runs ${n.label}, which allowed-tools in SKILL.md does not permit`);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------- mermaid
export function toMermaid(g) {
  const q = (s) => String(s).replace(/"/g, "#quot;");
  const id = (x) => x.replace(/\W/g, "_");
  const lines = ["flowchart TD"];
  for (const [nid, n] of g.nodes) {
    const l = q(
      n.kind === "fork" ? `? ${n.test}${n.criteria ? `: ${n.criteria}` : ""}`
      : n.kind === "tool" ? (n.tool.type === "bash" ? `$ ${n.tool.command}` : `mcp ${n.tool.server}/${n.tool.name}`)
      : n.label,
    );
    const shape = { step: `["${l}"]`, tool: `[["${l}"]]`, file: `[("${l}")]`, fork: `{"${l}"}`, group: `{{"${l}"}}` }[n.kind];
    lines.push(`  ${id(nid)}${shape}`);
  }
  for (const e of g.edges) {
    const bits = [e.label, e.bound != null ? `max ${e.bound}` : null].filter((x) => x != null);
    const lab = bits.length ? `|"${q(bits.join(", "))}"|` : "";
    if (e.type === "fail") lines.push(`  ${id(e.from)} -. "fail" .-> ${id(e.to)}`);
    else lines.push(`  ${id(e.from)} -->${lab} ${id(e.to)}`);
  }
  for (const r of g.reads) lines.push(`  ${id(r.from)} -. reads .-> ${id(r.to)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- cli
function main(argv) {
  const [cmd, target, ...flags] = argv;
  if (!cmd || !target) {
    console.error("usage: txg lint <flow.txg|dir> [--json] | txg mermaid <flow.txg> | txg json <flow.txg>");
    return 2;
  }
  let file = resolve(target);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "flow.txg");
  if (!existsSync(file)) { console.error(`not found: ${file}`); return 2; }
  if (cmd === "lint") {
    const found = lint(file);
    if (flags.includes("--json")) console.log(JSON.stringify(found, null, 2));
    else {
      for (const f of found) console.log(`${basename(file)}:${f.line}  ${f.severity.padEnd(7)} ${f.code}  ${f.message}`);
      const errors = found.filter((f) => f.severity === "error").length;
      console.log(`${errors} error(s), ${found.length - errors} warning(s)`);
    }
    return found.some((f) => f.severity === "error") ? 1 : 0;
  }
  const g = parse(readFileSync(file, "utf8"));
  if (cmd === "mermaid") console.log(toMermaid(g));
  else if (cmd === "json") console.log(JSON.stringify({ ...g, nodes: Object.fromEntries(g.nodes), refs: undefined, decls: undefined }, null, 2));
  else { console.error(`unknown command "${cmd}"`); return 2; }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
