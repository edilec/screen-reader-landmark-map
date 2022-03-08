import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DEFAULT_LIMITS, describeValue, headingLevel, mapSnapshots, parseHtml } from '../src/index.mjs'

/**
 * The name sources, the undetermined answers and the human summary.
 *
 * A 343-mutation sweep over src/ removed each of these on its own and the
 * whole suite stayed green. None of them is incidental: each decides a name
 * this tool reports, a record it keeps, or a line a person reads.
 *
 * Every assertion here was checked by breaking the line it names and watching
 * this file fail.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')

async function mapDocument(t, html, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-names-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  await writeFile(file, html)
  return mapSnapshots({ snapshots: [file], ...options })
}

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

const outline = (report) => report.documents[0].outline
const named = (report, pointer) => outline(report).find((entry) => entry.pointer === pointer)
const rules = (report) => report.findings.map((finding) => finding.ruleId)

test('title names a landmark when nothing above it does, and loses when something does', async (t) => {
  const fallback = await mapDocument(
    t,
    '<body><nav title="Primary"><a href="/">Home</a></nav>'
      + '<nav aria-label="Legal"><a href="/terms/">Terms</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(named(fallback, '/body[1]/nav[1]').name, 'Primary')
  assert.deepEqual(rules(fallback).filter((id) => id === 'duplicate-unlabelled-landmark'), [])

  const outranked = await mapDocument(
    t,
    '<body><nav title="Weak" aria-label="Primary"><a href="/">Home</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(named(outranked, '/body[1]/nav[1]').name, 'Primary')

  // And a title that renders as nothing is no name at all, so the rule bites.
  const blank = await mapDocument(
    t,
    '<body><nav title="   "><a href="/">Home</a></nav><nav><a href="/t">T</a></nav>'
      + '<main><h1>Catalogue</h1></main></body>',
  )
  assert.equal(blank.findings.filter((f) => f.ruleId === 'duplicate-unlabelled-landmark').length, 2)
})

test('an area and an image input contribute their alt to a name', async (t) => {
  const area = await mapDocument(
    t,
    '<body><main><h1><map name="floors"><area href="/n" alt="North wing"></map></h1></main></body>',
  )
  assert.equal(named(area, '/body[1]/main[1]/h1[1]').name, 'North wing')
  assert.deepEqual(rules(area).filter((id) => id === 'heading-empty'), [])

  const image = await mapDocument(
    t,
    '<body><main><h1><input type="image" alt="Search"></h1></main></body>',
  )
  assert.equal(named(image, '/body[1]/main[1]/h1[1]').name, 'Search')
})

test('a button-like input with no value contributes the default HTML gives its type', async (t) => {
  const report = await mapDocument(
    t,
    '<body><main><h1><input type="submit"></h1><h2><input type="reset"></h2>'
      + '<h3><input type="button"></h3></main></body>',
  )
  assert.equal(named(report, '/body[1]/main[1]/h1[1]').name, 'Submit')
  assert.equal(named(report, '/body[1]/main[1]/h2[1]').name, 'Reset')
  // HTML gives `type=button` no default, so this heading really is empty.
  assert.equal(named(report, '/body[1]/main[1]/h3[1]').name, '')
})

test('a landmark and a heading whose name is unresolved are kept, with a null name', async (t) => {
  // Dropping either record loses the region from the map entirely, which is a
  // worse answer than "this evidence cannot say what it is called": the
  // outline stops listing it and the run stops being incomplete about it.
  const report = await mapDocument(
    t,
    '<body><nav aria-labelledby="gone"><a href="/">Home</a></nav>'
      + '<main><h1 aria-labelledby="also-gone">Catalogue</h1></main></body>',
  )
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    outline(report).map((entry) => [entry.kind, entry.pointer, entry.name]),
    [
      ['landmark', '/body[1]/nav[1]', null],
      ['landmark', '/body[1]/main[1]', ''],
      ['heading', '/body[1]/main[1]/h1[1]', null],
    ],
  )
  assert.equal(report.summary.unresolvedNames, 2)
  assert.equal(report.summary.landmarks, 2)
  assert.equal(report.summary.headings, 1)
})

test('a custom element that DOES serialise its shadow root is not also reported as unknown', async (t) => {
  // The two rules answer different questions: one says the root is here and
  // was not traversed, the other says there may be one this file never held.
  // Reporting both for one element says the same region is missing twice.
  const report = await mapDocument(
    t,
    '<body><main><h1>Catalogue</h1>'
      + '<my-el><template shadowrootmode="open"><p>x</p></template></my-el></main></body>',
  )
  assert.deepEqual(
    rules(report).filter((id) => id.startsWith('shadow-root')),
    ['shadow-root-not-traversed'],
  )
  assert.equal(report.status, 'incomplete')

  // The mirror: with no serialised root, the other rule is the one that fires.
  const bare = await mapDocument(t, '<body><main><h1>Catalogue</h1><my-el></my-el></main></body>')
  assert.deepEqual(
    rules(bare).filter((id) => id.startsWith('shadow-root')),
    ['shadow-root-unknown'],
  )
})

test('every kind of unread region withholds a hierarchy claim across it', async (t) => {
  // Each region sets the same flag, and each was removable on its own. A
  // level jump with the region BETWEEN the two headings is withheld; the same
  // jump with the region elsewhere is still reported.
  const regions = {
    'a serialised shadow root': '<my-el><template shadowrootmode="open"><h2>B</h2></template></my-el>',
    'a custom element': '<my-el></my-el>',
    'an iframe': '<iframe src="/x"></iframe>',
    'an svg foreignObject': '<svg><foreignObject><h2>B</h2></foreignObject></svg>',
    'an unrecognised role': '<div role="nosuchrole"><h2>B</h2></div>',
  }
  for (const [what, markup] of Object.entries(regions)) {
    const across = await mapDocument(t, `<body><main><h1>A</h1>${markup}<h3>C</h3></main></body>`)
    assert.deepEqual(
      across.findings.filter((f) => f.ruleId === 'heading-level-skipped'),
      [],
      `a jump across ${what} was reported`,
    )
    assert.equal(across.status, 'incomplete')

    const after = await mapDocument(t, `<body><main><h1>A</h1><h3>C</h3>${markup}</main></body>`)
    assert.equal(
      after.findings.filter((f) => f.ruleId === 'heading-level-skipped').length,
      1,
      `a jump before ${what} was withheld`,
    )
  }
})

test('one finding is reported once, however many times it is produced', async (t) => {
  // Two references to the same missing id produce the same finding twice.
  const report = await mapDocument(
    t,
    '<body><main><h1 aria-labelledby="gone gone">Catalogue</h1></main></body>',
  )
  assert.equal(report.findings.filter((f) => f.ruleId === 'name-reference-unresolved').length, 1)
})

test('a snapshot that could not be read is still listed among the documents', async (t) => {
  // The report is keyed on documents, so dropping the record leaves a
  // consumer with a finding about a file the report does not list.
  const directory = await mkdtemp(join(tmpdir(), 'srlm-missing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const report = await mapSnapshots({ snapshots: [join(directory, 'nowhere.html')] })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.documents, [{ file: 'nowhere.html', outline: [] }])
  assert.deepEqual(rules(report), ['snapshot-unreadable'])
})

test('a node already being traversed contributes nothing, as the computation requires', async (t) => {
  // The heading names itself through a descendant's reference. Traversal of
  // the heading is already underway, so the referenced node contributes the
  // empty string and the heading really has no accessible name. Without the
  // traversal set it contributes the text underneath it and the heading comes
  // back named after itself.
  const report = await mapDocument(
    t,
    '<body><main><h1 id="h"><span aria-labelledby="h">x</span></h1></main></body>',
  )
  assert.equal(named(report, '/body[1]/main[1]/h1[1]').name, '')
  assert.deepEqual(rules(report).filter((id) => id === 'heading-empty'), ['heading-empty'])

  // The mirror: a reference that does not point back still contributes.
  const forward = await mapDocument(
    t,
    '<body><main><h1><span aria-labelledby="src">x</span></h1><span id="src">Real</span></main></body>',
  )
  assert.equal(named(forward, '/body[1]/main[1]/h1[1]').name, 'Real')
})

test('aria-level is read only in the range ARIA defines, and the tag decides otherwise', () => {
  const level = (attributes, tag = 'h3') => {
    const parsed = parseHtml(`<${tag} ${attributes}>x</${tag}>`, DEFAULT_LIMITS)
    return headingLevel(parsed.elements[0], null)
  }
  assert.equal(level('aria-level="2"'), 2)
  assert.equal(level('aria-level="99"'), 99)
  // Out of range, so the tag decides. `aria-level="0"` read literally makes a
  // level 0 heading, which no hierarchy check can place.
  assert.equal(level('aria-level="0"'), 3)
  assert.equal(level('aria-level="-1"'), 3)
  assert.equal(level('aria-level="100"'), 3)
  assert.equal(level('aria-level="two"'), 3)
  assert.equal(level(''), 3)
})

test('a bare angle bracket in text is text, not the start of a tag', () => {
  // Without the guard the parser dereferences a match that is not there.
  const parsed = parseHtml('<main><p>5 < 6 and 7 > 4</p></main>', DEFAULT_LIMITS)
  assert.deepEqual(
    parsed.elements.map((element) => element.path),
    ['/main[1]', '/main[1]/p[1]'],
  )
  assert.match(parsed.elements[1].children[0].text, /5 < 6/)
})

test('a value of any shape is described rather than reproduced', () => {
  assert.equal(describeValue(Symbol('s')), '[symbol]')
  assert.equal(describeValue(() => {}), '[function]')
  assert.equal(describeValue({}), '[object]')
  assert.equal(describeValue(10n), '10')
})

test('the human summary carries the counts, the evidence note, the outline and the findings', async (t) => {
  // stderr is the half a person reads, and each of these lines was removable
  // with the suite green.
  const directory = await mkdtemp(join(tmpdir(), 'srlm-summary-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  await writeFile(file, '<body><main><h1>A</h1><h3>C</h3></main></body>')
  const run = await runCli(['--snapshot', file])
  const lines = run.stderr.split('\n')

  assert.equal(lines[0], 'screen-reader-landmark-map: status fail')
  assert.equal(lines[1], '1 document(s), 4 element(s); 1 landmark(s), 2 heading(s).')
  assert.equal(lines[2], '0 unresolved name(s), 0 region(s) this snapshot does not contain.')
  assert.equal(lines[3], '1 error, 0 warning, 0 info.')
  assert.match(lines[4], /document order rather than announcement order/)
  assert.equal(lines[5], 'outline page.html')
  assert.match(lines.at(-2), /^ERROR {3}page\.html \/body\[1\]\/main\[1\]\/h3\[1\] heading-level-skipped /)
  assert.equal(run.code, 1)
})
