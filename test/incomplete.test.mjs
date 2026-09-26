import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { INCOMPLETE_RULES } from '../src/index.mjs'

/**
 * One real run per rule that forces an incomplete result.
 *
 * Eleven of these rules are warnings. For those eleven, membership of
 * INCOMPLETE_RULES is the ONLY thing between a document the tool could not
 * fully read and a green exit -- delete one entry and the tool starts
 * reporting a clean landmark map for a page whose navigation regions are
 * inside a shadow root it never opened. So each rule is driven through the
 * real CLI and the assertion is the exit code, which no declaration can be
 * edited to satisfy.
 *
 * The final test asserts the coverage itself: a new entry in INCOMPLETE_RULES
 * with no scenario here fails the suite rather than shipping undefended.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

const PAGE = '<body><main><h1>Catalogue</h1></main></body>'

/** ruleId -> the CLI arguments that provoke exactly that rule. */
const scenarios = {
  'depth-exceeded': (write) => [write('a.html', '<div><div><div>x</div></div></div>'), '--max-depth', '2'],
  'duplicate-id': (write) => [write('b.html', '<main><h1 id="x">A</h1><h2 id="x">B</h2></main>')],
  'empty-snapshot': (write) => [write('c.html', '')],
  'entity-unsupported': (write) => [write('d.html', '<main><h1>f&fnof;o</h1></main>')],
  'file-too-large': (write) => [write('e.html', PAGE), '--max-file-bytes', '4'],
  'foreign-content-skipped': (write) => [
    write('f.html', '<main><h1>A</h1><svg><foreignObject><h2>B</h2></foreignObject></svg></main>'),
  ],
  'html-construct-unsupported': (write) => [write('g.html', '<main><h1>A</h1><div/></main>')],
  'iframe-content-unavailable': (write) => [
    write('h.html', '<main><h1>A</h1><iframe src="/x" title="Usage"></iframe></main>'),
  ],
  'mismatched-end-tag': (write) => [write('i.html', '<main><h1>A</h1><div><span>x</div></main>')],
  'name-reference-unresolved': (write) => [
    write('j.html', '<main><h1>A</h1><nav aria-labelledby="gone"><a href="/">Home</a></nav></main>'),
  ],
  'role-unknown': (write) => [write('k.html', '<main><h1>A</h1><div role="fancybox">x</div></main>')],
  'shadow-root-not-traversed': (write) => [
    write('l.html', '<main><h1>A</h1><x-panel><template shadowrootmode="open"><nav>x</nav></template></x-panel></main>'),
  ],
  'shadow-root-unknown': (write) => [write('m.html', '<main><h1>A</h1><x-panel></x-panel></main>')],
  'snapshot-undecodable': (write) => [write('n.html', Buffer.from([0x3c, 0xff, 0x3e]))],
  'snapshot-unreadable': (write) => [join(write('o.html', PAGE), '..', 'absent.html')],
  'stray-end-tag': (write) => [write('p.html', '<main><h1>A</h1></main></section>')],
  'too-many-elements': (write) => [write('q.html', PAGE), '--max-elements', '2'],
  'too-many-findings': (write) => [
    write('r.html', '<body><h2>A</h2><h2>B</h2></body>'),
    '--max-findings',
    '1',
  ],
  'unclosed-element': (write) => [write('s.html', '<main><h1>A</h1></main><section>x')],
}

for (const ruleId of Object.keys(scenarios).sort()) {
  test(`${ruleId} makes the run incomplete and exits 2`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'srlm-incomplete-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const pending = []
    const write = (name, data) => {
      const path = join(directory, name)
      pending.push(writeFile(path, data))
      return path
    }
    const args = scenarios[ruleId](write)
    await Promise.all(pending)

    const [snapshot, ...rest] = args
    const run = await runCli(['--snapshot', snapshot, ...rest, '--json'])
    const report = JSON.parse(run.stdout)
    assert.ok(
      report.findings.some((finding) => finding.ruleId === ruleId),
      `expected a ${ruleId} finding, got ${report.findings.map((f) => f.ruleId).join(', ')}`,
    )
    assert.equal(report.status, 'incomplete')
    assert.equal(run.code, 2)
  })
}

test('every rule that forces an incomplete result has a scenario above', () => {
  assert.deepEqual(Object.keys(scenarios).sort(), [...INCOMPLETE_RULES].sort())
})
