# TXG (`.txg`) v0.1.1

A plain-text map of an agent skill. A `flow.txg` file sits beside `SKILL.md` and says what the skill reads, what it runs, and where it branches, in a format a person can read and a program can check.

> **Which line is this?** This repository is **v0.1.1**: the original draft, with two independent implementations that agree on all 39 fixtures. It is complete and it still runs, but it is not where the language is being developed now.
>
> Current work is the **v0.2** line at **[txgr.dev](https://txgr.dev)**, which has a different syntax, different diagnostic numbering and its own compiler. Passing the 39 fixtures here says nothing about v0.2 conformance. For what v0.2 does, what is broken in it and what was never built, see [txgr.dev/history](https://txgr.dev/history).
>
> The language was called "Text Graph" until 12 November 2026. The name was retired: **TXG** is the language, **TXGR** the platform and site.

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

Version 0.1.1, a draft, and settled. Two independent implementations (JavaScript and Python) agree on all 39 shared fixtures in [fixtures/](fixtures/), one per lint rule case. Writing the parser twice, the second time from the specification alone without reading the first, is what turned the vague parts of the draft into questions that had to be answered.

This line is no longer being extended. The `[ask: "question"]` step for a human in the loop was the next candidate here; it exists in v0.2 instead, along with `[halt]`, header-level loop bounds and a context budget. New language work belongs on the v0.2 line at [txgr.dev](https://txgr.dev).

Bug reports against the v0.1.1 implementations in this repository are still welcome.

## Tests

```sh
npm test
```

## How this was made

The format was drafted by AI assistants (Claude and Gemini), working back and forth, and edited and directed by 99 Bays LLC. Treat it as a proposal to test against real skills, not a finished standard. Issues and pull requests are welcome.

## Licence

MIT. See [LICENSE](LICENSE).
