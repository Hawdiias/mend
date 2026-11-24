# mend

[![Competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hawdiias/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Hawdiias/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies a patch written in
any of the four formats AI tools emit — unified diffs, SEARCH/REPLACE
blocks, the V4A begin/end-patch format, or JSON edit commands — to a tree
of files, exactly as SPEC.md specifies:

- **Three matching tiers**: exact, trailing-whitespace-forgiving, and
  indentation-forgiving with re-indentation of written lines, so an edit
  still lands when the model drifted the whitespace.
- **Unified diffs** with wrong line numbers: each hunk takes the
  occurrence nearest its stated position, with the `\ No newline` rules
  for final line breaks, file creations, deletions and renames.
- **SEARCH/REPLACE blocks** with path inheritance between blocks.
- **V4A patches** with cursor-based chunks, `@@` anchors and
  `*** End of File` chunks, plus `*** Move to:` renames.
- **JSON edits** in array or JSON Lines form (`create`, `str_replace`,
  `insert`), with CRLF files handled in their own line breaks.
- **All or nothing**: edits apply in order, and if any edit fails,
  nothing is written; the exit code and summary lines follow the spec
  exactly (`ok: N files`, `failed: K of M edits`, one `error:` line per
  failed edit).

## Usage

```
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [--] [PATCH]
```

`PATCH` is a patch file, or standard input when omitted or `-`.
`--check` reports what would change without writing; `--strict` allows
only exact (tier 0) matching.

Node 22, standard library only. In a make.fun trial the grader sets
`MAKEFUN_ENV_URL` and `main.ts` hands over to the kit's `runner.ts`,
which is included unchanged.

Entry for the make.fun bounty
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
MIT licensed.
