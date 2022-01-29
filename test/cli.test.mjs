import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** The CLI contract, including what it does not do. */

const ROOT = resolve(import.meta.dirname, '..')
const CLI = join(ROOT, 'bin', 'screen-reader-landmark-map.mjs')
const EXAMPLES = join(ROOT, 'examples')

function runCli(args, options = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], options, (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

test('--help exits 0 and keeps stdout empty for a consumer piping JSON', async () => {
  for (const flag of ['--help', '-h']) {
    const run = await runCli([flag])
    assert.equal(run.code, 0)
    assert.equal(run.stdout, '')
    assert.match(run.stderr, /screen-reader-landmark-map/)
    assert.match(run.stderr, /does[\s\S]{0,4}not traverse shadow roots/)
  }
})

test('the help text documents every exit code, and the unconfined destination', async () => {
  const { stderr } = await runCli(['--help'])
  for (const line of ['  0  ', '  1  ', '  2  ']) assert.ok(stderr.includes(line))
  // Documenting a confinement the code does not perform is worse than silence,
  // so the help says outright that a symbolically linked parent is followed.
  assert.match(stderr, /NOT confined to a root/)
  assert.match(stderr, /symbolically linked parent[\s\S]{0,40}is followed/)
})

test('the clean example passes and exits 0', async () => {
  const run = await runCli(['--snapshot', join(EXAMPLES, 'docs-clean.html')])
  assert.equal(run.code, 0)
  assert.equal(JSON.parse(run.stdout).status, 'pass')
})

test('the duplicate-navigation example fails and exits 1', async () => {
  const run = await runCli(['--snapshot', join(EXAMPLES, 'shop-duplicate-nav.html')])
  assert.equal(run.code, 1)
  const report = JSON.parse(run.stdout)
  assert.equal(report.status, 'fail')
  assert.ok(report.findings.some((f) => f.ruleId === 'duplicate-unlabelled-landmark'))
  assert.ok(report.findings.some((f) => f.ruleId === 'heading-level-skipped'))
})

test('the partial example exits 2 with a report on stdout', async () => {
  const run = await runCli(['--snapshot', join(EXAMPLES, 'app-shell-partial.html')])
  assert.equal(run.code, 2)
  assert.equal(JSON.parse(run.stdout).status, 'incomplete')
})

test('stdout is JSON and nothing else, for every exit code that produces a report', async () => {
  for (const name of ['docs-clean.html', 'shop-duplicate-nav.html', 'app-shell-partial.html']) {
    const run = await runCli(['--snapshot', join(EXAMPLES, name)])
    const report = JSON.parse(run.stdout)
    assert.equal(report.tool, 'screen-reader-landmark-map')
    assert.equal(report.schemaVersion, '1')
  }
})

test('--json suppresses the human summary and leaves stdout untouched', async () => {
  const plain = await runCli(['--snapshot', join(EXAMPLES, 'docs-clean.html')])
  const quiet = await runCli(['--snapshot', join(EXAMPLES, 'docs-clean.html'), '--json'])
  assert.equal(plain.stdout, quiet.stdout)
  assert.notEqual(plain.stderr, '')
  assert.equal(quiet.stderr, '')
})

test('the human summary prints the outline it produced', async () => {
  const run = await runCli(['--snapshot', join(EXAMPLES, 'docs-clean.html')])
  assert.match(run.stderr, /outline docs-clean\.html/)
  assert.match(run.stderr, /navigation "Primary"/)
  assert.match(run.stderr, /h1 "Deployment handbook"/)
})

test('several snapshots are mapped in one run, each keeping its own findings', async () => {
  const run = await runCli([
    '--snapshot',
    join(EXAMPLES, 'docs-clean.html'),
    '--snapshot',
    join(EXAMPLES, 'shop-duplicate-nav.html'),
    '--json',
  ])
  const report = JSON.parse(run.stdout)
  assert.equal(report.summary.documents, 2)
  assert.deepEqual(
    report.documents.map((document) => document.file),
    ['docs-clean.html', 'shop-duplicate-nav.html'],
  )
  for (const finding of report.findings) {
    assert.ok(['docs-clean.html', 'shop-duplicate-nav.html'].includes(finding.location.file))
  }
  assert.equal(run.code, 1)
})

test('location.file is the snapshot name, never an absolute host path', async () => {
  const run = await runCli(['--snapshot', join(EXAMPLES, 'app-shell-partial.html'), '--json'])
  const report = JSON.parse(run.stdout)
  for (const finding of report.findings) {
    if (finding.location.file === undefined) continue
    assert.equal(finding.location.file, 'app-shell-partial.html')
  }
  assert.ok(!run.stdout.includes(ROOT))
})

test('a run without --out changes nothing on disk', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'srlm-readonly-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await cp(join(EXAMPLES, 'docs-clean.html'), join(directory, 'page.html'))
  await writeFile(join(directory, 'bystander.txt'), 'untouched')

  const describe = async () => {
    const names = (await readdir(directory)).sort()
    const entries = []
    for (const name of names) {
      const info = await stat(join(directory, name))
      entries.push([name, info.size, info.mtimeMs, info.ino])
    }
    return entries
  }

  const before = await describe()
  const run = await runCli(['--snapshot', 'page.html'], { cwd: directory })
  assert.equal(run.code, 0)
  assert.deepEqual(await describe(), before)
})
