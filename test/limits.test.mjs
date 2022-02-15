import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DEFAULT_LIMITS, validateLimits } from '../src/index.mjs'

/**
 * Both boundaries of every limit.
 *
 * A limit tested only on the refusing side passes for a tool that refuses
 * everything; a limit tested only on the accepting side passes for a tool that
 * never enforces it. A documented limit that is never wired through is a
 * measured defect class in this catalog, so each one is driven at N and at N+1
 * through the real CLI, and the exit code is the assertion.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')

/** Two elements, nesting depth two, one heading. */
const PAGE = '<main><h1>Catalogue</h1></main>'

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function write(t, body, name = 'page.html') {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-limits-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, name)
  await writeFile(path, body)
  return path
}

test('maxElements accepts exactly the limit and refuses one more', async (t) => {
  const file = await write(t, PAGE)

  const atLimit = await runCli(['--snapshot', file, '--max-elements', '2', '--json'])
  assert.equal(atLimit.code, 0)
  assert.equal(JSON.parse(atLimit.stdout).summary.checked, 2)

  const overLimit = await runCli(['--snapshot', file, '--max-elements', '1', '--json'])
  assert.equal(overLimit.code, 2)
  assert.ok(JSON.parse(overLimit.stdout).findings.some((f) => f.ruleId === 'too-many-elements'))
})

test('maxDepth accepts exactly the limit and refuses one more', async (t) => {
  const file = await write(t, PAGE)

  const atLimit = await runCli(['--snapshot', file, '--max-depth', '2', '--json'])
  assert.equal(atLimit.code, 0)

  const overLimit = await runCli(['--snapshot', file, '--max-depth', '1', '--json'])
  assert.equal(overLimit.code, 2)
  assert.ok(JSON.parse(overLimit.stdout).findings.some((f) => f.ruleId === 'depth-exceeded'))
})

test('maxFileBytes accepts exactly the file size and refuses one byte fewer', async (t) => {
  const file = await write(t, PAGE)
  const size = Buffer.byteLength(PAGE)

  const atLimit = await runCli(['--snapshot', file, '--max-file-bytes', `${size}`, '--json'])
  assert.equal(atLimit.code, 0)

  const overLimit = await runCli(['--snapshot', file, '--max-file-bytes', `${size - 1}`, '--json'])
  assert.equal(overLimit.code, 2)
  assert.ok(JSON.parse(overLimit.stdout).findings.some((f) => f.ruleId === 'file-too-large'))
})

test('maxFindings accepts exactly the limit and truncates one more', async (t) => {
  // A document starting at level 2 with no main landmark: two findings, both
  // warnings, so the run passes until the limit bites.
  const file = await write(t, '<body><h2>A</h2><h3>B</h3></body>')

  const atLimit = await runCli(['--snapshot', file, '--max-findings', '2', '--json'])
  assert.equal(atLimit.code, 0)
  assert.equal(JSON.parse(atLimit.stdout).findings.length, 2)

  const overLimit = await runCli(['--snapshot', file, '--max-findings', '1', '--json'])
  assert.equal(overLimit.code, 2)
  const report = JSON.parse(overLimit.stdout)
  // Truncation is reported, never silent, and it is not a pass.
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((f) => f.ruleId === 'too-many-findings'))
})

test('an unknown limit name is rejected rather than ignored', () => {
  assert.throws(() => validateLimits({ maxElementz: 5 }), /Unknown limit "maxElementz"/)
  assert.throws(() => validateLimits({ maxElements: 0 }), /must be a positive integer/)
  assert.throws(() => validateLimits({ maxElements: 1.5 }), /must be a positive integer/)
  assert.deepEqual(validateLimits({}), DEFAULT_LIMITS)
})

test('a limits value that is not an object is refused, by the check that refuses it', () => {
  // Asserting only the TYPE here is what left this guard undefended: a string
  // still throws a TypeError from the NEXT check ('Unknown limit "0"',
  // because Object.entries("nope") yields index keys), so the precondition
  // could be deleted with the suite green -- and then [], 42 and true stopped
  // being refused at all and quietly became "defaults accepted".
  for (const value of [[], 42, true, null, 'nope']) {
    assert.throws(
      () => validateLimits(value),
      /Limits must be an object/,
      `${JSON.stringify(value)} was not refused by the precondition`,
    )
  }
})

test('a landmark label longer than the bound is reported bounded, in the outline', async (t) => {
  // The 160-character bound on reported text is real in the code and was
  // asserted nowhere: removing it reproduced a 5000-character attribute value
  // verbatim into the outline and into a finding message, with the whole
  // suite green.
  const long = 'S'.repeat(5000)
  const file = await write(t, `<main aria-label="${long}"><h1>Catalogue</h1></main>`)
  const run = await runCli(['--snapshot', file, '--json'])
  const outline = JSON.parse(run.stdout).documents[0].outline
  assert.equal(outline[0].name.length, 163)
  assert.ok(outline[0].name.endsWith('...'))

  // The mirror: a label that fits is reported whole, with no ellipsis.
  const short = 'S'.repeat(160)
  const fits = await write(t, `<main aria-label="${short}"><h1>Catalogue</h1></main>`, 'fits.html')
  const kept = JSON.parse((await runCli(['--snapshot', fits, '--json'])).stdout)
  assert.equal(kept.documents[0].outline[0].name, short)
})

test('an unknown CLI option exits 2 with empty stdout', async () => {
  const run = await runCli(['--snapshot', 'whatever.html', '--max-elementz', '5'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /Unknown option/)
})

test('a non-numeric limit value exits 2 with empty stdout', async () => {
  const run = await runCli(['--snapshot', 'whatever.html', '--max-elements', 'many'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
})

test('a missing --snapshot exits 2 with empty stdout', async () => {
  const run = await runCli(['--json'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /--snapshot is required/)
})

test('a flag given without a value exits 2 with empty stdout', async () => {
  for (const flag of ['--snapshot', '--out', '--max-elements']) {
    const run = await runCli([flag])
    assert.equal(run.code, 2)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /requires a value/)
  }
})
