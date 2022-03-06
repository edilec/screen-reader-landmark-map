import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mapSnapshots } from '../src/index.mjs'

/**
 * Skipped hierarchy, located.
 *
 * A screen reader user moves through a document by heading level. A jump from
 * level 1 to level 3 leaves them unable to tell what the deeper heading
 * belongs to, and the useful report says WHICH heading and WHICH two levels,
 * not that the document "has heading problems".
 *
 * Each rule is pinned in both directions, because a hierarchy checker that
 * reports every document is as useless as one that reports none.
 */

async function mapDocument(t, html) {
  const directory = await mkdtemp(join(tmpdir(), 'heading-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  await writeFile(file, html)
  return mapSnapshots({ snapshots: [file] })
}

const found = (report, ruleId) =>
  report.findings.filter((finding) => finding.ruleId === ruleId)

test('a skipped level is located at the heading that skipped it', async (t) => {
  const report = await mapDocument(
    t,
    '<main><h1>Catalogue</h1><h2>Trays</h2><h4>Perforated</h4></main>',
  )
  const skipped = found(report, 'heading-level-skipped')
  assert.deepEqual(
    skipped.map((finding) => finding.location.pointer),
    ['/main[1]/h4[1]'],
  )
  assert.match(skipped[0].message, /level 2 is followed by level 4/)
  assert.equal(report.status, 'fail')
})

test('a hierarchy that never skips is not reported', async (t) => {
  const report = await mapDocument(
    t,
    '<main><h1>Catalogue</h1><h2>Trays</h2><h3>Perforated</h3><h2>Ladders</h2></main>',
  )
  assert.deepEqual(found(report, 'heading-level-skipped'), [])
  assert.equal(report.status, 'pass')
})

test('coming back UP several levels is not a skip', async (t) => {
  const report = await mapDocument(
    t,
    '<main><h1>Catalogue</h1><h2>Trays</h2><h3>Perforated</h3><h4>50mm</h4><h2>Ladders</h2></main>',
  )
  assert.deepEqual(found(report, 'heading-level-skipped'), [])
})

test('every skip in a document is located, not only the first', async (t) => {
  const report = await mapDocument(
    t,
    '<main><h1>A</h1><h3>B</h3><h4>C</h4><h6>D</h6></main>',
  )
  assert.deepEqual(
    found(report, 'heading-level-skipped').map((finding) => finding.location.pointer),
    ['/main[1]/h3[1]', '/main[1]/h6[1]'],
  )
})

test('aria-level overrides the tag, in both directions', async (t) => {
  // The markup reads h1 then h2, which would pass. The LEVELS read 1 then 3.
  const skipping = await mapDocument(
    t,
    '<main><h1>A</h1><h2 aria-level="3">B</h2></main>',
  )
  assert.deepEqual(
    found(skipping, 'heading-level-skipped').map((finding) => finding.location.pointer),
    ['/main[1]/h2[1]'],
  )

  // And the reverse: the markup reads h1 then h4, which would fail, but the
  // levels read 1 then 2.
  const fine = await mapDocument(t, '<main><h1>A</h1><h4 aria-level="2">B</h4></main>')
  assert.deepEqual(found(fine, 'heading-level-skipped'), [])
})

test('an element with role=heading and no aria-level is level 2', async (t) => {
  const report = await mapDocument(
    t,
    '<main><h1>A</h1><div role="heading">B</div><h3>C</h3></main>',
  )
  assert.deepEqual(found(report, 'heading-level-skipped'), [])
  assert.deepEqual(
    report.documents[0].outline
      .filter((entry) => entry.kind === 'heading')
      .map((entry) => [entry.level, entry.name]),
    [
      [1, 'A'],
      [2, 'B'],
      [3, 'C'],
    ],
  )
})

test('a heading with no text is an error, and one with text is not', async (t) => {
  const empty = await mapDocument(t, '<main><h1>A</h1><h2></h2></main>')
  assert.deepEqual(
    found(empty, 'heading-empty').map((finding) => finding.location.pointer),
    ['/main[1]/h2[1]'],
  )
  assert.equal(empty.status, 'fail')

  const filled = await mapDocument(t, '<main><h1>A</h1><h2>B</h2></main>')
  assert.deepEqual(found(filled, 'heading-empty'), [])
})

test('an aria-hidden subtree contributes nothing to a heading name', async (t) => {
  const report = await mapDocument(
    t,
    '<main><h1>Catalogue<span aria-hidden="true"> (draft)</span></h1></main>',
  )
  assert.equal(report.documents[0].outline[1].name, 'Catalogue')
})

test('a heading whose aria-labelledby resolves to nothing keeps its own text', async (t) => {
  // Step 2B returns the accumulated text only if it is NOT EMPTY, so the
  // computation falls through to the heading's contents. Short-circuiting
  // here reported a heading reading "Deployment handbook" as having no
  // accessible name, at error severity, and exited 1.
  const report = await mapDocument(
    t,
    '<main><h1 aria-labelledby="blank">Deployment handbook</h1><span id="blank"></span></main>',
  )
  assert.deepEqual(found(report, 'heading-empty'), [])
  assert.equal(report.status, 'pass')
  assert.equal(report.documents[0].outline[1].name, 'Deployment handbook')
})

test('a heading with no text of its own and an empty reference IS empty', async (t) => {
  // The mirror: falling through must not invent a name.
  const report = await mapDocument(
    t,
    '<main><h1 aria-labelledby="blank"></h1><span id="blank"></span></main>',
  )
  assert.deepEqual(
    found(report, 'heading-empty').map((finding) => finding.location.pointer),
    ['/main[1]/h1[1]'],
  )
  assert.equal(report.status, 'fail')
})

test('a heading named by an aria-hidden element is named, not empty', async (t) => {
  // Step 2A again, on the heading side: a directly referenced node
  // contributes even when it is hidden.
  const report = await mapDocument(
    t,
    '<main><h1 aria-labelledby="l"></h1><span id="l" aria-hidden="true">Catalogue</span></main>',
  )
  assert.deepEqual(found(report, 'heading-empty'), [])
  assert.equal(report.documents[0].outline[1].name, 'Catalogue')
  assert.equal(report.status, 'pass')
})

test('correct markup is not reported as a defect: a heading named by an image alt', async (t) => {
  // Step 2F does not concatenate raw text: for each descendant it computes
  // THAT node's accessible name, and HTML-AAM gives an `img` its name from
  // `alt`. Concatenating raw text instead found nothing at all in a void
  // element, so a logo in a heading came back as `heading-empty` at error
  // severity and the run exited 1 on markup that was already right. The
  // sister tool `aria-name-explainer` answers "Acme" for the same construct.
  const report = await mapDocument(t, '<main><h1><img src="/logo.svg" alt="Acme"></h1></main>')
  assert.deepEqual(found(report, 'heading-empty'), [])
  assert.equal(report.status, 'pass')
  assert.equal(report.documents[0].outline[1].name, 'Acme')

  const mixed = await mapDocument(
    t,
    '<main><h1><img src="/logo.svg" alt="Acme"> Handbook</h1></main>',
  )
  assert.equal(mixed.documents[0].outline[1].name, 'Acme Handbook')
})

test('an image with no alt contributes nothing, so the rule still bites', async (t) => {
  // The mirror: reading `alt` is not the same as assuming every image names
  // its heading. An `img` with no `alt` has no accessible name, and a heading
  // holding only that one is still empty.
  const report = await mapDocument(t, '<main><h1><img src="/logo.svg"></h1></main>')
  assert.deepEqual(
    found(report, 'heading-empty').map((finding) => finding.location.pointer),
    ['/main[1]/h1[1]'],
  )
  assert.equal(report.status, 'fail')

  const decorative = await mapDocument(t, '<main><h1><img src="/rule.svg" alt=""></h1></main>')
  assert.deepEqual(
    found(decorative, 'heading-empty').map((finding) => finding.location.pointer),
    ['/main[1]/h1[1]'],
  )
})

test("a descendant contributes its own name, not the text underneath it", async (t) => {
  // Each of these is a step of the computation applied to a DESCENDANT, which
  // is what step 2F asks for. Reading the raw text instead reported the wrong
  // name in every one, and an empty one in the last two.
  const labelled = await mapDocument(
    t,
    '<main><h1><span aria-label="Acme">A</span></h1></main>',
  )
  assert.equal(labelled.documents[0].outline[1].name, 'Acme')

  const referenced = await mapDocument(
    t,
    '<main><h1><span aria-labelledby="src">A</span></h1><span id="src">Acme</span></main>',
  )
  assert.equal(referenced.documents[0].outline[1].name, 'Acme')

  const submit = await mapDocument(
    t,
    '<main><h1><input type="submit" value="Publish"></h1></main>',
  )
  assert.deepEqual(found(submit, 'heading-empty'), [])
  assert.equal(submit.documents[0].outline[1].name, 'Publish')

  const chosen = await mapDocument(
    t,
    '<main><h1><select><option>Draft</option><option selected>Published</option></select></h1></main>',
  )
  assert.equal(chosen.documents[0].outline[1].name, 'Published')
})

test('a reference already being resolved is not followed a second time', async (t) => {
  // The computation does not re-enter `aria-labelledby` from inside a
  // reference it is already resolving. The option here carries one, and the
  // select sits inside the referenced element, so the flag has to reach the
  // embedded-control walk as well as the ordinary one: the option contributes
  // its own text, not the text the reference points at.
  const report = await mapDocument(
    t,
    '<body><main><h1 aria-labelledby="holder"></h1>'
      + '<span id="holder"><select><option selected aria-labelledby="other">Chosen</option>'
      + '</select></span><span id="other">Elsewhere</span></main></body>',
  )
  assert.equal(report.documents[0].outline[1].name, 'Chosen')
  assert.equal(report.status, 'pass')
})

test('a reference reached from inside the contents is unresolved, not empty', async (t) => {
  // Unknown is never a pass, and it is never a positive claim either: the
  // text that happened to accumulate around an id this document does not
  // contain is not the heading's name.
  const report = await mapDocument(
    t,
    '<main><h1>Part <span aria-labelledby="not-here">one</span></h1></main>',
  )
  assert.deepEqual(found(report, 'heading-empty'), [])
  assert.ok(report.findings.some((finding) => finding.ruleId === 'name-reference-unresolved'))
  assert.equal(report.status, 'incomplete')
  assert.equal(report.documents[0].outline[1].name, null)
})

test('a heading whose name reference is unresolved is never called empty', async (t) => {
  // "This heading is empty" would be a claim about text the document does not
  // contain. The level is still known, so it stays in the hierarchy check.
  const report = await mapDocument(
    t,
    '<main><h1>A</h1><h2 aria-labelledby="not-here"></h2><h4>C</h4></main>',
  )
  assert.deepEqual(found(report, 'heading-empty'), [])
  assert.ok(report.findings.some((finding) => finding.ruleId === 'name-reference-unresolved'))
  assert.deepEqual(
    found(report, 'heading-level-skipped').map((finding) => finding.location.pointer),
    ['/main[1]/h4[1]'],
  )
  assert.equal(report.status, 'incomplete')
  assert.equal(report.documents[0].outline[2].name, null)
})

test('an aria-hidden heading is not in the hierarchy at all', async (t) => {
  // `aria-hidden="true"` removes the element and its subtree from the
  // accessibility tree, so there is no heading here to be empty. Mapping it
  // anyway reported a decorative heading as `heading-empty` at error severity
  // and exited 1 on markup where nothing in it is exposed to anyone.
  const report = await mapDocument(
    t,
    '<main><h1>Catalogue</h1><h2 aria-hidden="true">Decorative</h2></main>',
  )
  assert.deepEqual(found(report, 'heading-empty'), [])
  assert.equal(report.status, 'pass')
  assert.deepEqual(
    report.documents[0].outline
      .filter((entry) => entry.kind === 'heading')
      .map((entry) => [entry.level, entry.name, entry.pointer]),
    [[1, 'Catalogue', '/main[1]/h1[1]']],
  )

  // The mirror: the same heading without aria-hidden is still reported, so
  // the rule keeps biting.
  const exposed = await mapDocument(t, '<main><h1>Catalogue</h1><h2></h2></main>')
  assert.deepEqual(
    found(exposed, 'heading-empty').map((finding) => finding.location.pointer),
    ['/main[1]/h2[1]'],
  )
})

test('an aria-hidden region is not an unread one, so the claims still hold', async (t) => {
  // An unread region withholds a hierarchy claim because the markup might be
  // there. This markup IS here and it says the subtree is not exposed, so the
  // level jump over it is real and is reported.
  const report = await mapDocument(
    t,
    '<main><h1>A</h1><div aria-hidden="true"><h2>B</h2></div><h3>C</h3></main>',
  )
  assert.deepEqual(
    found(report, 'heading-level-skipped').map((finding) => finding.location.pointer),
    ['/main[1]/h3[1]'],
  )
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.unreadRegions, 0)
})

test('a level jump ACROSS a region this file does not contain is not reported', async (t) => {
  // The heading list this check runs over is the part of the page that was
  // READ: every heading inside a serialised shadow root was dropped while
  // building it. The h2 that makes this hierarchy legal is in the shadow
  // root, so "level 1 is followed by level 3" is a claim about markup the
  // file does not contain. The region itself is reported and the run is
  // incomplete, so nothing is passed over in silence.
  const report = await mapDocument(
    t,
    '<main><h1>One</h1><my-el><template shadowrootmode="open"><h2>Two</h2></template></my-el>'
      + '<h3>Three</h3></main>',
  )
  assert.deepEqual(found(report, 'heading-level-skipped'), [])
  assert.ok(report.findings.some((finding) => finding.ruleId === 'shadow-root-not-traversed'))
  assert.equal(report.status, 'incomplete')
})

test('the same jump with nothing unread between the two headings IS reported', async (t) => {
  // The mirror, and the one that keeps the rule biting: the unread region is
  // AFTER both headings here, so no markup inside it could sit between them.
  // A guard written as "any unread region anywhere" would silence this.
  const report = await mapDocument(
    t,
    '<main><h1>One</h1><h3>Three</h3>'
      + '<my-el><template shadowrootmode="open"><p>later</p></template></my-el></main>',
  )
  assert.deepEqual(
    found(report, 'heading-level-skipped').map((finding) => finding.location.pointer),
    ['/main[1]/h3[1]'],
  )
  assert.equal(report.status, 'incomplete')
})

test('an unread region also withdraws the first-heading and no-heading claims', async (t) => {
  // Both are claims about the whole document rather than about a pair, so any
  // unread region withdraws them.
  const below = await mapDocument(
    t,
    '<main><iframe src="/embed" title="Embed"></iframe><h2>Two</h2></main>',
  )
  assert.deepEqual(found(below, 'first-heading-not-top-level'), [])

  const none = await mapDocument(t, '<main><iframe src="/embed" title="Embed"></iframe></main>')
  assert.deepEqual(found(none, 'no-heading'), [])
  assert.equal(none.status, 'incomplete')

  // The mirrors: the same documents with nothing unread in them.
  const readable = await mapDocument(t, '<main><h2>Two</h2></main>')
  assert.equal(found(readable, 'first-heading-not-top-level').length, 1)
  const empty = await mapDocument(t, '<main><p>Prose only.</p></main>')
  assert.equal(found(empty, 'no-heading').length, 1)
})

test('a subtree whose role is unknown counts as unread for the hierarchy', async (t) => {
  // role-unknown returns before the subtree is walked, so its headings are
  // dropped from the list exactly as a shadow root's are.
  const report = await mapDocument(
    t,
    '<main><h1>One</h1><div role="fancypanel"><h2>Two</h2></div><h3>Three</h3></main>',
  )
  assert.deepEqual(found(report, 'heading-level-skipped'), [])
  assert.ok(report.findings.some((finding) => finding.ruleId === 'role-unknown'))
  assert.equal(report.status, 'incomplete')
})

test('a first heading below level 1 is reported, and level 1 is not', async (t) => {
  const deep = await mapDocument(t, '<main><h2>A</h2><h3>B</h3></main>')
  assert.equal(found(deep, 'first-heading-not-top-level').length, 1)

  const top = await mapDocument(t, '<main><h1>A</h1><h2>B</h2></main>')
  assert.deepEqual(found(top, 'first-heading-not-top-level'), [])
})

test('more than one level 1 heading is reported, once per extra heading', async (t) => {
  const report = await mapDocument(t, '<main><h1>A</h1><h1>B</h1><h1>C</h1></main>')
  assert.deepEqual(
    found(report, 'multiple-top-level-headings').map((finding) => finding.location.pointer),
    ['/main[1]/h1[2]', '/main[1]/h1[3]'],
  )
})

test('a document with no headings at all says so', async (t) => {
  const report = await mapDocument(t, '<main><p>Prose only.</p></main>')
  assert.equal(found(report, 'no-heading').length, 1)
  assert.deepEqual(found(report, 'first-heading-not-top-level'), [])
})

test('headings are listed under the landmark that contains them', async (t) => {
  const report = await mapDocument(
    t,
    '<body><header><h2>Site</h2></header><main><h1>Catalogue</h1></main></body>',
  )
  assert.deepEqual(
    report.documents[0].outline.map((entry) => [entry.depth, entry.role ?? `h${entry.level}`]),
    [
      [0, 'banner'],
      [1, 'h2'],
      [0, 'main'],
      [1, 'h1'],
    ],
  )
})
