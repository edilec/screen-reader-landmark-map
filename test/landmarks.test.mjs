import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mapSnapshots } from '../src/index.mjs'

/**
 * Duplicate unlabelled landmarks, located.
 *
 * Two navigation regions with no accessible name appear in a screen reader's
 * landmark list as two identical entries, and nothing in either says which is
 * the site navigation and which is the footer links. That is the defect this
 * tool exists to locate, and locating it means naming BOTH of them by their
 * position, not counting them.
 *
 * The other half is the false positive. Two labelled navigation regions are a
 * page working as intended, and reporting them would make the tool useless, so
 * every rule here is pinned in both directions.
 */

async function mapDocument(t, html, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'landmark-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  await writeFile(file, html)
  return mapSnapshots({ snapshots: [file], ...options })
}

const ruleIds = (report, ruleId) =>
  report.findings.filter((finding) => finding.ruleId === ruleId).map((f) => f.location.pointer)

test('two unlabelled navigation regions are located, both of them', async (t) => {
  const report = await mapDocument(
    t,
    '<body><header><nav><a href="/">Home</a></nav></header>'
      + '<main><h1>Catalogue</h1></main>'
      + '<nav><a href="/terms/">Terms</a></nav></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [
    '/body[1]/header[1]/nav[1]',
    '/body[1]/nav[1]',
  ])
  assert.equal(report.status, 'fail')
})

