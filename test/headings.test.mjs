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
