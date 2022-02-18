# screen-reader-landmark-map: the HTML subset, the rule catalog and the limits

## The input is an exported DOM snapshot

One or more HTML files that somebody exported from a page. The tool opens no browser, drives no
session, resolves no host and measures nothing itself. Everything it reports is what the markup in
front of it says, which is why a region of the page the file does not contain makes the run
incomplete rather than quietly shrinking what was checked.

## The HTML subset

This is **not an HTML parser**. A real one implements insertion modes, foster parenting, the
adoption agency algorithm and a table of over two thousand character references. This reads the
part of the grammar a serialised snapshot actually contains and refuses the rest.

### Handled

| Construct | Notes |
| --- | --- |
| Start and end tags | Tag names are lowercased. |
| Attributes | Double quoted, single quoted and unquoted. Names are lowercased. A repeated attribute keeps the first value, as a browser does, and is reported. |
| Comments and the doctype | Skipped. |
| Void elements | `area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `source`, `track`, `wbr`. |
| Raw text elements | `script`, `style`, `iframe`, `noscript`. Content is skipped to the matching end tag. |
| Escapable raw text elements | `title`, `textarea`. Content is text with character references. |
| Optional end tags | `p`, `li`, `dd`, `dt`, `option`, `optgroup`, `tr`, `td`, `th`, `thead`, `tbody`, `tfoot`, `rt`, `rp`, `head`, `body`, `html`, closed by the documented implied-end-tag table. |
| Character references | The named set listed in `src/html.mjs`, plus `&#NN;` and `&#xNN;`. |

### Refused, each with its own rule

| Construct | Rule |
| --- | --- |
| A CDATA section or a processing instruction | `html-construct-unsupported` |
| An unterminated tag, comment, doctype or quoted attribute value | `html-construct-unsupported` |
| XML self-closing syntax on a non-void element | `html-construct-unsupported` |
| An end tag matching nothing that is open | `stray-end-tag` |
| An end tag closing across an element whose end tag is not optional | `mismatched-end-tag` |
| An element still open at the end of the input | `unclosed-element` |
| A named character reference outside the decoded set | `entity-unsupported` |

A refused construct is never given a best guess. `<div/>` is read the way HTML reads it — the
element stays open — and the document is reported as having left the subset, so the run is
incomplete either way.

### Not seen at all, and named rather than passed over

| Region | Rule | Why |
| --- | --- | --- |
| A serialised shadow root (`<template shadowrootmode>`) | `shadow-root-not-traversed` | Its composed position depends on slot assignment, which a snapshot does not record. |
| A custom element with no serialised shadow root | `shadow-root-unknown` | It may hold a closed or unserialised one. |
| An iframe's content | `iframe-content-unavailable` | It is a separate document and is not in this file. |
| HTML inside an SVG `foreignObject` | `foreign-content-skipped` | The SVG subtree is not walked into. |
| An SVG or MathML subtree with no `foreignObject` | `foreign-content-ignored` (info) | Landmarks and HTML headings are not defined there. |
| A `<template>` element's content | `template-content-skipped` (info) | It is inert until a script clones it. |
| A `<noscript>` element's content | none | It is not rendered when scripting is enabled, which is what a browser snapshot represents. This is a stated limit, not a check. |

The first four make the run incomplete. A page built from custom elements therefore cannot be
mapped completely from a plain `outerHTML` snapshot, and the report says so instead of reporting a
map of the part it could see.

## Landmarks

| Element | Role | Condition |
| --- | --- | --- |
| `header` | `banner` | Not inside `article`, `aside`, `main`, `nav` or `section`. |
| `footer` | `contentinfo` | Same. |
| `nav` | `navigation` | |
| `main` | `main` | |
| `search` | `search` | |
| `aside` | `complementary` | Always at the top level; inside sectioning content only when it has an accessible name. |
| `form` | `form` | Only when it has an accessible name. |
| `section` | `region` | Only when it has an accessible name. |

An explicit `role` attribute takes the first token and overrides the implicit role. A role outside
the recognised list is `role-unknown`: whether the element is a landmark is unknown, its subtree is
not mapped, and the run is incomplete.

### Accessible names, in this bounded form

`aria-labelledby` resolved against ids **in this document only**, then `aria-label`, then — for
headings — the element's contents, then `title`. This is narrower than the full accessible name
computation and it is not a substitute for it.

