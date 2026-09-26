import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { INCOMPLETE_RULES, RULE_SEVERITY } from '../src/index.mjs'

/**
 * Severity pinned by what the tool DOES, not by what three files say.
 *
 * `test/severity-table.test.mjs` asserts the frozen table against the
 * documented catalog, which is worth having and is not enough: a table entry,
 * a catalog row and a hand-written expectation can all be flipped in one edit,
 * agree with each other perfectly, and leave the tool quietly passing a defect
 * it used to fail on.
 *
 * So every rule is produced by real markup in a real process, and the two
 * things a consumer reads are asserted as literals: the report's `status` and
 * the exit code. Downgrading `duplicate-unlabelled-landmark` to a warning
 * fails this file with "expected fail, got pass" however many declarations
 * were edited to match.
 *
 *   incomplete / 2  evidence the run never obtained. Outranks fail.
 *   fail / 1        an error that is not missing evidence.
 *   pass / 0        a warning or an info finding alone. A tool that exits
 *                   non-zero because a page has no heading is a tool nobody
 *                   can put in CI.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')
const MAIN = '<main><h1>Catalogue</h1></main>'

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

/** ruleId -> [expected status, expected exit code, markup or arguments builder]. */
const scenarios = {
  'depth-exceeded': ['incomplete', 2, (w) => [w('<div><div><div>x</div></div></div>'), '--max-depth', '2']],
  'duplicate-attribute': ['pass', 0, (w) => [w('<main><h1 id="a" id="b">A</h1></main>')]],
  'duplicate-id': ['incomplete', 2, (w) => [w('<main><h1 id="x">A</h1><h2 id="x">B</h2></main>')]],
  'duplicate-landmark-name': ['pass', 0, (w) => [
    w(`<body><nav aria-label="Menu"><a href="/">a</a></nav><nav aria-label="Menu"><a href="/b">b</a></nav>${MAIN}</body>`),
  ]],
  'duplicate-unique-landmark': ['fail', 1, (w) => [w(`<body>${MAIN}<main><h2>Second</h2></main></body>`)]],
  'duplicate-unlabelled-landmark': ['fail', 1, (w) => [
    w(`<body><nav><a href="/">a</a></nav><nav><a href="/b">b</a></nav>${MAIN}</body>`),
  ]],
  'empty-snapshot': ['incomplete', 2, (w) => [w('')]],
  'entity-unsupported': ['incomplete', 2, (w) => [w('<main><h1>f&fnof;o</h1></main>')]],
  'file-too-large': ['incomplete', 2, (w) => [w(MAIN), '--max-file-bytes', '4']],
  'first-heading-not-top-level': ['pass', 0, (w) => [w('<main><h2>Catalogue</h2></main>')]],
  'foreign-content-ignored': ['pass', 0, (w) => [w('<main><h1>A</h1><svg><path d="M0 0"/></svg></main>')]],
  'foreign-content-skipped': ['incomplete', 2, (w) => [
    w('<main><h1>A</h1><svg><foreignObject><h2>B</h2></foreignObject></svg></main>'),
  ]],
  'heading-empty': ['fail', 1, (w) => [w('<main><h1>A</h1><h2></h2></main>')]],
  'heading-level-skipped': ['fail', 1, (w) => [w('<main><h1>A</h1><h3>B</h3></main>')]],
  'html-construct-unsupported': ['incomplete', 2, (w) => [w('<main><h1>A</h1><div/></main>')]],
  'iframe-content-unavailable': ['incomplete', 2, (w) => [
    w('<main><h1>A</h1><iframe src="/x" title="Usage"></iframe></main>'),
  ]],
  'implied-end-tag': ['pass', 0, (w) => [w('<main><h1>A</h1><ul><li>a<li>b</ul></main>')]],
  'landmark-role-redundant': ['pass', 0, (w) => [
    w(`<body><nav role="navigation" aria-label="Primary"><a href="/">a</a></nav>${MAIN}</body>`),
  ]],
  'mismatched-end-tag': ['incomplete', 2, (w) => [w('<main><h1>A</h1><div><span>x</div></main>')]],
  'multiple-top-level-headings': ['pass', 0, (w) => [w('<main><h1>A</h1><h1>B</h1></main>')]],
  'name-reference-unresolved': ['incomplete', 2, (w) => [
    w('<main><h1>A</h1><nav aria-labelledby="gone"><a href="/">a</a></nav></main>'),
  ]],
  'no-heading': ['pass', 0, (w) => [w('<main><p>Prose only.</p></main>')]],
  'no-main-landmark': ['pass', 0, (w) => [w('<body><h1>Catalogue</h1></body>')]],
  'role-unknown': ['incomplete', 2, (w) => [w('<main><h1>A</h1><div role="fancybox">x</div></main>')]],
  'shadow-root-not-traversed': ['incomplete', 2, (w) => [
    w('<main><h1>A</h1><x-p><template shadowrootmode="open"><nav>x</nav></template></x-p></main>'),
  ]],
  'shadow-root-unknown': ['incomplete', 2, (w) => [w('<main><h1>A</h1><x-p></x-p></main>')]],
  'snapshot-undecodable': ['incomplete', 2, (w) => [w(Buffer.from([0x3c, 0xff, 0x3e]))]],
  'snapshot-unreadable': ['incomplete', 2, (w) => [join(w(MAIN), '..', 'absent.html')]],
  'stray-end-tag': ['incomplete', 2, (w) => [w('<main><h1>A</h1></main></section>')]],
  'template-content-skipped': ['pass', 0, (w) => [w('<main><h1>A</h1><template><p>x</p></template></main>')]],
  'too-many-elements': ['incomplete', 2, (w) => [w(MAIN), '--max-elements', '1']],
  'too-many-findings': ['incomplete', 2, (w) => [w('<body><h2>A</h2><h2>B</h2></body>'), '--max-findings', '1']],
  'unclosed-element': ['incomplete', 2, (w) => [w(`${MAIN}<section>x`)]],
}

for (const ruleId of Object.keys(scenarios).sort()) {
  const [expectedStatus, expectedCode, build] = scenarios[ruleId]
  test(`${ruleId} produces status ${expectedStatus} and exit ${expectedCode}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'srlm-severity-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const pending = []
    const write = (data) => {
      const path = join(directory, 'page.html')
      pending.push(writeFile(path, data))
      return path
    }
    const [snapshot, ...rest] = build(write)
    await Promise.all(pending)

    const run = await runCli(['--snapshot', snapshot, ...rest, '--json'])
    const report = JSON.parse(run.stdout)
    const finding = report.findings.find((entry) => entry.ruleId === ruleId)
    assert.ok(
      finding !== undefined,
      `expected a ${ruleId} finding, got ${report.findings.map((entry) => entry.ruleId).join(', ')}`,
    )
    assert.equal(finding.severity, RULE_SEVERITY[ruleId])
    assert.equal(report.status, expectedStatus)
    assert.equal(run.code, expectedCode)
  })
}

test('every rule in the table is produced by a scenario above', () => {
  assert.deepEqual(Object.keys(scenarios).sort(), Object.keys(RULE_SEVERITY).sort())
})

test('a rule that forces an incomplete result never reports fail or pass', () => {
  for (const [ruleId, [status, code]] of Object.entries(scenarios)) {
    if (!INCOMPLETE_RULES.includes(ruleId)) continue
    assert.equal(status, 'incomplete', `${ruleId} must report incomplete`)
    assert.equal(code, 2, `${ruleId} must exit 2`)
  }
})
