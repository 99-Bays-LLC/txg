#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 99 Bays LLC
"""
txg.py: Zero-dependency Python 3.10+ parser, linter, and exporter for TXG (.txg) v0.1.1.

Written from SPEC.md without reading txg.mjs, so that the two implementations
disagreeing would expose an ambiguity in the specification. A direct token-stream
recursive descent implementation; it now matches txg.mjs on all 39 fixtures.

It reads and reports. It never runs a command, tool call or instruction that a
.txg file describes.
"""

import sys
import os
import re
import json
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple

class TxgError(Exception):
    def __init__(self, message: str, line: int, code: str = "TXG001"):
        super().__init__(message)
        self.message = message
        self.line = line
        self.code = code

class Token:
    def __init__(self, t: str, v: Any, line: int):
        self.t = t
        self.v = v
        self.line = line

def tokenize(src: str) -> List[Token]:
    toks: List[Token] = []
    i = 0
    line = 1
    n = len(src)
    
    def push(t: str, v: Any, l: int = line):
        toks.append(Token(t, v, l))

    while i < n:
        c = src[i]
        if c == "\n":
            push("NL", "\n", line)
            line += 1
            i += 1
            continue
        if c in (" ", "\t", "\r"):
            i += 1
            continue
        if c == "#":
            while i < n and src[i] != "\n":
                i += 1
            continue
        if c == "@" and (i == 0 or src[i - 1] == "\n"):
            j = i
            while j < n and src[j] != "\n":
                j += 1
            push("DIR", src[i + 1:j].rstrip("\r").strip(), line)
            i = j
            continue
        if c == '"':
            j = i + 1
            s = ""
            while j < n and src[j] != '"':
                if src[j] == "\n":
                    raise TxgError("string is not closed on its line", line)
                if src[j] == "\\" and j + 1 < n:
                    s += src[j + 1]
                    j += 2
                else:
                    s += src[j]
                    j += 1
            if j >= n:
                raise TxgError("string is not closed", line)
            push("STR", s, line)
            i = j + 1
            continue
        if c == "[":
            j = i + 1
            q = False
            while j < n:
                d = src[j]
                if d == "\n":
                    raise TxgError("box is not closed on its line", line)
                if d == "\\" and q:
                    j += 2
                    continue
                if d == '"':
                    q = not q
                elif not q and d == "]":
                    break
                j += 1
            if j >= n:
                raise TxgError("box is not closed", line)
            push("BOX", src[i + 1:j].strip(), line)
            i = j + 1
            continue
        if src.startswith("-!>", i):
            push("FAIL", "-!>", line)
            i += 3
            continue
        if src.startswith("->", i):
            push("ARROW", "->", line)
            i += 2
            continue
        if src.startswith("=>", i):
            push("FAT", "=>", line)
            i += 2
            continue
        if c in "?{}&,():":
            push(c, c, line)
            i += 1
            continue
        if c.isdigit():
            j = i
            while j < n and src[j].isdigit():
                j += 1
            push("INT", int(src[i:j]), line)
            i = j
            continue
        if c.isalpha() or c == "_":
            j = i
            while j < n and (src[j].isalnum() or src[j] == "_" or (src[j] == "-" and not (j + 1 < n and src[j + 1] in ">!"))):
                j += 1
            push("ID", src[i:j], line)
            i = j
            continue
        raise TxgError(f'unexpected "{c}"', line)

    push("EOF", "", line)
    return toks

TOOL_BASH = re.compile(r'^bash\(\s*"((?:[^"\\]|\\.)*)"\s*\)$', re.DOTALL)
TOOL_MCP = re.compile(r'^mcp:([\w.-]+)/([\w.-]+)$')

def box_node(body: str, line: int) -> Dict[str, Any]:
    m = re.match(r'^(file|tool)\s*:\s*(.+)$', body, re.DOTALL)
    if not m:
        return {"kind": "step", "label": body, "line": line}
    kind, arg = m.group(1), m.group(2).strip()
    if kind == "file":
        return {"kind": "file", "path": arg, "label": arg, "line": line}
    
    bash = TOOL_BASH.match(arg)
    if bash:
        cmd = re.sub(r'\\(.)', r'\1', bash.group(1))
        return {"kind": "tool", "tool": {"type": "bash", "command": cmd}, "label": arg, "line": line}
    
    mcp = TOOL_MCP.match(arg)
    if mcp:
        return {"kind": "tool", "tool": {"type": "mcp", "server": mcp.group(1), "name": mcp.group(2)}, "label": arg, "line": line}
    
    raise TxgError(f'tool must be bash("...") or mcp:server/tool, got "{arg}"', line, "TXG013")