Three details of that computation are implemented here on purpose, and each is stated so a reader
can check them against the specification rather than trust this tool:

- **Step 2A.** A node referenced **directly** by `aria-labelledby` contributes its text *even when
  it carries `aria-hidden="true"`*. The reference is the author saying "this element is the label".
  The exception covers the referenced node itself and not its descendants: an `aria-hidden` element
  *inside* it still contributes nothing. The sister tool `aria-name-explainer` implements and pins
  the same rule, and the two tools answer the same markup the same way.
- **Step 2B.** The text accumulated from `aria-labelledby` is returned **only when it is not
  empty**. A reference that resolves to an element with no perceivable text falls through to
  `aria-label`, then to the contents, then to `title` — exactly as an empty `aria-label` does. It
  does not settle the name as "unnamed".
- **Step 2F.** The contents are not raw text. For each descendant the computation asks for *that
  node's* accessible name, so a descendant's `aria-labelledby`, its `aria-label` and its own text
  alternative all count: an `img` or an `area` contributes its `alt`, a button-like `input`
  contributes its `value` or HTML's default for its type, a `select` contributes the selected
  option, and a `br` contributes a space. Concatenating raw text instead found nothing at all in a
  void element, which reported `<h1><img alt="Acme"></h1>` as a heading with no accessible name at
  error severity. A `textarea` is deliberately not in that list: HTML makes its child text its
  value, and this parser reads it as exactly that. A reference reached from **inside** the contents
  that this document cannot resolve leaves the whole name unresolved, for the reason below.

A reference naming nothing this document contains, or naming an id more than one element carries,
is `name-reference-unresolved`. Such a landmark is **left out of the duplicate comparison** rather
than counted as unnamed, and the run is incomplete, so the comparison is never reported as clean
on evidence that was dropped while making it.

`section`, `form` and a nested `aside` are landmarks **only when they are named**, so an unresolved
reference on one of them leaves its role unknown too. The element is kept as a landmark with an
undetermined name rather than being demoted to no landmark at all, because "this is not a landmark"
would be a positive claim about a region the evidence cannot see. An element that is *definitely*
unnamed is still demoted, so the rule keeps biting.

## Headings

`h1`–`h6`, and any element with `role="heading"`. `aria-level` overrides the tag's level; a
`role="heading"` with no `aria-level` is level 2, which is what ARIA specifies.

### A hierarchy claim is not made across a region this file does not contain

The heading list these checks run over is the part of the page that was **read**. Every heading
inside a serialised shadow root, an iframe, an SVG `foreignObject` or a subtree whose `role` this
tool does not recognise was dropped while building it — and a gap in that list may be a gap in the
evidence rather than a gap in the page. Evidence dropped while building an index does not make a
comparison over the index clean; it makes it incomplete. So:

| Claim | Withheld when |
| --- | --- |
| `heading-level-skipped` | An unread region lies **between** the two headings in document order. |
| `first-heading-not-top-level` | An unread region lies **before** the first heading that was read. |
| `no-heading` | Any region was unread. |
| `no-main-landmark` | Any region was unread. |
| `multiple-top-level-headings` | Never. It is a fact about the headings that *are* here, and no absent markup can make two level 1 headings into one. |
| `heading-empty` | The heading's own name could not be resolved (see above). |

Withheld is not silent: the unread region has its own finding, the run is `incomplete` and the exit
code is `2`. What is withheld is the verdict, not the evidence. A level jump with nothing unread
between the two headings is still reported, and `summary.unreadRegions` counts the regions this
snapshot does not contain.

## Rule catalog

Severity comes from one frozen table in `src/rules.mjs`. An unknown rule id throws. This catalog is
asserted against that table in both directions, and every rule is additionally driven through the
real CLI so the observable exit code is what pins its severity.

"Incomplete" means the rule forces `status: "incomplete"` and exit `2`, whatever its severity.

