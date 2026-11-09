# Contributing

Small, plain changes are easiest to review.

- **Spec changes** go in `SPEC.md`, with at least one fixture in `fixtures/` that shows the new behaviour. A fixture is a folder with a `flow.txg` and an `expect.json` listing the findings (`severity`, `code`, `line`, `message`) the linter must produce.
- **Both implementations must agree.** `js/txg.mjs` and `python/txg.py` must pass every fixture. `npm test` runs both.
- **No dependencies.** Each implementation is one file using only its standard library.
- **Real skills beat invented ones.** If you can describe a real `SKILL.md` as a `flow.txg` and something does not fit, open an issue with the skill and what was missing. That is the most useful kind of report.
