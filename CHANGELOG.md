# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Renaming a `ruleId` is a breaking change and is recorded here.

## [Unreleased]

### Fixed

- A node referenced directly by `aria-labelledby` now contributes its text even when it carries
  `aria-hidden="true"`, which is what step 2A of the accessible name computation says. It
  contributed nothing, so a navigation region labelled by a visually hidden span was reported twice
  over as `duplicate-unlabelled-landmark` at error severity and the run exited 1 on correct markup.
  The exception covers the referenced node only; an `aria-hidden` element inside it still
  contributes nothing.
- An `aria-labelledby` that resolves to empty text now falls through to `aria-label`, the contents
  and `title`, which is what step 2B says: the accumulated text is returned only when it is not
  empty. The name was settled as empty instead, so a heading with visible text was reported as
  `heading-empty` and a `nav` carrying `aria-label` was reported as unlabelled — both at error
  severity, both exit 1.
- The heading hierarchy and `no-main-landmark` are no longer asserted across a region of the page
  the run did not read. Every heading inside a serialised shadow root, an iframe, an SVG
  `foreignObject` or a subtree whose `role` is unrecognised is dropped while building the heading
  list, so a level jump over one of those regions, a first heading below level 1 with one before
  it, "the document declares no heading at all" and "the document declares no main landmark" were
  positive claims about markup the file does not contain. The regions themselves are still reported
  and the run is still `incomplete`; the verdict is what is withheld. A level jump with nothing
  unread between the two headings is still reported, and so is more than one level 1 heading.
- A snapshot's file name is flattened like every other untrusted string. `documents[].file` carried
  the raw basename, so a file name holding U+000A forged a whole line of the human summary in the
  shape of a finding, and U+202E reversed the display after it. The uniqueness check that keeps two
  documents apart is now made on the flattened name, so two names that differ only in stripped
  characters are refused rather than reported as one name twice.

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