class Graph:
    def __init__(self):
        self.directives: Dict[str, str] = {}
        self.nodes: Dict[str, Dict[str, Any]] = {}
        self.edges: List[Dict[str, Any]] = []
        self.reads: List[Dict[str, Any]] = []
        self.refs: List[Dict[str, Any]] = []
        self.decls: List[Dict[str, Any]] = []

def parse(src: str) -> Graph:
    toks = tokenize(src)
    i = 0
    anon = 0
    forks = 0
    g = Graph()

    def peek(o: int = 0) -> Token:
        idx = i + o
        return toks[idx] if idx < len(toks) else toks[-1]

    def next_tok() -> Token:
        nonlocal i
        t = peek()
        i += 1
        return t

    def fail(msg: str, t: Optional[Token] = None):
        target = t if t is not None else peek()
        raise TxgError(msg, target.line)

    def expect(t_type: str, what: Optional[str] = None) -> Token:
        p = peek()
        if p.t == t_type:
            return next_tok()
        fail(f'expected {what or t_type}, found "{p.v or p.t}"')

    def skip_nl():
        while peek().t == "NL":
            next_tok()

    def declare(nid: str, node: Dict[str, Any]) -> str:
        node["id"] = nid
        if nid in g.nodes:
            g.decls.append({"dup": True, "id": nid, "line": node["line"]})
        else:
            g.nodes[nid] = node
        return nid

    def parse_group() -> Dict[str, Any]:
        open_tok = expect("{")
        members = []
        skip_nl()
        members.append(parse_member())
        skip_nl()
        while peek().t == "&":
            next_tok()
            skip_nl()
            members.append(parse_member())
            skip_nl()
        expect("}", '"}"')
        if len(members) < 2:
            fail("a parallel group needs at least two steps joined by &", open_tok)
        return {"kind": "group", "members": members, "label": "run together", "line": open_tok.line}

    def parse_member() -> str:
        t = peek()
        if t.t == "{":
            fail("parallel groups cannot be nested", t)
        return parse_node()

    def parse_node() -> str:
        nonlocal anon
        t = peek()
        if t.t == "ID" and peek(1).t == ":" and peek(2).t in ("BOX", "{"):
            next_tok() # ID
            next_tok() # :
            body = box_node(next_tok().v, t.line) if peek().t == "BOX" else parse_group()
            return declare(t.v, body)
        if t.t == "ID":
            next_tok()
            g.refs.append({"id": t.v, "line": t.line})
            return t.v
        if t.t == "BOX":
            anon += 1
            return declare(f"_n{anon}", box_node(next_tok().v, t.line))
        if t.t == "{":
            anon += 1
            return declare(f"_n{anon}", parse_group())
        return fail(f'expected a step, found "{t.v or t.t}"')

    def parse_bound() -> int:
        next_tok() # (
        kw = expect("ID", '"max"')
        if kw.v != "max":
            fail('only (max N) is allowed here', kw)
        n = expect("INT", "a number")
        expect(")", '")"')
        return int(n.v)

    def add_edge(from_id: str, to_id: str, edge_type: str, line: int, **extra):
        edge = {"from": from_id, "to": to_id, "type": edge_type, "line": line}
        edge.update(extra)
        g.edges.append(edge)

    def parse_chain(cur: str) -> str:
        while peek().t in ("ARROW", "FAIL"):
            arrow = next_tok()
            edge_type = "fail" if arrow.t == "FAIL" else "ok"
            skip_nl()
            if peek().t == "?":
                fk = parse_fork(cur, arrow.line)
                add_edge(cur, fk, edge_type, arrow.line)
                return fk
            to_id = parse_node()
            bound = parse_bound() if peek().t == "(" else None
            extra = {"bound": bound} if bound is not None else {}
            add_edge(cur, to_id, edge_type, arrow.line, **extra)
            cur = to_id
        return cur

    def parse_fork(from_id: str, line: int) -> str:
        nonlocal forks
        next_tok() # ?
        kind = expect("ID", '"exit" or "judge"')
        test = kind.v
        criteria = None
        if test == "exit":
            pass
        elif test == "judge":
            criteria = expect("STR", "the criteria in quotes").v
        else:
            fail('a fork is "? exit" or "? judge \\"criteria\\""', kind)
        
        skip_nl()
        expect("{", '"{"')
        forks += 1
        fork_id = f"_f{forks}"
        fork_node = {
            "kind": "fork",
            "test": test,
            "criteria": criteria,
            "from": from_id,
            "arms": [],
            "label": "exit code" if test == "exit" else criteria,
            "line": line
        }
        declare(fork_id, fork_node)
        skip_nl()

        while peek().t != "}":
            p = next_tok()
            if p.t in ("INT", "STR"):
                pattern = p.v
            elif p.t == "ID" and p.v == "_":
                pattern = "_"
            else:
                fail(f'expected 0, _ or a quoted answer, found "{p.v or p.t}"', p)
            
            expect("FAT", '"=>"')
            to_id = parse_node()
            bound = parse_bound() if peek().t == "(" else None
            extra = {"label": str(pattern)}
            if bound is not None:
                extra["bound"] = bound
            add_edge(fork_id, to_id, "ok", p.line, **extra)
            fork_node["arms"].append({"pattern": pattern, "to": to_id, "line": p.line})
            parse_chain(to_id)
            while peek().t in ("NL", ","):
                next_tok()

        expect("}", '"}"')
        return fork_id

    def parse_statement():
        first = parse_node()
        if peek().t == "ID" and peek().v == "reads" and peek(1).t == ":":
            kw = next_tok()
            next_tok() # :
            targets = []
            while True:
                skip_nl()
                targets.append(parse_node())
                if peek().t == ",":
                    next_tok()
                else:
                    break
            for tgt in targets:
                g.reads.append({"from": first, "to": tgt, "line": kw.line})
        else:
            parse_chain(first)
        
        if peek().t not in ("NL", "EOF"):
            fail(f'unexpected "{peek().v or peek().t}"')

    while peek().t != "EOF":
        t = peek()
        if t.t == "NL":
            next_tok()
            continue
        if t.t == "DIR":
            next_tok()
            m = re.match(r'^([A-Za-z][\w-]*)\s*:\s*(.*)$', t.v)
            if not m:
                fail("a directive looks like @name: value", t)
            g.directives[m.group(1)] = re.sub(r'^"(.*)"$', r'\1', m.group(2).strip())
            continue
        parse_statement()

    for nid, n in list(g.nodes.items()):
        if n.get("kind") == "group":
            for m in n.get("members", []):
                g.edges.append({"from": nid, "to": m, "type": "par", "line": n["line"]})

    return g

