import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describeValue, excerpt, isPerceivable, renderText, singleLine } from '../src/index.mjs'

/**
 * A snapshot is somebody's page. Its ids, class names, role values, headings
 * and landmark labels are data: they never become a line of the report, and
 * they never become an instruction.
 *
 * Stripping C0 and the line separators is NOT sanitising: four tools in this
 * catalog did exactly that and let the C1 range through, where U+0085 forges a
 * line for anything using splitlines and U+009B is the 8-bit CSI a terminal
 * obeys. U+202E reverses everything printed after it, so one id can display as
 * another.
 *
 * Two of the classes below arrive through an IDENTIFIER rather than an
 * excerpt, because one tool in this catalog sanitised its evidence field
 * carefully and let a page id forge whole lines.
 *
 * Every character here is written as escape text, never as a literal byte.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')

const CLASSES = {
  'C0 (line feed)': '\u000a',
  'C0 (escape)': '\u001b',
  DEL: '\u007f',
  'C1 (NEL)': '\u0085',
  'C1 (CSI)': '\u009b',
  'line separator': '\u2028',
  'paragraph separator': '\u2029',
  'bidi (LRM)': '\u200e',
  'bidi (RLO)': '\u202e',
  'bidi (isolate)': '\u2066',
}

const FORBIDDEN = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'u',
)

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function report(t, html, name = 'page.html') {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-sanitise-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, name)
  await writeFile(file, html)
  const run = await runCli(['--snapshot', file])
  return { run, parsed: JSON.parse(run.stdout) }
}

/**
 * A file NAME is untrusted text too, and it is the one identifier that comes
 * from the caller rather than from the document. It reaches
 * `documents[].file`, every finding's `location.file`, and a line of the
 * human summary.
 */
const HOSTILE_NAME =
  'page\u000aERROR   forged line heading-empty Invented\u009b\u202e\u2028.html'

for (const [name, character] of Object.entries(CLASSES)) {
  test(`${name} is flattened out of every string that reaches output`, () => {
    assert.ok(!FORBIDDEN.test(singleLine(`before${character}after`)))
    assert.ok(!FORBIDDEN.test(excerpt(`before${character}after`)))
    assert.ok(!FORBIDDEN.test(renderText(`before${character}after`)))
  })
}

test('an unprintable arriving through an ID attribute cannot forge a report line', async (t) => {
  // An id is an identifier, not an excerpt, and it lands in a finding message.
  const forged = 'shared\u000aERROR   forged/line heading-empty Invented finding'
  const { run, parsed } = await report(
    t,
    `<main><h1 id="${forged}">A</h1><h2 id="${forged}">B</h2></main>`,
  )
  const finding = parsed.findings.find((entry) => entry.ruleId === 'duplicate-id')
  assert.ok(finding !== undefined)
  assert.ok(!FORBIDDEN.test(finding.message))
  const forgedLines = run.stderr.split('\n').filter((line) => line.startsWith('ERROR   forged'))
  assert.deepEqual(forgedLines, [])
})

test('an unprintable arriving through a ROLE value cannot forge a report line', async (t) => {
  const { parsed } = await report(
    t,
    '<main><h1>A</h1><div role="mystery\u2028WARNING forged">x</div></main>',
  )
  const finding = parsed.findings.find((entry) => entry.ruleId === 'role-unknown')
  assert.ok(finding !== undefined)
  assert.ok(!FORBIDDEN.test(finding.message))
})

test('an unprintable in a heading name cannot forge a line of the outline', async (t) => {
  const { run, parsed } = await report(
    t,
    '<main><h1>Catalogue\u0085ERROR   forged</h1></main>',
  )
  const heading = parsed.documents[0].outline.find((entry) => entry.kind === 'heading')
  assert.ok(!FORBIDDEN.test(heading.name))
  assert.deepEqual(
    run.stderr.split('\n').filter((line) => line.startsWith('ERROR   forged')),
    [],
  )
})

