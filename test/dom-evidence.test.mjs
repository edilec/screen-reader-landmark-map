import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { EVIDENCE_NOTE } from '../src/index.mjs'

/**
 * Results stay DOM-based evidence, and that is enforced as BEHAVIOUR.
 *
 * Three things enforce it, and each is asserted here:
 *
 *   1. A region of the page that is not in the file makes the run incomplete
 *      and names the region. The tool does not narrow what it checked and
 *      report a clean map of the part it could see.
 *   2. A landmark whose name could not be resolved is left OUT of the
 *      duplicate comparison, and the run is incomplete, with the finding
 *      saying which comparison could not be completed. Dropping the unreadable
 *      side and then asserting the rest are fine is the exact defect this
 *      rule exists to prevent.
 *   3. Nothing in the report describes speech or announcement order. The
 *      outline carries `depth` and `pointer`, which are positions in the
 *      markup, and a test walks the whole report for any field that would
 *      claim otherwise.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')
const CLEAN = '<body><main><h1>Catalogue</h1></main></body>'

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function report(t, html, extra = []) {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-evidence-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  await writeFile(file, html)
  const run = await runCli(['--snapshot', file, ...extra])
  return { run, parsed: JSON.parse(run.stdout) }
}

const UNREAD = {
  'a serialised shadow root': [
    '<main><h1>A</h1><x-p><template shadowrootmode="open"><nav>Links</nav></template></x-p></main>',
    'shadow-root-not-traversed',
  ],
  'a custom element that may hold one': [
    '<main><h1>A</h1><x-p>content</x-p></main>',
    'shadow-root-unknown',
  ],
  "an iframe's content": [
    '<main><h1>A</h1><iframe src="/x" title="Usage"></iframe></main>',
    'iframe-content-unavailable',
  ],
  'HTML inside an SVG foreignObject': [
    '<main><h1>A</h1><svg><foreignObject><nav>Links</nav></foreignObject></svg></main>',
    'foreign-content-skipped',
  ],
  'markup outside the declared subset': [
    '<main><h1>A</h1><div/></main>',
    'html-construct-unsupported',
  ],
}

for (const [name, [html, ruleId]] of Object.entries(UNREAD)) {
  test(`${name} makes the run incomplete and is named, never passed over`, async (t) => {
    const { run, parsed } = await report(t, html)
    assert.equal(parsed.status, 'incomplete')
    assert.equal(run.code, 2)
    assert.ok(
      parsed.findings.some((finding) => finding.ruleId === ruleId),
      `expected ${ruleId}, got ${parsed.findings.map((f) => f.ruleId).join(', ')}`,
    )
  })
}

test('the count of regions the snapshot does not contain is reported, not hidden', async (t) => {
  const { parsed } = await report(
    t,
    '<main><h1>A</h1><x-p></x-p><iframe src="/x" title="U"></iframe></main>',
  )
  assert.equal(parsed.summary.unreadRegions, 2)
  assert.equal(parsed.status, 'incomplete')
})

test('every report shape declares that no screen reader was emulated', async (t) => {
  for (const html of [CLEAN, '<main><h1>A</h1><h3>B</h3></main>', '<main><h1>A</h1><x-p></x-p></main>']) {
    const { parsed } = await report(t, html)
    assert.equal(parsed.basis.emulatesScreenReader, false)
    assert.equal(parsed.basis.kind, 'exported-dom-snapshot')
    assert.equal(parsed.basis.parser, 'bounded-html-subset')
    assert.equal(parsed.basis.note, EVIDENCE_NOTE)
  }
})

test('the evidence note reaches the human summary as well as the JSON', async (t) => {
  const { run } = await report(t, CLEAN)
  assert.ok(run.stderr.includes('document order rather than announcement order'))
  assert.ok(run.stderr.includes('requires separate manual evidence'))
})

test('no field anywhere in a report claims spoken or announcement order', async (t) => {
  const claims = /^(announced|announcement|spoken|speech|readAloud|readingOrder|utterance|voiced|rotor)/i
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        assert.ok(!claims.test(key), `the report field "${key}" claims announced output`)
        walk(nested)
      }
    }
  }
  for (const html of [CLEAN, '<main><h1>A</h1><x-p></x-p></main>']) walk((await report(t, html)).parsed)
})

test('an unresolved landmark name is dropped from the comparison AND the run is incomplete', async (t) => {
  const { run, parsed } = await report(
    t,
    '<body><nav><a href="/">Home</a></nav>'
      + '<nav aria-labelledby="not-in-this-document"><a href="/t">Terms</a></nav>'
      + '<main><h1>A</h1></main></body>',
  )
  // The comparison is not made on a group one of whose members could not be
  // read, and the report says which comparison that was.
  assert.ok(!parsed.findings.some((f) => f.ruleId === 'duplicate-unlabelled-landmark'))
  assert.equal(parsed.status, 'incomplete')
  assert.equal(run.code, 2)
  const unresolved = parsed.findings.find((f) => f.ruleId === 'name-reference-unresolved')
  assert.match(unresolved.message, /duplicate-landmark comparison for navigation/)
})

test('the same markup with the reference RESOLVED reports the duplicate, so the rule still bites', async (t) => {
  // The mirror image of the test above: honesty about unknowns must not become
  // a refusal to ever report anything.
  const { run, parsed } = await report(
    t,
    '<body><nav><a href="/">Home</a></nav>'
      + '<nav aria-labelledby="empty-label"><a href="/t">Terms</a></nav>'
      + '<main><h1 id="empty-label"></h1></main></body>',
  )
  assert.ok(parsed.findings.some((f) => f.ruleId === 'duplicate-unlabelled-landmark'))
  assert.equal(run.code, 1)
})

test('the outline is positions in the markup, carrying depth and pointer', async (t) => {
  const { parsed } = await report(
    t,
    '<body><main><h1>A</h1><nav aria-label="Sections"><a href="#a">a</a></nav></main></body>',
  )
  for (const entry of parsed.documents[0].outline) {
    assert.ok(Number.isInteger(entry.depth))
    assert.match(entry.pointer, /^(\/[a-z0-9._-]+\[\d+\])+$/)
  }
})