def frontmatter(skill_dir: Path) -> Dict[str, Any]:
    p = skill_dir / "SKILL.md"
    if not p.exists():
        return {"name": None, "allowed": None}
    content = p.read_text(encoding="utf-8")
    m = re.search(r"^---\r?\n([\s\S]*?)\r?\n---", content)
    if not m:
        return {"name": None, "allowed": None}
    fm_text = m.group(1)
    
    name_m = re.search(r"^name:\s*(.+)$", fm_text, re.MULTILINE)
    name = re.sub(r'^["\']|["\']$', '', name_m.group(1).strip()) if name_m else None
    
    allowed = None
    inline_m = re.search(r"^allowed-tools:[ \t]*(.*)$", fm_text, re.MULTILINE)
    if inline_m:
        raw = inline_m.group(1).strip()
        if raw:
            allowed = [re.sub(r'\s+', ' ', t.strip()) for t in re.split(r',(?![^(]*\))', raw) if t.strip()]
        else:
            allowed = [x.strip() for x in re.findall(r"^\s+-\s+(.+)$", fm_text, re.MULTILINE)]
    return {"name": name, "allowed": allowed}

def tool_allowed(node: Dict[str, Any], allowed: List[str]) -> bool:
    t = node.get("tool", {})
    t_type = t.get("type")
    for a in allowed:
        if t_type == "bash":
            if a == "Bash":
                return True
            m = re.match(r"^Bash\((.*)\)$", a)
            if not m:
                continue
            prefix = re.sub(r":?\*$", "", m.group(1)).strip()
            if t.get("command", "").startswith(prefix):
                return True
        elif t_type == "mcp":
            server, name = t.get("server"), t.get("name")
            if a in (f"mcp__{server}", f"mcp__{server}__{name}", f"mcp__{server}__*"):
                return True
    return False

