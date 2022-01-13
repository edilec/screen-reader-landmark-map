# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Renaming a `ruleId` is a breaking change and is recorded here.

## [0.1.0]

### Added

- First implementation. Reads exported DOM snapshots, extracts landmark roles and the heading
  hierarchy, and produces a navigable outline with structural findings.
- A bounded, explicit HTML subset written for this tool. What it handles and what it refuses are
  both listed in `docs/structure-rules.md`; a construct outside the subset makes the run incomplete
  rather than being parsed optimistically.
- Thirty-three rules with severity taken from one frozen table, nineteen of which force an
  incomplete run.
- Regions the snapshot does not contain are named rather than passed over: shadow roots serialised
  and not, custom elements that may hold one, iframe content, and HTML inside an SVG
  `foreignObject`.
- A landmark whose accessible name could not be resolved is left out of the duplicate comparison
  and the run is marked incomplete, so a comparison is never reported clean on evidence dropped
  while making it.
- `--out` with a three-hole destination guard: a destination that is itself a symbolic link is
  refused on sight, and a destination sharing a device and inode with any snapshot is refused. The
  destination is deliberately not confined to a root, and the help text, README and rule document
  all say so.
- Deterministic output: code-unit ordering, no clock, no locale, byte-identical stdout across runs.
