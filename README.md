# Text Graph (`.txg`)

A plain-text map of an agent skill. A `flow.txg` file sits beside `SKILL.md` and says what the skill reads, what it runs, and where it branches, in a format a person can read and a program can check.

It is a **description**, not an execution engine. `SKILL.md` stays the instruction set. The graph is checked against it by a linter, drawn for humans, and may later act as a guardrail ("the run left the expected path").

```
@skill: code-review
skill: [SKILL.md]
skill reads: [file: references/rubric.md]
diff:   [tool: bash("git diff origin/main...HEAD")]
review: [Review the diff against the rubric]
check:  [tool: bash("scripts/validate-findings.sh findings.json")]

skill -> diff -> review -> check
check -> ? exit {
  0 => report: [Write the final review]
  _ => review (max 3)
}
check -!> stop: [Stop and report the unresolved findings]
```

Happy path `->`, failure path `-!>`, loops that must carry `(max N)`, forks on a tool's exit code or on a model's judgement, parallel groups `{ a & b }`. The full grammar and meaning are in [SPEC.md](SPEC.md).

## Use it

No dependencies. Node 20+ or Python 3.10+.

```sh
node js/txg.mjs lint examples/code-review        # check a flow.txg
node js/txg.mjs mermaid examples/code-review/flow.txg
node js/txg.mjs json examples/code-review/flow.txg

python3 python/txg.py lint examples/code-review  # same, in Python
```

`lint` checks the file against the rules TXG001 to TXG013 (parse errors, undeclared or duplicate ids, unreachable steps, unbounded loops, bad forks, missing files, tools not allowed by `SKILL.md`, and more). It exits 1 if there is any error.

## Status

Version 0.1.1, a draft. Two independent implementations (JavaScript and Python) agree on all 39 shared fixtures in [fixtures/](fixtures/), one per lint rule case.

Next candidates, in order: an `[ask: "question"]` step for a human in the loop, then `[skill: name]` for calling another skill.

## Tests

```sh
npm test
```

## How this was made

The format was drafted by AI assistants (Claude and Gemini), working back and forth, and edited and directed by 99 Bays LLC. Treat it as a proposal to test against real skills, not a finished standard. Issues and pull requests are welcome.

## Licence

MIT. See [LICENSE](LICENSE).