def walk_files(directory: Path, root: Path) -> List[str]:
    out = []
    for entry in directory.iterdir():
        if entry.is_dir():
            out.extend(walk_files(entry, root))
        else:
            out.append(str(entry.relative_to(root)).replace("\\", "/"))
    return out

def lint(file_path: str) -> List[Dict[str, Any]]:
    p = Path(file_path).resolve()
    skill_dir = p.parent
    diagnostics = []

    def add(severity: str, code: str, line: int, message: str):
        diagnostics.append({"severity": severity, "code": code, "line": line, "message": message})

    try:
        g = parse(p.read_text(encoding="utf-8"))
    except TxgError as e:
        return [{"severity": "error", "code": e.code, "line": e.line, "message": e.message}]

    for d in g.decls:
        if d.get("dup"):
            add("error", "TXG003", d["line"], f'"{d["id"]}" is declared twice')
    for r in g.refs:
        if r["id"] not in g.nodes:
            add("error", "TXG002", r["line"], f'"{r["id"]}" is used but never declared (write {r["id"]}: [what it does])')

    fm = frontmatter(skill_dir)
    skill_dir_directive = g.directives.get("skill")
    if not skill_dir_directive:
        add("error", "TXG011", 1, "missing @skill: name")
    elif fm.get("name") and fm["name"] != skill_dir_directive:
        add("error", "TXG011", 1, f'@skill "{skill_dir_directive}" does not match name "{fm["name"]}" in SKILL.md')

    entry = "skill" if "skill" in g.nodes else (next(iter(g.nodes.keys())) if g.nodes else None)
    out_edges: Dict[str, List[Dict[str, Any]]] = {}
    for e in g.edges:
        out_edges.setdefault(e["from"], []).append(e)

    seen = set()
    stack = [entry] if entry else []
    while stack:
        curr = stack.pop()
        if not curr or curr in seen:
            continue
        seen.add(curr)
        for e in out_edges.get(curr, []):
            stack.append(e["to"])

    read_targets = {r["to"] for r in g.reads}
    for nid, n in g.nodes.items():
        if nid not in seen and nid not in read_targets and n.get("kind") != "file":
            add("warning", "TXG004", n["line"], f'"{nid}" can never be reached from "{entry}"')

    color: Dict[str, int] = {}
    def dfs(curr: str):
        color[curr] = 1
        for e in out_edges.get(curr, []):
            nxt = e["to"]
            if color.get(nxt) == 1 and e.get("bound") is None:
                add("error", "TXG005", e["line"], f'"{e["from"]}" loops back to "{nxt}" with no bound: write {nxt} (max N)')
            elif nxt not in color:
                dfs(nxt)
        color[curr] = 2

    if entry:
        dfs(entry)

    for e in g.edges:
        if e.get("bound") is not None and e["bound"] < 1:
            add("error", "TXG005", e["line"], "(max N) needs N of at least 1")

    for nid, n in g.nodes.items():
        if n.get("kind") != "fork":
            continue
        test = n.get("test")
        arms = n.get("arms", [])
        from_id = n.get("from")
        if test == "exit":
            src_node = g.nodes.get(from_id)
            if not src_node or src_node.get("kind") != "tool":
                add("error", "TXG006", n["line"], f'? exit reads a tool\'s exit code, but "{from_id}" is not a tool')
            if any(isinstance(a["pattern"], str) and a["pattern"] != "_" for a in arms):
                add("error", "TXG012", n["line"], "? exit arms are numbers or _")
        elif test == "judge":
            if any(isinstance(a["pattern"], int) for a in arms):
                add("error", "TXG012", n["line"], "? judge arms are quoted answers (or _), not numbers")
        
        if not any(a["pattern"] == "_" for a in arms):
            add("warning", "TXG007", n["line"], f'fork "{nid}" has no _ arm; say what happens for any other result')

    mentioned = []
    for n in g.nodes.values():
        if n.get("kind") == "file":
            fpath = skill_dir / n.get("path", "")
            if not fpath.exists():
                add("error", "TXG008", n["line"], f'file "{n.get("path")}" does not exist')
        mentioned.extend([n.get("path") or "", n.get("tool", {}).get("command") or "", n.get("label") or ""])

    for sub in ["references", "schemas", "scripts", "guidelines", "assets"]:
        sub_dir = skill_dir / sub
        if not sub_dir.exists():
            continue
        for rel in walk_files(sub_dir, skill_dir):
            if not any(rel in m for m in mentioned):
                add("warning", "TXG009", 1, f'"{rel}" is in the skill folder but no node mentions it')

    if fm.get("allowed") is not None:
        for nid, n in g.nodes.items():
            if n.get("kind") == "tool" and not tool_allowed(n, fm["allowed"]):
                add("warning", "TXG010", n["line"], f'"{nid}" runs {n["label"]}, which allowed-tools in SKILL.md does not permit')

    return sorted(diagnostics, key=lambda x: x["line"])

