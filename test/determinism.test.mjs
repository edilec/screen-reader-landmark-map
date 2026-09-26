import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { byCodeUnit, mapSnapshots } from '../src/index.mjs'

/**
 * Ordering pinned by what is EMITTED, not by a grep of this project's source.
 *
 * Scanning for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with entirely different
 * source text, so the grep stays green while ordering silently becomes
 * dependent on the ICU data a Node build ships.
 *
 * Two of the three sort keys below genuinely disagree between the two
 * orderings, and the first test asserts they still disagree on this Node
 * build -- if a future ICU release collated them the same way this file would
 * be quietly measuring nothing, and it says so instead.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')

/**
 * `README.html` sorts before `assets.html` by code unit, because `R` (U+0052)
 * precedes `a` (U+0061). Collation puts `assets` first. This is the pair the
 * report contract records as having produced a real ordering difference in
 * this catalog.
 */
const README = '<main><h1>A</h1><h3>B</h3></main>'

/**
 * `x-a-b` sorts before `x-a_b` by code unit, because `-` (U+002D) precedes `_`
 * (U+005F). Collation treats both as punctuation and orders what surrounds
 * them, which reverses the pair. The elements are written in the OTHER order
 * in the markup, so document order cannot produce the expected result.
 */
const ASSETS = '<main><h1>A</h1><x-a_b></x-a_b><x-a-b></x-a-b></main>'

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'buffer' }, (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-order-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'README.html'), README)
  await writeFile(join(directory, 'assets.html'), ASSETS)
  return directory
}

test('the chosen inputs really do separate code-unit ordering from collation', () => {
  assert.equal(byCodeUnit('README.html', 'assets.html'), -1)
  assert.ok(
    'README.html'.localeCompare('assets.html') > 0,
    'this pair no longer discriminates on this Node build; choose another',
  )
  assert.equal(byCodeUnit('x-a-b', 'x-a_b'), -1)
  assert.ok(
    'x-a-b'.localeCompare('x-a_b') > 0,
    'this pair no longer discriminates on this Node build; choose another',
  )
})

test('findings sort by file, then pointer, then ruleId, all by code unit', async (t) => {
  const directory = await workspace(t)
  // Given in the order a collator would produce, so the sort has to do work.
  const report = await mapSnapshots({
    snapshots: [join(directory, 'assets.html'), join(directory, 'README.html')],
  })
  assert.deepEqual(
    report.findings.map((finding) => [
      finding.location.file,
      finding.location.pointer ?? '',
      finding.ruleId,
    ]),
    [
      ['README.html', '/main[1]/h3[1]', 'heading-level-skipped'],
      ['assets.html', '/main[1]/x-a-b[1]', 'shadow-root-unknown'],
      ['assets.html', '/main[1]/x-a_b[1]', 'shadow-root-unknown'],
    ],
  )
})

test('two rules at one pointer sort by ruleId, by code unit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-order2-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  // The same element carries a redundant role and a duplicated attribute:
  // `duplicate-attribute` precedes `landmark-role-redundant` by code unit.
  await writeFile(
    file,
    '<body><nav role="navigation" aria-label="P" id="a" id="b"><a href="/">x</a></nav>'
      + '<main><h1>A</h1></main></body>',
  )
  const report = await mapSnapshots({ snapshots: [file] })
  const atNav = report.findings
    .filter((finding) => finding.location.pointer === '/body[1]/nav[1]')
    .map((finding) => finding.ruleId)
  assert.deepEqual(atNav, ['duplicate-attribute', 'landmark-role-redundant'])
})

test('two findings of one rule at one pointer sort by message, by code unit', async (t) => {
  // The last ordering key, reached only when file, pointer and ruleId are all
  // equal. Two unsupported character references in one text node produce
  // exactly that, and `&Zulu;` before `&alpha;` is the pair a collator
  // reverses -- so substituting one here changes the order of the report.
  const directory = await mkdtemp(join(tmpdir(), 'srlm-message-order-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'page.html')
  await writeFile(file, '<body><main><h1>&Zulu; and &alpha;</h1></main></body>')
  const report = await mapSnapshots({ snapshots: [file] })
  const entities = report.findings.filter((finding) => finding.ruleId === 'entity-unsupported')
  assert.equal(entities.length, 2)
  assert.ok(entities[0].message.includes('&Zulu;'), entities[0].message)
  assert.ok(entities[1].message.includes('&alpha;'), entities[1].message)
  assert.ok(
    '&Zulu;'.localeCompare('&alpha;') > 0,
    'this pair no longer discriminates on this Node build; choose another',
  )
})

test('documents stay in the order they were given, and outlines in document order', async (t) => {
  const directory = await workspace(t)
  const report = await mapSnapshots({
    snapshots: [join(directory, 'assets.html'), join(directory, 'README.html')],
  })
  assert.deepEqual(
    report.documents.map((document) => document.file),
    ['assets.html', 'README.html'],
  )
  assert.deepEqual(
    report.documents[1].outline.map((entry) => entry.pointer),
    ['/main[1]', '/main[1]/h1[1]', '/main[1]/h3[1]'],
  )
})

test('two runs over one set of snapshots produce byte-identical stdout', async (t) => {
  const directory = await workspace(t)
  const args = [
    '--snapshot',
    join(directory, 'README.html'),
    '--snapshot',
    join(directory, 'assets.html'),
    '--json',
  ]
  const first = await runCli(args)
  const second = await runCli(args)
  assert.ok(first.stdout.equals(second.stdout))
})

test('the report carries no timestamp and reads no clock', async (t) => {
  const directory = await workspace(t)
  const report = await mapSnapshots({ snapshots: [join(directory, 'README.html')] })
  const text = JSON.stringify(report)
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text))
  assert.ok(!Object.hasOwn(report, 'generatedAt'))
})

test('two snapshots with the same base name are refused rather than confused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-order3-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'page.html'), README)
  await writeFile(join(directory, 'nested.html'), README)

  const run = await runCli([
    '--snapshot',
    join(directory, 'page.html'),
    '--snapshot',
    join(directory, '.', 'page.html'),
  ])
  assert.equal(run.code, 2)
  assert.equal(run.stdout.toString(), '')
  assert.match(run.stderr.toString(), /both named/)
})
