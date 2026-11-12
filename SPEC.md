# Text Graph (.txg) v0.1.1

> This title is kept as published. The language was renamed **TXG** on 12 November 2026, after this
> version was settled. This document specifies v0.1.1 only; the current line is v0.2, specified
> separately at [txgr.dev](https://txgr.dev), with different syntax and diagnostic numbering.

A `.txg` file is a **descriptive map** of an agent skill: what it reads, what it runs, where it branches.
It lives beside `SKILL.md` as `flow.txg`. It is not an execution engine. `SKILL.md` stays the instruction set; the
graph is checked against it by a linter, rendered for humans, and may later act as a guardrail ("the run left the
expected path").

## Grammar (EBNF)

```ebnf
document  = { NL | directive | statement } ;
directive = "@" NAME ":" TEXT NL ;                      (* @skill is required; @entry @version @author optional *)
statement = ( reads | flow ) ( NL | EOF ) ;

reads     = node "reads" ":" node { "," node } ;        (* what a step pulls into context *)
flow      = node chain ;
chain     = { edge ( node [ bound ] | fork ) } ;
edge      = "->"                                         (* happy path *)
          | "-!>" ;                                      (* failure path *)
bound     = "(" "max" INT ")" ;                          (* limit for an edge that loops back *)

fork      = "?" test "{" arm { ( NL | "," ) arm } "}" ;
test      = "exit"                                       (* the previous tool's exit code: deterministic *)
          | "judge" STRING ;                             (* the model decides, by this criterion *)
arm       = pattern "=>" node [ bound ] chain ;
pattern   = INT | STRING | "_" ;                         (* exit: 0, 1, _   judge: "answer", _ *)

node      = [ ID ":" ] ( box | group ) | ID ;            (* "id: [..]" declares, a bare id refers *)
box       = "[" ( "file" ":" PATH | "tool" ":" call | LABEL ) "]" ;
call      = "bash" "(" STRING ")" | "mcp" ":" NAME "/" NAME ;
group     = "{" node "&" node { "&" node } "}" ;         (* run together; no nesting *)

ID        = letter { letter | digit | "_" | "-" } ;      STRING = '"' { char | '\"' } '"' ;
comment   = "#" { any } NL ;                             (* ignored, anywhere outside a string or box *)
```

## Meaning

- **Ids, not labels.** `build: [Build the site]` declares; `build` refers. An unlabelled `[box]` is a one-off.
- **`->` and `-!>`.** A node may have one `->` path and one `-!>` path. A tool step that fails (non-zero exit,
  error, timeout) takes `-!>` if it has one, otherwise the run stops and reports.
- **Parallel.** `{ a & b }` starts all members together. The join is a **barrier**: the next step waits for all.
  If any member fails, the group fails at once and takes the group's `-!>` edge.
- **Loops.** Only an edge that goes back to an earlier step is a loop, and it must carry `(max N)`. When the budget
  is spent, the run takes the `-!>` edge of the looping node (for a fork arm: of the node the fork tests), else stops.
- **Forks.** `? exit` reads the exit code of the tool step just before it. `? judge "..."` asks the model; its arms
  are the possible answers. Always give a `_` arm.
- **`reads`.** Documents that a step loads a file into context. Reads are not control flow.
- **Tools** are namespaced: `bash("git diff")`, `mcp:server/tool`. They should match `allowed-tools` in `SKILL.md`.
- **Entry** is the node named `skill`, or the first node in the file.

## Linter (`node txg.mjs lint <skill-dir>`)

| Code | Level | Checks |
|---|---|---|
| TXG001 | error | the file parses (line number given) |
| TXG002 / 003 | error | every id used is declared, and declared once |
| TXG004 | warn | a node is unreachable from the entry |
| TXG005 | error | a loop has no `(max N)`, or N is under 1 |
| TXG006 | error | `? exit` follows something that is not a tool |
| TXG007 | warn | a fork has no `_` arm |
| TXG008 | error | a `file:` node points at a file that does not exist |
| TXG009 | warn | a file in `references/ scripts/ schemas/ guidelines/ assets/` is mentioned by no node |
| TXG010 | warn | a `tool:` is not allowed by `allowed-tools` in `SKILL.md` |
| TXG011 | error | `@skill` is missing or differs from `name:` in `SKILL.md` |
| TXG012 | error | wrong arm patterns for the fork type (numbers for `judge`, words for `exit`) |
| TXG013 | error | a tool is not `bash("...")` or `mcp:server/tool` |

## Examples

**Code review with a retry loop** (`examples/code-review/flow.txg`)
```
skill: [SKILL.md]
skill reads: [file: references/rubric.md], [file: references/severity.md]
diff:   [tool: bash("git diff origin/main...HEAD")]
review: [Review the diff against the rubric, write findings.json]
check:  [tool: bash("scripts/validate-findings.sh findings.json")]
report: [Write the final review]
stop:   [Stop and report the unresolved findings]

skill -> diff -> review -> check
check -> ? exit {
  0 => report
  _ => review (max 3)
}
check -!> stop
```

**Deploy with parallel checks and a fallback** (`examples/deploy-pipeline/flow.txg`)
```
up:     [tool: bash("docker compose up -d")]
build:  [tool: bash("npm run build")]
ask:    [tool: mcp:prompts/ask-keys]
checks: { lint: [tool: bash("npm run lint")] & types: [tool: bash("npx tsc --noEmit")] }
health: [tool: bash("curl -fsS http://localhost:8080/health")]

skill -> ? judge "Which setup does this machine have?" {
  "docker"        => up
  "local runtime" => build
  _               => ask -> stop: [Halt with instructions]
}
up -!> build
up -> checks
build -> checks
checks -> health
health -> ? exit { 0 => tag: [tool: bash("git tag release")] -> done: [Report validated]
                   _ => logs: [Read the container logs] -> fix: [Propose a remediation] }
```

**Tool fallback** (`examples/pdf-extract/flow.txg`): `fast -!> ocr -> done`

## Drafting prompt (SKILL.md to flow.txg)

> Read this SKILL.md and the files beside it. Write `flow.txg` in TXG v0.1.1 (SPEC.md). Declare every step
> with an id. Use `reads:` for files loaded into context, `tool: bash("...")` or `mcp:server/tool` for commands, `? exit`
> only after a tool, `? judge "..."` for model decisions, `-!>` for failure paths, and `(max N)` on every loop. Do not
> invent steps the SKILL.md does not describe. Then run `node txg.mjs lint` and fix what it reports.

## Open questions for v0.2

- Should `@requires: bash, mcp:github` be a directive so runtimes can pre-check availability?
- Sub-skills: `[skill: other-skill]` as a fourth box kind?
- A tiny `txg fmt` so alignment and arm layout are never argued about.

## Clarifications (v0.1.1)

These came out of a clean-room read of the spec by a second implementer and from the shared fixtures.

- A LABEL is any text between `[` and the first `]` on the line. A newline or an unclosed box is an error. The prefixes `file:` and `tool:` are reserved. A box that contains a `[` is fine.
- A loop is a cycle in the graph (a back-edge found by depth-first search from the entry), not an edge that is textually earlier in the file.
- Anonymous boxes get ids `_n1`, `_n2`, ... in order of appearance. Forks get `_f1`, `_f2`, ... in their own counter. Renderers should treat ids as opaque.
- Group members and the targets of `reads` may be inline declarations (`id: [..]`) or bare ids.
- Newlines are allowed after a comma in `reads`, after an arrow, inside a group, and between fork arms. A statement otherwise ends at the end of the line. Multi-line forks are normal.
- An arm may continue as a full chain (`0 => build -> test -> deploy`). It ends at a newline, a comma or the closing brace.
- Comments start with `#` and run to the end of the line, including after a statement.
- Directive values may be wrapped in double quotes; the quotes are not part of the value.
- Inside `bash("...")`, a backslash makes the next character literal (`\"` and `\\`). Nothing else is interpreted.
- When a loop's budget is spent, the run follows the `-!>` edge of the node the fork tests (or of the looping node if there is no fork).
- **Grammar fix: a fork ends its chain.** The rule `chain = { edge ( node [ bound ] | fork ) }` wrongly allowed an edge after a fork. The correct rule is `chain = { edge node [ bound ] } [ edge fork ]`. Writing `-> ? judge ... { ... } -> ? exit { ... }` is a syntax error (TXG001); put the next test inside an arm instead.