def to_mermaid(g: Graph) -> str:
    def q(s: Any) -> str:
        return str(s).replace('"', '#quot;')
    def sanitize(x: str) -> str:
        return re.sub(r'\W', '_', x)

    lines = ["flowchart TD"]
    for nid, n in g.nodes.items():
        kind = n.get("kind")
        if kind == "fork":
            crit = f': {n["criteria"]}' if n.get("criteria") else ""
            l = q(f'? {n["test"]}{crit}')
        elif kind == "tool":
            t = n.get("tool", {})
            l = q(f'$ {t.get("command")}' if t.get("type") == "bash" else f'mcp {t.get("server")}/{t.get("name")}')
        else:
            l = q(n.get("label"))

        shape = {
            "step": f'["{l}"]',
            "tool": f'[["{l}"]]',
            "file": f'[("{l}")]',
            "fork": f'{{"{l}"}}',
            "group": f'{{{{"{l}"}}}}'
        }.get(kind, f'["{l}"]')
        lines.append(f"  {sanitize(nid)}{shape}")

    for e in g.edges:
        bits = [e.get("label"), f'max {e["bound"]}' if e.get("bound") is not None else None]
        bits = [b for b in bits if b is not None]
        lab = f'|"{q(", ".join(bits))}"|' if bits else ""
        if e.get("type") == "fail":
            lines.append(f'  {sanitize(e["from"])} -. "fail" .-> {sanitize(e["to"])}')
        else:
            lines.append(f'  {sanitize(e["from"])} -->{lab} {sanitize(e["to"])}')

    for r in g.reads:
        lines.append(f'  {sanitize(r["from"])} -. reads .-> {sanitize(r["to"])}')

    return "\n".join(lines)

def to_json(g: Graph) -> str:
    return json.dumps({
        "directives": g.directives,
        "nodes": g.nodes,
        "edges": g.edges,
        "reads": g.reads
    }, indent=2)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: python txg.py lint <flow.txg|dir> [--json]", file=sys.stderr)
        print("       python txg.py mermaid <flow.txg>", file=sys.stderr)
        print("       python txg.py json <flow.txg>", file=sys.stderr)
        sys.exit(2)
    cmd, target = sys.argv[1], sys.argv[2]
    flags = sys.argv[3:]

    p = Path(target).resolve()
    if p.is_dir():
        p = p / "flow.txg"
    if not p.exists():
        print(f"not found: {p}", file=sys.stderr)
        sys.exit(2)

    if cmd == "lint":
        found = lint(str(p))
        if "--json" in flags:
            print(json.dumps(found, indent=2))
        else:
            for f in found:
                print(f"{p.name}:{f['line']}  {f['severity'].ljust(7)} {f['code']}  {f['message']}")
            errors = sum(1 for f in found if f["severity"] == "error")
            print(f"{errors} error(s), {len(found) - errors} warning(s)")
        sys.exit(1 if any(f["severity"] == "error" for f in found) else 0)

    g = parse(p.read_text(encoding="utf-8"))
    if cmd == "mermaid":
        print(to_mermaid(g))
    elif cmd == "json":
        print(to_json(g))
    else:
        print(f'unknown command "{cmd}"', file=sys.stderr)
        sys.exit(2)
