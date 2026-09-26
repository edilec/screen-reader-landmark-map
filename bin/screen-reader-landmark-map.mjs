#!/usr/bin/env node

import { exitCodeFor, formatSummary, mapSnapshots, renderReport } from '../src/index.mjs'

const HELP = `screen-reader-landmark-map

Map the landmark roles and heading hierarchy of exported DOM snapshots, produce
a navigable outline, and report the structural problems a screen reader user
runs into. Nothing is fetched and no browser is opened.

Usage:
  screen-reader-landmark-map --snapshot FILE [--snapshot FILE ...]
                             [--out FILE] [--json] [limits]

Options:
  --snapshot FILE       HTML snapshot to map. Repeat for several documents;
                        their base names must differ, so a finding can say
                        which document it came from.
  --out FILE            Also write the JSON report to this path
  --json                Suppress the human summary on stderr
  --max-file-bytes N    Maximum bytes per snapshot (default 8388608)
  --max-elements N      Maximum elements parsed per snapshot (default 200000)
  --max-depth N         Maximum element nesting depth (default 256)
  --max-findings N      Maximum findings in a report (default 5000)
  -h, --help            Show this help

stdout always carries the JSON report and nothing else. The human summary goes
to stderr, where --json suppresses it.

--out is NOT confined to a root, because this tool has no root to confine it
to: the destination is whatever path you name, and a symbolically linked parent
directory on the way there is followed, exactly as it is for cp and for shell
redirection. Two things are still refused: a destination that is itself a
symbolic link, and a destination that is the same file as one of the snapshots,
which is checked by device and inode so that a hard link cannot disguise it.

This tool reads a BOUNDED SUBSET of HTML and refuses the rest rather than
guessing. It does not open a browser, does not run a screen reader, and does
not traverse shadow roots, iframes or SVG foreignObject content -- each of
those makes the run incomplete and names what was not read. What an assistive
technology actually announces requires separate manual evidence.

Exit codes:
  0  the structure passed and every snapshot was read completely
  1  the structure failed (duplicate unlabelled landmarks, a skipped heading
     level, an empty heading, a duplicated unique landmark)
  2  invalid usage or a refused destination (nothing on stdout), or unreadable
     or incomplete evidence (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-elements', 'maxElements'],
  ['--max-depth', 'maxDepth'],
  ['--max-findings', 'maxFindings'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { snapshots: [], out: null, json: false, limits: {} }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--snapshot') options.snapshots.push(takeValue('--snapshot'))
    else if (argument === '--out') options.out = takeValue('--out')
    else if (LIMIT_FLAGS.has(argument)) {
      const raw = takeValue(argument)
      if (!/^[0-9]+$/.test(raw) || Number(raw) < 1) {
        throw new Error(`${argument} requires a positive integer`)
      }
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.snapshots.length === 0) throw new Error('--snapshot is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    // A configuration error means the run never had a subject, so stdout stays
    // empty: a consumer piping JSON never receives a fabricated report.
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await mapSnapshots({
      snapshots: options.snapshots,
      limits: options.limits,
      out: options.out,
    })
  } catch (error) {
    // A refused destination is a configuration error too: the run was told to
    // write somewhere it will not write, so nothing is reported and nothing is
    // written.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