test('two LABELLED navigation regions are not reported', async (t) => {
  const report = await mapDocument(
    t,
    '<body><header><nav aria-label="Primary"><a href="/">Home</a></nav></header>'
      + '<main><h1>Catalogue</h1></main>'
      + '<nav aria-label="Legal"><a href="/terms/">Terms</a></nav></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.equal(report.status, 'pass')
})

test('an aria-hidden element referenced by aria-labelledby still supplies the name', async (t) => {
  // Step 2A of the accessible name computation: a node referenced DIRECTLY by
  // aria-labelledby contributes its text even when it carries
  // aria-hidden="true". Treating it as contributing nothing reported TWO
  // error-severity duplicate-unlabelled-landmark findings, exit 1, for a page
  // where one of the two navigation regions is named "Primary" -- and the
  // sister tool aria-name-explainer answered the same construct correctly, so
  // the two tools disagreed on one spec rule.
  const report = await mapDocument(
    t,
    '<body><span id="l" aria-hidden="true">Primary</span>'
      + '<nav aria-labelledby="l"><a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.equal(report.status, 'pass')
  const nav = report.documents[0].outline.find((entry) => entry.role === 'navigation')
  assert.equal(nav.name, 'Primary')
})

test('the exception is the referenced node itself, not an aria-hidden child of it', async (t) => {
  // The mirror: hidden text INSIDE the referenced element is still removed,
  // so widening the exception one level too far would fail here.
  const report = await mapDocument(
    t,
    '<body><span id="l">Primary<span aria-hidden="true"> (draft)</span></span>'
      + '<nav aria-labelledby="l"><a href="/">Home</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  const nav = report.documents[0].outline.find((entry) => entry.role === 'navigation')
  assert.equal(nav.name, 'Primary')
})

test('an aria-labelledby that resolves to empty text falls through to aria-label', async (t) => {
  // Step 2B returns the accumulated text only if it is NOT EMPTY. Returning
  // an empty name here reported a nav carrying aria-label="Primary" as
  // unlabelled, so two navigation regions came back as a duplicate pair at
  // error severity on correct markup.
  const report = await mapDocument(
    t,
    '<body><span id="blank"></span>'
      + '<nav aria-labelledby="blank" aria-label="Primary"><a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.equal(report.status, 'pass')
  const nav = report.documents[0].outline.find((entry) => entry.role === 'navigation')
  assert.equal(nav.name, 'Primary')
})

test('falling through does not invent a name: with nothing below it, the rule still bites', async (t) => {
  // The mirror of the two tests above. Honesty about an empty reference must
  // not become a refusal to report the defect: this nav really is unnamed.
  const report = await mapDocument(
    t,
    '<body><span id="blank"></span>'
      + '<nav aria-labelledby="blank"><a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [
    '/body[1]/nav[1]',
    '/body[1]/nav[2]',
  ])
  assert.equal(report.status, 'fail')
})

test('a landmark labelled by a heading that holds only an image is labelled', async (t) => {
  // The name-from-content rule, reached through a reference: step 2F computes
  // each descendant's accessible name, and an `img` gets its name from `alt`.
  // Concatenating raw text found nothing in the void element, so this nav came
  // back unnamed and the page produced TWO error-severity
  // duplicate-unlabelled-landmark findings, exit 1, on correct markup.
  const report = await mapDocument(
    t,
    '<body><nav aria-labelledby="nt"><h2 id="nt"><img src="/p.svg" alt="Products"></h2>'
      + '<a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.deepEqual(ruleIds(report, 'heading-empty'), [])
  assert.equal(report.status, 'pass')
  const nav = report.documents[0].outline.find((entry) => entry.role === 'navigation')
  assert.equal(nav.name, 'Products')
})

test('landmarks inside an aria-hidden subtree are not in the map', async (t) => {
  // Neither of these navigation regions is in the accessibility tree, so
  // "two navigation landmarks carry no accessible name" is a claim about
  // regions nobody can reach. It was reported twice at error severity, exit
  // 1, on markup that is right.
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1></main>'
      + '<div aria-hidden="true"><nav><a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav></div></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.equal(report.status, 'pass')
  assert.deepEqual(
    report.documents[0].outline.map((entry) => entry.pointer),
    ['/body[1]/main[1]', '/body[1]/main[1]/h1[1]'],
  )

  // The mirror: drop the aria-hidden and the same two regions are reported,
  // so this is a rule about exposure and not a hole in the duplicate check.
  const exposed = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1></main>'
      + '<div><nav><a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav></div></body>',
  )
  assert.deepEqual(ruleIds(exposed, 'duplicate-unlabelled-landmark'), [
    '/body[1]/div[1]/nav[1]',
    '/body[1]/div[1]/nav[2]',
  ])
})

test('only aria-hidden="true" hides; aria-hidden="false" is the same as absent', async (t) => {
  // ARIA defines `aria-hidden` as a tristate whose "false" value means the
  // element IS exposed. Testing for the attribute's presence instead of its
  // value would quietly drop an exposed region out of the map, which is the
  // mirror hole of mapping a hidden one -- and a sweep that deleted the value
  // comparison left every other test green.
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1></main>'
      + '<div aria-hidden="false"><nav><a href="/">Home</a></nav>'
      + '<nav><a href="/terms/">Terms</a></nav></div></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [
    '/body[1]/div[1]/nav[1]',
    '/body[1]/div[1]/nav[2]',
  ])
  assert.equal(report.status, 'fail')
})

test('one unlabelled navigation region on its own is not reported', async (t) => {
  const report = await mapDocument(
    t,
    '<body><nav><a href="/">Home</a></nav><main><h1>Catalogue</h1></main></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.equal(report.status, 'pass')
})

test('two navigation regions sharing one name are reported separately, as a warning', async (t) => {
  const report = await mapDocument(
    t,
    '<body><nav aria-label="Menu"><a href="/">Home</a></nav>'
      + '<main><h1>Catalogue</h1></main>'
      + '<nav aria-label="Menu"><a href="/terms/">Terms</a></nav></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-landmark-name'), ['/body[1]/nav[1]', '/body[1]/nav[2]'])
  assert.equal(report.status, 'pass')
})

test('an unresolved landmark name leaves the comparison INCOMPLETE, never clean', async (t) => {
  // One navigation region is definitely unlabelled. The other names an id this
  // document does not contain, so it MIGHT be labelled. Dropping it from the
  // comparison and then asserting the remaining one is fine is exactly the
  // defect the contract calls "unknown reported as a pass on the other side of
  // a comparison". The comparison is not made, and the run does not pass.
  const report = await mapDocument(
    t,
    '<body><nav><a href="/">Home</a></nav>'
      + '<main><h1>Catalogue</h1></main>'
      + '<nav aria-labelledby="label-that-is-not-here"><a href="/terms/">Terms</a></nav></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unlabelled-landmark'), [])
  assert.equal(report.status, 'incomplete')
  const unresolved = report.findings.find((f) => f.ruleId === 'name-reference-unresolved')
  assert.ok(unresolved !== undefined)
  assert.match(unresolved.message, /duplicate-landmark comparison for navigation/)
})

