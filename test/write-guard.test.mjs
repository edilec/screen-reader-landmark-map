import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { DestinationError, assertWritableDestination } from '../src/index.mjs'

/**
 * The destination guard, one test per hole and one per allowed case.
 *
 * Measured across this catalog rather than imagined: ten tools accepted a
 * destination that overwrote something they were never asked to touch, and
 * four of them exited 0 saying the write succeeded. One destroyed a file it
 * had just hashed.
 *
 * The holes are independent, and guarding one or two is what every one of
 * those tools had already done. A guard that refuses everything would pass a
 * data-loss test while making the tool useless, so the allowed cases are
 * pinned just as hard.
 *
 * This tool has NO confinement root, so the second row of the contract's table
 * -- a symbolically linked parent directory -- is not a hole here: following it
 * is what naming a path means, exactly as it does for cp. That behaviour is
 * documented in the help text, the README and the rule document, and it is
 * pinned below so the documentation and the code cannot drift apart.
 */

const CLI = resolve(import.meta.dirname, '..', 'bin', 'screen-reader-landmark-map.mjs')
const PAGE = '<main><h1>Catalogue</h1></main>'

function runCli(args) {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], (error, stdout, stderr) => {
      done({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr })
    })
  })
}

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'srlm-out-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'page.html'), PAGE)
  return directory
}

test('ALLOWED: a new path in an existing directory is written, and matches stdout', async (t) => {
  const directory = await workspace(t)
  const out = join(directory, 'report.json')
  const run = await runCli(['--snapshot', join(directory, 'page.html'), '--out', out, '--json'])
  assert.equal(run.code, 0)
  assert.equal(await readFile(out, 'utf8'), run.stdout)
})

test('ALLOWED: an existing regular file that is nothing to do with the run is overwritten', async (t) => {
  const directory = await workspace(t)
  const out = join(directory, 'report.json')
  await writeFile(out, 'stale')
  const run = await runCli(['--snapshot', join(directory, 'page.html'), '--out', out, '--json'])
  assert.equal(run.code, 0)
  assert.equal(await readFile(out, 'utf8'), run.stdout)
})

test('HOLE 1: a destination that is a symbolic link is refused, and its target survives', async (t) => {
  const directory = await workspace(t)
  const victim = join(directory, 'important.txt')
  await writeFile(victim, 'do not lose me')
  const out = join(directory, 'report.json')
  await symlink(victim, out)

  const run = await runCli(['--snapshot', join(directory, 'page.html'), '--out', out])
  assert.equal(run.code, 2)
  // A configuration error: the run was told to write somewhere it will not
  // write, so there is nothing to report about.
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /symbolic link/)
  assert.equal(await readFile(victim, 'utf8'), 'do not lose me')
})

test('DOCUMENTED: a symbolically linked parent directory is followed, because there is no root', async (t) => {
  const directory = await workspace(t)
  const real = join(directory, 'real-output')
  await mkdir(real)
  const linked = join(directory, 'linked-output')
  await symlink(real, linked)

  const run = await runCli([
    '--snapshot',
    join(directory, 'page.html'),
    '--out',
    join(linked, 'report.json'),
    '--json',
  ])
  assert.equal(run.code, 0)
  assert.equal(await readFile(join(real, 'report.json'), 'utf8'), run.stdout)
})

test('HOLE 3: a destination hard linked to a snapshot is refused, and the snapshot survives', async (t) => {
  const directory = await workspace(t)
  const snapshot = join(directory, 'page.html')
  const out = join(directory, 'report.json')
  // A hard link has no target to resolve and shares no path with the file it
  // duplicates, so realpath and string comparison both call it a different
  // file. Only device plus inode sees that it is the same file.
  await link(snapshot, out)

  const run = await runCli(['--snapshot', snapshot, '--out', out])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /same file as an input/)
  assert.equal(await readFile(snapshot, 'utf8'), PAGE)
})

test('HOLE 3 covers a snapshot the run RESOLVED but never opened', async (t) => {
  const directory = await workspace(t)
  const snapshot = join(directory, 'page.html')
  const out = join(directory, 'report.json')
  await link(snapshot, out)

  // The byte limit means this snapshot is never read. The path was still
  // resolved, so it belongs in the guard's input set: a lane planner in this
  // catalog passed only the files it opened and destroyed a source file it had
  // merely named.
  const run = await runCli(['--snapshot', snapshot, '--out', out, '--max-file-bytes', '4'])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.equal(await readFile(snapshot, 'utf8'), PAGE)
})

