# Security policy

TXG is a **descriptive** format. The tools in this repository parse and lint a `.txg` file and the skill folder around it. They never execute a command, a tool call or a `SKILL.md` instruction that a file describes, so a `flow.txg` containing `[tool: bash("rm -rf /")]` is read as text and reported, never run.

That is the design, not a guarantee about your environment. The linters read files from disk and parse untrusted input, so the realistic risks are the ordinary ones: a crash or hang on malformed input, a path that escapes the skill folder, or excessive memory on a crafted file.

## Reporting a vulnerability

Report privately, through GitHub's private vulnerability reporting on this repository: open the **Security** tab and choose **Report a vulnerability**. It is visible only to the maintainers.

Please do not open a public issue for a suspected vulnerability, and do not include secrets or a working exploit against anyone's live system.

Useful in a report: the affected commit, what an attacker gains, and the smallest `flow.txg` or skill folder that reproduces it offline. A reproduction that runs locally against `js/txg.mjs` or `python/txg.py` is worth more than a description.

## What to expect

This project is maintained by a small team and sets no response-time commitment it cannot keep. You will get an acknowledgement, and the fix, if there is one, lands as an ordinary pull request with a fixture that reproduces the problem.

## Scope

In scope: `js/txg.mjs`, `python/txg.py`, and the test runners in `tests/`.

Not in scope: the example skills in `examples/` and the fixtures in `fixtures/`, which are deliberately malformed input used to test the linters. A fixture that describes a dangerous command is test data; it describes, and nothing runs it.

The v0.2 compiler and the tools at [txgr.dev](https://txgr.dev) are a separate line and are not covered by this file. Report those through the same mechanism here and they will be routed.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.1 (this repository) | Security fixes only; the language is not being extended here |
| 0.2 (txgr.dev) | Developed separately, see that site |