test('a duplicated id makes every reference to it ambiguous, not merely noisy', async (t) => {
  const report = await mapDocument(
    t,
    '<body><h2 id="shared">One</h2><h2 id="shared">Two</h2>'
      + '<nav aria-labelledby="shared"><a href="/">Home</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((f) => f.ruleId === 'duplicate-id'))
  assert.ok(report.findings.some((f) => f.ruleId === 'name-reference-unresolved'))
})

test('more than one main landmark is an error', async (t) => {
  const report = await mapDocument(
    t,
    '<body><main><h1>One</h1></main><main><h2>Two</h2></main></body>',
  )
  assert.deepEqual(ruleIds(report, 'duplicate-unique-landmark'), ['/body[1]/main[2]'])
  assert.equal(report.status, 'fail')
})

test('a header inside sectioning content is not a banner', async (t) => {
  const report = await mapDocument(
    t,
    '<body><header><nav aria-label="Primary"><a href="/">Home</a></nav></header>'
      + '<main><h1>Catalogue</h1><article><header><h2>Item</h2></header></article></main></body>',
  )
  const banners = report.documents[0].outline.filter((entry) => entry.role === 'banner')
  assert.deepEqual(
    banners.map((entry) => entry.pointer),
    ['/body[1]/header[1]'],
  )
})

test('a section is a region only when it has an accessible name', async (t) => {
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1>'
      + '<section aria-label="Trays"><h2>Trays</h2></section>'
      + '<section><h2>Ladders</h2></section></main></body>',
  )
  const regions = report.documents[0].outline.filter((entry) => entry.role === 'region')
  assert.deepEqual(
    regions.map((entry) => [entry.pointer, entry.name]),
    [['/body[1]/main[1]/section[1]', 'Trays']],
  )
})

test('a form is a form landmark only when it has an accessible name', async (t) => {
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1>'
      + '<form aria-label="Search"><input type="search"></form>'
      + '<form><input type="text"></form></main></body>',
  )
  const forms = report.documents[0].outline.filter((entry) => entry.role === 'form')
  assert.deepEqual(
    forms.map((entry) => entry.pointer),
    ['/body[1]/main[1]/form[1]'],
  )
})

test('an explicit role overrides the implicit one, and a redundant one is noted', async (t) => {
  const report = await mapDocument(
    t,
    '<body><nav role="navigation" aria-label="Primary"><a href="/">Home</a></nav>'
      + '<section role="search" aria-label="Find"><input type="search"></section>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  const roles = report.documents[0].outline
    .filter((entry) => entry.kind === 'landmark')
    .map((entry) => entry.role)
  assert.deepEqual(roles, ['navigation', 'search', 'main'])
  assert.deepEqual(ruleIds(report, 'landmark-role-redundant'), ['/body[1]/nav[1]'])
})

test('the outline nests landmarks by their position in the markup', async (t) => {
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1>'
      + '<section aria-label="Trays"><h2>Trays</h2>'
      + '<nav aria-label="Tray sizes"><a href="#a">50mm</a></nav>'
      + '</section></main></body>',
  )
  assert.deepEqual(
    report.documents[0].outline.map((entry) => [entry.depth, entry.role ?? `h${entry.level}`]),
    [
      [0, 'main'],
      [1, 'h1'],
      [1, 'region'],
      [2, 'h2'],
      [2, 'navigation'],
    ],
  )
})

test('a section whose name reference is unresolved is NOT quietly demoted to no landmark', async (t) => {
  // `section` is a region only when it is named. An unresolved reference means
  // this document cannot say whether it is named, so it cannot say whether the
  // element is a landmark either. Answering "not a landmark" would be a
  // positive claim about a region the evidence cannot see.
  const report = await mapDocument(
    t,
    '<body><section aria-labelledby="not-in-this-document"><p>x</p></section>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report, 'name-reference-unresolved'), ['/body[1]/section[1]'])
  const region = report.documents[0].outline.find((entry) => entry.role === 'region')
  assert.equal(region.pointer, '/body[1]/section[1]')
  assert.equal(region.name, null)
})

test('a section that is definitely unnamed IS demoted, so the rule still bites', async (t) => {
  const report = await mapDocument(
    t,
    '<body><section><p>x</p></section><main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(report.status, 'pass')
  assert.deepEqual(
    report.documents[0].outline.filter((entry) => entry.role === 'region'),
    [],
  )
})

test('a form whose name reference is unresolved is not demoted either', async (t) => {
  const report = await mapDocument(
    t,
    '<body><form aria-labelledby="gone"><input type="text"></form>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(report.status, 'incomplete')
  const forms = report.documents[0].outline.filter((entry) => entry.role === 'form')
  assert.deepEqual(forms.map((entry) => entry.name), [null])
})

test('a nested aside whose name reference is unresolved is not demoted either', async (t) => {
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1>'
      + '<article><aside aria-labelledby="gone"><p>x</p></aside></article></main></body>',
  )
  assert.equal(report.status, 'incomplete')
  const asides = report.documents[0].outline.filter((entry) => entry.role === 'complementary')
  assert.deepEqual(asides.map((entry) => entry.name), [null])
})