test('a destination in a directory that does not exist is refused', async (t) => {
  const directory = await workspace(t)
  const run = await runCli([
    '--snapshot',
    join(directory, 'page.html'),
    '--out',
    join(directory, 'nowhere', 'report.json'),
  ])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /does not exist/)
})

test('a destination that is a directory is refused', async (t) => {
  const directory = await workspace(t)
  const out = join(directory, 'somewhere')
  await mkdir(out)
  const run = await runCli(['--snapshot', join(directory, 'page.html'), '--out', out])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /not a regular file/)
})

test('a refused destination leaves the directory exactly as it was', async (t) => {
  const directory = await workspace(t)
  const victim = join(directory, 'important.txt')
  await writeFile(victim, 'do not lose me')
  const out = join(directory, 'report.json')
  await symlink(victim, out)

  const before = (await readdir(directory)).sort()
  await runCli(['--snapshot', join(directory, 'page.html'), '--out', out])
  assert.deepEqual((await readdir(directory)).sort(), before)
})

test('the guard raises DestinationError rather than a bare Error', async (t) => {
  const directory = await workspace(t)
  const out = join(directory, 'report.json')
  await symlink(join(directory, 'page.html'), out)
  await assert.rejects(
    () => assertWritableDestination(out, { inputs: [join(directory, 'page.html')], root: null }),
    DestinationError,
  )
})

test('the guard returns the resolved path for a destination it accepts', async (t) => {
  const directory = await workspace(t)
  const out = join(directory, 'report.json')
  const resolved = await assertWritableDestination(out, {
    inputs: [join(directory, 'page.html')],
    root: null,
  })
  assert.equal(resolved, out)
})

test('nothing is written when no --out is given', async (t) => {
  const directory = await workspace(t)
  const before = (await readdir(directory)).sort()
  const run = await runCli(['--snapshot', join(directory, 'page.html'), '--json'])
  assert.equal(run.code, 0)
  assert.deepEqual((await readdir(directory)).sort(), before)
})

test('a destination that cannot even be inspected is refused', async (t) => {
  const directory = await workspace(t)
  // The parent is a regular file, so lstat fails with ENOTDIR rather than
  // ENOENT: an error that is not "it does not exist yet" is a refusal, not a
  // green light.
  const out = join(directory, 'page.html', 'report.json')
  const run = await runCli(['--snapshot', join(directory, 'page.html'), '--out', out])
  assert.equal(run.code, 2)
  assert.equal(run.stdout, '')
  assert.match(run.stderr, /could not be inspected/)
})

test('the guard confines a destination when a caller DOES pass a root', async (t) => {
  // This tool passes null, and says so. The guard is copied verbatim, so the
  // root branch is pinned here rather than left to rot: a future caller that
  // does pass a root has to get confinement, and the branch is the only thing
  // that provides it.
  const directory = await workspace(t)
  const inside = join(directory, 'inside')
  const outside = join(directory, 'outside')
  await mkdir(inside)
  await mkdir(outside)

  assert.equal(
    await assertWritableDestination(join(inside, 'report.json'), { inputs: [], root: inside }),
    join(inside, 'report.json'),
  )
  await assert.rejects(
    () => assertWritableDestination(join(outside, 'report.json'), { inputs: [], root: inside }),
    /outside the permitted root/,
  )
  // A symbolically linked parent does not widen the root either.
  const linked = join(inside, 'linked')
  await symlink(outside, linked)
  await assert.rejects(
    () => assertWritableDestination(join(linked, 'report.json'), { inputs: [], root: inside }),
    /outside the permitted root/,
  )
})

test('the library refuses a call with no snapshots, by its own message', async () => {
  const { mapSnapshots } = await import('../src/index.mjs')
  await assert.rejects(() => mapSnapshots({}), /At least one --snapshot is required/)
  await assert.rejects(() => mapSnapshots({ snapshots: [] }), /At least one --snapshot is required/)
  await assert.rejects(() => mapSnapshots(), /At least one --snapshot is required/)
  await assert.rejects(() => mapSnapshots({ snapshots: [7] }), /Every --snapshot must be a path/)
  await assert.rejects(() => mapSnapshots({ snapshots: [''] }), /Every --snapshot must be a path/)
})

test('a snapshot path that is a directory is refused as unreadable', async (t) => {
  const directory = await workspace(t)
  const inner = join(directory, 'not-a-file')
  await mkdir(inner)
  const run = await runCli(['--snapshot', inner, '--json'])
  const report = JSON.parse(run.stdout)
  assert.equal(run.code, 2)
  assert.equal(report.findings[0].ruleId, 'snapshot-unreadable')
  assert.match(report.findings[0].message, /not a regular file/)
})