test('no string anywhere in a hostile report carries a stripped character', async (t) => {
  const hostile = '\u0085\u009b\u202e\u2028'
  // The snapshot is written under a hostile NAME as well as hostile content,
  // because "anywhere" has to include the one string that does not come from
  // the document. An earlier version of this test walked the whole report but
  // wrote the file as "page.html", so `documents[].file` -- the one string
  // the tool never flattened -- was never reached by the walk.
  const { run, parsed } = await report(
    t,
    `<main><h1 id="a${hostile}">T${hostile}</h1><h2 id="a${hostile}">B</h2>`
      + `<div role="q${hostile}">x</div><nav aria-labelledby="gone${hostile}"><a href="/">z</a></nav></main>`,
    HOSTILE_NAME,
  )
  assert.ok(parsed.documents[0].file.startsWith('page '))
  assert.deepEqual(
    run.stderr.split('\n').filter((line) => line.startsWith('ERROR   forged')),
    [],
  )
  const walk = (value) => {
    if (typeof value === 'string') {
      assert.ok(!FORBIDDEN.test(value), `leaked in ${JSON.stringify(value)}`)
    } else if (Array.isArray(value)) value.forEach(walk)
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(parsed)
})

test('a hostile snapshot NAME cannot forge a line of the human summary', async (t) => {
  // documents[].file is printed as `outline <name>` on stderr, so a newline
  // in the file name puts a whole line of the tool's own format into the
  // summary. The run itself is a clean pass, which is what makes it bad: a
  // forged ERROR line appears in a report that found nothing.
  const { run, parsed } = await report(
    t,
    '<html><body><main><h1>Title</h1></main></body></html>',
    HOSTILE_NAME,
  )
  assert.equal(run.code, 0)
  assert.equal(parsed.status, 'pass')
  assert.ok(!FORBIDDEN.test(parsed.documents[0].file))
  // Line by line: the summary is a multi-line report, so the newlines it puts
  // there itself are not what this is looking for.
  for (const line of run.stderr.split('\n')) {
    assert.ok(!line.startsWith('ERROR'), line)
    assert.ok(!FORBIDDEN.test(line), line)
  }
})

test('two snapshot names that differ only in stripped characters are refused', async (t) => {
  // The uniqueness check exists so that a finding can say which document it
  // came from. Two names that flatten to one string cannot be told apart in
  // the report, so the check is made on the flattened form.
  const directory = await mkdtemp(join(tmpdir(), 'srlm-sanitise-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const first = join(directory, 'page\u0085one.html')
  const second = join(directory, 'page\u2028one.html')
  for (const file of [first, second]) await writeFile(file, '<main><h1>Title</h1></main>')

  const run = await runCli(['--snapshot', first, '--snapshot', second])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Two snapshots are both named/)
  for (const line of run.stderr.split('\n')) assert.ok(!FORBIDDEN.test(line), line)
})

test('a value that cannot be turned into a string is described by its shape', () => {
  // `String({toString: {}})` throws: the property exists, so the object is not
  // treated as plain, and a non-callable toString is a TypeError.
  assert.throws(() => String({ toString: {} }), TypeError)
  assert.equal(describeValue({ toString: {} }), '[object]')
  assert.equal(singleLine({ toString: {} }), '[object]')
  assert.equal(describeValue([1, 2, 3]), '[array of 3]')
  assert.equal(describeValue(null), '[null]')
  assert.equal(describeValue(undefined), '[undefined]')
  assert.equal(describeValue(7), '7')
})

test('presence is judged on the rendered form, not on trim()', () => {
  for (const character of ['\u0001', '\u0085', '\u200e', '\u009b', '\u2066']) {
    assert.ok(character.trim().length > 0, 'the trim check would have passed this')
    assert.equal(isPerceivable(character), false)
  }
  assert.equal(isPerceivable('\u200b\u200b'), false)
  assert.equal(isPerceivable('   \u00a0 '), false)
  assert.equal(isPerceivable(''), false)
  assert.equal(isPerceivable('a\u200db'), true)
})

test('a heading made only of bidi marks is an empty heading', async (t) => {
  // It survives `trim().length > 0` and then announces nothing at all.
  const { run, parsed } = await report(t, '<main><h1>&#x200e;&#x200f;</h1></main>')
  assert.ok(parsed.findings.some((finding) => finding.ruleId === 'heading-empty'))
  assert.equal(run.code, 1)
})

test('a landmark label made only of control characters is no label at all', async (t) => {
  const { run, parsed } = await report(
    t,
    '<body><nav aria-label="&#x1;"><a href="/">a</a></nav>'
      + '<nav><a href="/t">b</a></nav><main><h1>A</h1></main></body>',
  )
  assert.ok(parsed.findings.some((finding) => finding.ruleId === 'duplicate-unlabelled-landmark'))
  assert.equal(run.code, 1)
})
