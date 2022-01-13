# screen-reader-landmark-map

Map the landmark roles and heading hierarchy of an exported DOM snapshot, produce a navigable
outline, and locate the two structural defects that make a page hard to move around: **navigation
regions that cannot be told apart**, and **a heading level that was skipped**.

The input is markup somebody exported. This tool opens no browser, runs no assistive technology,
fetches nothing and measures nothing.

Zero runtime dependencies, zero dev dependencies, Node built-ins only, Node >= 22.

- **Repository:** [edilec/screen-reader-landmark-map](https://github.com/edilec/screen-reader-landmark-map)
- **The HTML subset, the rules and the limits:** [docs/structure-rules.md](./docs/structure-rules.md)
- **License:** MIT

## Results stay DOM-based evidence

This is the tool's central limit, and it is enforced as behaviour rather than printed as a
disclaimer.

The outline is **document order**, not announcement order. A screen reader's landmark rotor,
its heading list and its reading order are products of a browser's accessibility tree and the
assistive technology's own heuristics, none of which is in an HTML file. What a screen reader
actually says needs separate, manual evidence, and nothing here is a substitute for it.

Where a region of the page is not in the file, the tool says which region and marks the run
`incomplete` — it does not narrow what it checked and report a clean map:

| Not in the file | Rule |
| --- | --- |
| A serialised shadow root — its composed position depends on slot assignment, which a snapshot does not record | `shadow-root-not-traversed` |
| A custom element with no serialised shadow root, which may hold a closed one | `shadow-root-unknown` |
| An iframe's content, which is a separate document | `iframe-content-unavailable` |
| HTML inside an SVG `foreignObject` | `foreign-content-skipped` |
| Markup outside the parser's declared subset | `html-construct-unsupported`, `stray-end-tag`, `mismatched-end-tag`, `unclosed-element` |
| An `aria-labelledby` reference this document cannot resolve | `name-reference-unresolved` |

A page built from custom elements cannot be mapped completely from a plain `outerHTML` snapshot,
and this tool will tell you that rather than report a map of the part it could see. That is the
whole point: a landmark map claiming "one navigation region" for a page whose other three are
inside a web component is worse than no map, because somebody will ship on it.

**Unknown is never a pass on either side of a comparison.** A landmark whose accessible name could
not be resolved is left out of the duplicate-landmark comparison *and* the run is marked
incomplete, with the finding saying which comparison could not be completed. Dropping the
unreadable side and then asserting the remaining ones are fine is the exact defect this rule
exists to prevent.

## It is not an HTML parser

It reads a **bounded, explicit subset** of HTML and refuses the rest. The subset is listed in
[docs/structure-rules.md](./docs/structure-rules.md): start and end tags, attributes in all three
quoting styles, comments, the doctype, void elements, raw text elements, the optional end tags that
real markup omits, and a named character-reference set of about fifty entries plus numeric
references.

A construct outside the subset is not given a best guess. `<div/>` is read the way HTML reads it —
the element stays open — and the document is reported as having left the subset, so the run is
incomplete either way.

## Quick start

```sh
node bin/screen-reader-landmark-map.mjs --snapshot examples/docs-clean.html
```

```
screen-reader-landmark-map: status pass
1 document(s), 43 element(s); 8 landmark(s), 6 heading(s).
0 unresolved name(s), 0 region(s) this snapshot does not contain.
outline docs-clean.html
  banner "" /html[1]/body[1]/header[1]
    navigation "Primary" /html[1]/body[1]/header[1]/nav[1]
  main "" /html[1]/body[1]/main[1]
    h1 "Deployment handbook" /html[1]/body[1]/main[1]/h1[1]
```

Three examples, three exit codes:

```sh
node bin/screen-reader-landmark-map.mjs --snapshot examples/docs-clean.html         # 0  pass
node bin/screen-reader-landmark-map.mjs --snapshot examples/shop-duplicate-nav.html # 1  fail
node bin/screen-reader-landmark-map.mjs --snapshot examples/app-shell-partial.html  # 2  incomplete
```

stdout always carries the JSON report and nothing else, so it pipes straight into a JSON parser.
The human summary goes to stderr, where `--json` suppresses it.

## What it reports

| Rule | Severity | Meaning |
| --- | --- | --- |
| `duplicate-unlabelled-landmark` | error | Two or more landmarks of one repeatable role with no accessible name. |
| `heading-level-skipped` | error | A heading level jumps by more than one. |
| `heading-empty` | error | A heading has no accessible name. |
| `duplicate-unique-landmark` | error | More than one `banner`, `contentinfo` or `main`. |
| `duplicate-landmark-name` | warning | Two landmarks of one role share a name. |
| `no-main-landmark` | warning | Nothing to skip to. |
| `name-reference-unresolved` | warning | An `aria-labelledby` reference this document cannot resolve. |
| `landmark-role-redundant` | info | A `role` attribute repeating the element's implicit role. |

Thirty-three rules in all, including the ones that refuse an input rather than judge it. The full
catalog, with the nineteen that force an incomplete run, is in
[docs/structure-rules.md](./docs/structure-rules.md).

Severity comes from a single frozen `ruleId -> severity` table; an unknown rule id throws. The test
suite asserts that table against the documented catalog in both directions **and** drives every one
of the thirty-three rules through the real CLI, asserting the `status` and the exit code that come
back — because three declarations can be edited together to agree with each other, and an exit code
cannot be edited at all.

## Writing a file

`--out FILE` also writes the JSON report to a path.

It is **not confined to a root**, because this tool has no root to confine it to: the destination is
whatever path you name, and a symbolically linked parent directory on the way there is followed,
exactly as it is for `cp` and for shell redirection. Documenting a confinement the code does not
perform would be worse than saying nothing.

Two destinations are refused, and each needs its own check because neither catches the other: one
that is **itself a symbolic link** (`realpath` would resolve it, and resolving is the dangerous
act), and one that is the **same file as a snapshot**, which only device plus inode can see because
a hard link shares no path with the file it duplicates. The input set handed to that check is every
snapshot path the run resolved, recorded before any of them is read.

A refused destination is a configuration error: exit 2, empty stdout, nothing written.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | The structure passed and every snapshot was read completely. | report |
| 1 | An error-severity finding, with no evidence missing. | report |
| 2 | Invalid usage, or a refused `--out`. | **empty** |
| 2 | Input that could not be read or decoded, or a region the file does not contain. | `status: "incomplete"` report |

A usage error means the run never had a subject, so there is nothing to report about. An unreadable
input means the run had a subject and failed to obtain evidence about it — a consumer piping stdout
must handle both. `incomplete` outranks `fail`.

## Non-goals

- **It does not emulate a screen reader.** See above. It reports DOM-based evidence and the
  outline is document order.
- **It is not an HTML parser** and does not claim to be. The subset it reads is listed explicitly.
- **It does not open a browser, take a screenshot or measure anything.** No network access at any
  point, including in its tests.
- **It does not compute full accessible names.** Landmark and heading names use a documented,
  narrower form: `aria-labelledby` within the document, `aria-label`, text content, `title`.
- **It does not check anything but structure.** No contrast, no focus order, no form labels, no
  ARIA attribute validation.
- **It does not find content outside landmarks**, and does not judge whether a heading's text is
  good. It reports where the headings and landmarks are, and where the hierarchy breaks.
- **It cannot tell you the page is navigable.** It can tell you what this snapshot's structure is,
  and where the snapshot does not say.

## Verification

```sh
npm run check
```

That runs `lint` (a syntax check over every source, test and bin file), the full `node:test` suite,
the clean example end to end, and `npm pack --dry-run`.

## License

MIT. See [LICENSE](./LICENSE).