| Rule | Severity | Incomplete | Meaning |
| --- | --- | --- | --- |
| `depth-exceeded` | error | yes | The markup nests deeper than the configured limit. |
| `duplicate-attribute` | info | no | One attribute given twice; the first value was used. |
| `duplicate-id` | warning | yes | More than one element carries an id, so references to it are ambiguous. |
| `duplicate-landmark-name` | warning | no | Two landmarks of one role share an accessible name. |
| `duplicate-unique-landmark` | error | no | More than one `banner`, `contentinfo` or `main`. |
| `duplicate-unlabelled-landmark` | error | no | Two or more landmarks of one repeatable role with no accessible name. |
| `empty-snapshot` | error | yes | No element was read, so the run has no evidence to pass on. |
| `entity-unsupported` | warning | yes | A named character reference outside the decoded set. |
| `file-too-large` | error | yes | A snapshot is over the configured byte limit and was not read. |
| `first-heading-not-top-level` | warning | no | The first heading is not level 1. |
| `foreign-content-ignored` | info | no | An SVG or MathML subtree was not walked into. |
| `foreign-content-skipped` | warning | yes | An SVG subtree holds a `foreignObject` that was not read. |
| `heading-empty` | error | no | A heading has no accessible name. |
| `heading-level-skipped` | error | no | A heading level jumps by more than one. |
| `html-construct-unsupported` | error | yes | Markup outside the declared subset. |
| `iframe-content-unavailable` | warning | yes | An iframe's content is not in this file. |
| `implied-end-tag` | info | no | An optional end tag was implied. Ordinary HTML. |
| `landmark-role-redundant` | info | no | A `role` attribute repeats the element's implicit role. |
| `mismatched-end-tag` | warning | yes | An end tag closes across an element whose end tag is not optional. |
| `multiple-top-level-headings` | warning | no | More than one level 1 heading. |
| `name-reference-unresolved` | warning | yes | An `aria-labelledby` reference this document cannot resolve. |
| `no-heading` | warning | no | The document declares no heading. |
| `no-main-landmark` | warning | no | The document declares no `main` landmark. |
| `role-unknown` | warning | yes | A `role` value the tool does not recognise. |
| `shadow-root-not-traversed` | warning | yes | A serialised shadow root, not traversed. |
| `shadow-root-unknown` | warning | yes | A custom element that may hold a shadow root this file does not contain. |
| `snapshot-undecodable` | error | yes | A snapshot is not valid UTF-8. |
| `snapshot-unreadable` | error | yes | A snapshot could not be opened. |
| `stray-end-tag` | warning | yes | An end tag matching nothing that is open. |
| `template-content-skipped` | info | no | A `<template>` element's content is inert and was skipped. |
| `too-many-elements` | error | yes | More elements than the configured limit. |
| `too-many-findings` | error | yes | More findings than the configured limit; the rest were dropped. |
| `unclosed-element` | warning | yes | An element is still open at the end of the input. |

## Limits

Every limit is enforced, reported when it is hit, and covered by a test.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxFileBytes` | `--max-file-bytes` | 8388608 |
| `maxElements` | `--max-elements` | 200000 |
| `maxDepth` | `--max-depth` | 256 |
| `maxFindings` | `--max-findings` | 5000 |

An unknown limit name is rejected.

## Writing a file

`--out` writes the JSON report. It is **not confined to a root**, because this tool has no root to
confine it to: the destination is whatever path the caller names, and a symbolically linked parent
directory on the way there is followed, exactly as it is for `cp` and for shell redirection.
Documenting a confinement the code does not perform would be worse than saying nothing, because it
reads as coverage.

Two things are refused, and each has its own check because neither catches the other:

| Refused | Why the obvious guard misses it |
| --- | --- |
| A destination that is itself a symbolic link | `realpath` **resolves** the link, and resolving is the dangerous act. It is refused on sight with `lstat`, before anything is opened. |
| A destination that is the same file as a snapshot | A hard link has no target to resolve and shares no path with the file it duplicates, so `realpath` and string comparison both call it a different file. Only device plus inode sees that it is the same file. |

The input set handed to that check is **every snapshot path the run resolved**, recorded before any
of them is read, not only the ones that were opened successfully.

A refused destination is a configuration error: exit 2, **empty stdout**, and nothing written.

## Ordering

Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then `message`, all by
**UTF-16 code unit**. `localeCompare` and `Intl.Collator` are never used: collation depends on the
ICU data a Node build ships, and it reorders `README.html` and `assets.html` relative to each
other. Documents are reported in the order they were given on the command line, and each outline is
in document order.

`location.pointer` is a documented field path: `/tag[n]` segments, where `n` is the 1-based position
of that element among its siblings carrying the same tag.

The report carries no timestamp, reads no clock and consults no locale, so two runs over one set of
snapshots produce byte-identical stdout.
