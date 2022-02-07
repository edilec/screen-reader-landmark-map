import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { REPORT_SCHEMA_VERSION, TOOL_ID } from '../src/index.mjs'

/**
 * One identity, spelled the same way everywhere.
 *
 * The tool id appears in the directory name, the package name, the executable
 * name, the `bin` key and the `tool` field of every report. A consumer keying
 * on any of them has to find the same string, so they are asserted against
 * each other rather than against a literal repeated six times.
 */

const ROOT = resolve(import.meta.dirname, '..')

async function manifest() {
  return JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
}

test('TOOL_ID equals the directory name', () => {
  assert.equal(TOOL_ID, basename(ROOT))
})

test('TOOL_ID equals the package name, the bin key and the executable name', async () => {
  const pkg = await manifest()
  assert.equal(pkg.name, TOOL_ID)
  assert.deepEqual(Object.keys(pkg.bin), [TOOL_ID])
  assert.equal(pkg.bin[TOOL_ID], `./bin/${TOOL_ID}.mjs`)
  await stat(join(ROOT, 'bin', `${TOOL_ID}.mjs`))
})

test('the report identifies itself by the same id and schema version', async () => {
  const { mapSnapshots } = await import('../src/index.mjs')
  const report = await mapSnapshots({
    snapshots: [join(ROOT, 'examples', 'docs-clean.html')],
  })
  assert.equal(report.tool, TOOL_ID)
  assert.equal(report.schemaVersion, REPORT_SCHEMA_VERSION)
})

test('the package declares the scripts the verification command needs', async () => {
  const pkg = await manifest()
  for (const script of ['lint', 'test', 'example', 'pack:check', 'check']) {
    assert.ok(typeof pkg.scripts[script] === 'string', `missing script "${script}"`)
  }
  for (const part of ['lint', 'test', 'example', 'pack:check']) {
    assert.ok(pkg.scripts.check.includes(part), `check does not run "${part}"`)
  }
})

test('every source, bin and test file is syntax checked by lint', async () => {
  const pkg = await manifest()
  const { readdir } = await import('node:fs/promises')
  for (const directory of ['src', 'bin', 'test']) {
    for (const name of await readdir(join(ROOT, directory))) {
      if (!name.endsWith('.mjs')) continue
      assert.ok(
        pkg.scripts.lint.includes(`${directory}/${name}`),
        `lint does not check ${directory}/${name}`,
      )
    }
  }
})

test('the package has no dependencies of any kind', async () => {
  const pkg = await manifest()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(pkg[field], undefined, `${field} is declared`)
  }
})
