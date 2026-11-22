# mend-patch-tool

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tuyulsembilanenam672-cell/mend-patch-tool/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tuyulsembilanenam672-cell/mend-patch-tool/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` is one small CLI that applies AI-written edits to a tree of text files.
Models write edits in four formats, and `mend` reads them all: unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON. Every file is changed or nothing is.

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file; when it is absent or `-`, the patch is read from
  standard input. `--format` picks `unified`, `search-replace`, `v4a` or
  `json`; `auto` (the default) detects the format.
- `--check` does everything but write. `--strict` matches lines exactly.
- Lines are matched in three tiers: exact, then ignoring trailing whitespace,
  then ignoring leading and trailing whitespace with re-indenting — so a diff
  whose line numbers drifted, or whose indentation shifted, still applies.
- Edits are all-or-nothing: a failed edit changes nothing, later edits still
  run, and every failure is reported. Paths are checked for safety first.

Node 22, standard library alone, no dependencies. See `SPEC.md` in the kit
for the full contract; `main.ts` implements it, `runner.ts` is the kit's
trial runner (kept as the kit has it).

---

<sub>Entered on [make.fun](https://make.fun/?ref=sq78y28z&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
