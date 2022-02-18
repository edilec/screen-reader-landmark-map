/**
 * screen-reader-landmark-map
 *
 * Reads exported DOM snapshots, extracts the landmark roles and the heading
 * hierarchy, and produces a navigable outline plus the structural findings a
 * screen reader user would run into -- most of all two navigation regions that
 * cannot be told apart, and a heading level that was skipped.
 *
 * Everything here is DOM-based evidence. No browser is opened, no assistive
 * technology is run, nothing is fetched and nothing is measured. The outline is
 * document order, not announcement order. Where the markup was not fully read
 * -- a shadow root, an iframe, a custom element whose internals are not in the
 * file, markup outside the parser's declared subset -- the run is INCOMPLETE
 * and exits 2, because a landmark map that reports "one navigation region" for
 * a page whose other three are inside a web component is worse than no map.
 */

import { basename, resolve } from 'node:path'
import { open, writeFile } from 'node:fs/promises'

import {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  REPORT_SCHEMA_VERSION,
  TOOL_ID,
  excerpt,
  makeFinding,
  singleLine,
  sortFindings,
  validateLimits,
} from './rules.mjs'
import { HtmlError, duplicatedIds, parseHtml } from './html.mjs'
import { findDuplicateLandmarks, findHeadingProblems, mapStructure } from './structure.mjs'
import { DestinationError, assertWritableDestination } from './write-guard.mjs'

export {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  REPORT_SCHEMA_VERSION,
  RULE_SEVERITY,
  SEVERITIES,
  TOOL_ID,
  byCodeUnit,
  describeValue,
  excerpt,
  forcesIncomplete,
  isPerceivable,
  renderText,
  severityOf,
  singleLine,
  sortFindings,
  validateLimits,
} from './rules.mjs'
export {
  HtmlError,
  NAMED_REFERENCES,
  OPTIONAL_END_TAG,
  VOID_ELEMENTS,
  decodeReferences,
  duplicatedIds,
  parseHtml,
} from './html.mjs'
export {
  KNOWN_ROLES,
  LANDMARK_ROLES,
  REPEATABLE_LANDMARK_ROLES,
  UNIQUE_LANDMARK_ROLES,
  accessibleName,
  contributedText,
  findDuplicateLandmarks,
  findHeadingProblems,
  headingLevel,
  implicitLandmarkRole,
  mapStructure,
} from './structure.mjs'
export { DestinationError, assertWritableDestination } from './write-guard.mjs'

/** Raised for a configuration error: exit 2, empty stdout, message on stderr. */
export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * The sentence the report will not let a reader lose, backed by behaviour:
 * everywhere the markup cannot settle a question, the run is incomplete and
 * exits 2 rather than narrowing what it checked and passing.
 */
export const EVIDENCE_NOTE =
  'This map is built from exported DOM snapshots read with a bounded HTML subset. No browser is '
  + 'opened and no assistive technology is run, so the outline is document order rather than '
  + 'announcement order, and what a screen reader actually announces requires separate manual '
  + 'evidence.'

const PROBLEM_MESSAGE = Object.freeze({
  'duplicate-attribute': (detail) =>
    `The attribute "${excerpt(detail)}" is given more than once on one element; the first value was used, as a browser would.`,
  'duplicate-landmark-name': (detail) => `${excerpt(detail)}, so they cannot be told apart by name.`,
  'duplicate-unique-landmark': (detail) =>
    `${excerpt(detail)}; this role is expected at most once in a document.`,
  'duplicate-unlabelled-landmark': (detail) =>
    `${excerpt(detail)}, so a screen reader's landmark list shows several identical entries and none of them says which is which.`,
  'entity-unsupported': (detail) =>
    `The character reference ${excerpt(detail)} is outside the set this tool decodes, so the text around it was left exactly as written rather than guessed at.`,
  'first-heading-not-top-level': (detail) =>
    `${excerpt(detail)}, so the document has no level 1 heading to start from.`,
  'foreign-content-ignored': (detail) =>
    `The <${excerpt(detail)}> subtree was not walked into; ARIA landmarks and HTML headings are not defined there.`,
  'foreign-content-skipped': (detail) =>
    `The <${excerpt(detail)}> subtree holds a foreignObject, which can contain HTML this tool did not read, so any landmark or heading inside it is missing from this map.`,
  'heading-empty': (detail) => `${excerpt(detail)}, so it announces as an unlabelled heading.`,
  'heading-level-skipped': (detail) =>
    `${excerpt(detail)}, so the hierarchy skips a level and a screen reader user cannot tell what the deeper heading belongs to.`,
  'html-construct-unsupported': (detail) =>
    `The element <${excerpt(detail)}> uses XML self-closing syntax, which means one thing in HTML and another in XML; this tool follows HTML and reports that the document left the subset it reads.`,
  'iframe-content-unavailable': () =>
    'An iframe is a separate document and its content is not in this file, so any landmark or heading inside it is missing from this map.',
  'implied-end-tag': (detail) =>
    `An end tag was implied: ${excerpt(detail)}. This is ordinary HTML and the structure below is unaffected.`,
  'landmark-role-redundant': (detail) =>
    `The role attribute repeats the implicit role: ${excerpt(detail)}.`,
  'mismatched-end-tag': (detail) =>
    `An end tag does not nest: ${excerpt(detail)}. The element whose end tag is not optional was closed by it, so the structure below this point may not be what the page renders.`,
  'multiple-top-level-headings': (detail) =>
    `The document declares ${excerpt(detail)}, so there is no single top of the hierarchy.`,
  'name-reference-unresolved': (detail) =>
    `An aria-labelledby reference names nothing this document contains, or names an id more than one element carries: ${excerpt(detail)}.`,
  'no-heading': () =>
    'The document declares no heading at all, so there is no hierarchy to navigate.',
  'role-unknown': (detail) =>
    `The role "${excerpt(detail)}" is not one this tool recognises, so whether the element is a landmark is unknown and its subtree was not mapped.`,
  'shadow-root-not-traversed': (detail) =>
    `A serialised ${excerpt(detail)} shadow root is present. Its composed position depends on slot assignment, which a snapshot does not record, so it was not traversed and any landmark or heading inside it is missing from this map.`,
  'stray-end-tag': (detail) =>
    `The end tag </${excerpt(detail)}> matches nothing that is open, so the markup does not nest as written and the structure around it may not be what the page renders.`,
  'template-content-skipped': () =>
    'A template element was not walked into; its content is inert until a script clones it.',
  'unclosed-element': (detail) =>
    `<${excerpt(detail)}> is never closed, so everything after it may sit at the wrong depth.`,
})

const PROBLEM_SUGGESTION = Object.freeze({
  'duplicate-unlabelled-landmark': 'Give each one an aria-label, or a heading referenced with aria-labelledby.',
  'entity-unsupported': 'Replace it with a numeric character reference, or with the character itself.',
  'foreign-content-skipped': 'Map the HTML inside the foreignObject separately.',
  'heading-empty': 'Give the heading text, or remove it if it is decorative.',
  'heading-level-skipped': 'Use the next level down, or restructure the section.',
  'html-construct-unsupported': 'Write the element with a real end tag.',
  'iframe-content-unavailable': 'Export and map the framed document separately.',
  'mismatched-end-tag': 'Correct the nesting, then export the snapshot again.',
  'name-reference-unresolved': 'Export the element carrying that id, or correct the reference.',
  'role-unknown': 'Check the role spelling, or upgrade the tool if the role is newer than it is.',
  'shadow-root-not-traversed': 'Map the component separately, and confirm its landmarks there.',
  'shadow-root-unknown': 'Export with serialisable shadow roots, or map the component separately.',
  'stray-end-tag': 'Remove the stray end tag, then export the snapshot again.',
  'unclosed-element': 'Close the element, then export the snapshot again.',
})

function problemToFinding(problem, file) {
  const build = PROBLEM_MESSAGE[problem.ruleId]
  if (build === undefined) throw new TypeError(`Unknown problem "${problem.ruleId}"`)
  return makeFinding({
    ruleId: problem.ruleId,
    message: build(problem.detail ?? ''),
    file,
    pointer: problem.pointer,
    suggestion: PROBLEM_SUGGESTION[problem.ruleId],
  })
}

function tally(findings) {
  const counted = { errors: 0, warnings: 0, info: 0, incomplete: false }
  for (const finding of findings) {
    if (finding.severity === 'error') counted.errors += 1
    else if (finding.severity === 'warning') counted.warnings += 1
    else counted.info += 1
    if (INCOMPLETE_RULES.includes(finding.ruleId)) counted.incomplete = true
  }
  return counted
}

function dedupe(findings) {
  const seen = new Set()
  const kept = []
  for (const finding of findings) {
    const key = JSON.stringify([
      finding.ruleId,
      finding.location.file ?? '',
      finding.location.pointer ?? '',
      finding.message,
    ])
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(finding)
  }
  return kept
}

async function readSnapshot(file, limits) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch (error) {
    throw new HtmlError(
      'snapshot-unreadable',
      `The snapshot could not be opened: ${singleLine(error.code ?? 'unknown error')}.`,
    )
  }
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) {
      throw new HtmlError('snapshot-unreadable', 'The snapshot path is not a regular file.')
    }
    if (stats.size > limits.maxFileBytes) {
      throw new HtmlError(
        'file-too-large',
        `The snapshot is ${stats.size} bytes, over the ${limits.maxFileBytes} byte limit, so it was not read.`,
      )
    }
    const bytes = await handle.readFile()
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new HtmlError(
        'snapshot-undecodable',
        'The snapshot is not valid UTF-8, so nothing in it could be read.',
      )
    }
  } finally {
    await handle.close()
  }
}

function analyseDocument(source, file, limits) {
  const findings = []
  let parsed
  try {
    parsed = parseHtml(source, limits)
  } catch (error) {
    if (!(error instanceof HtmlError)) throw error
    return {
      findings: [makeFinding({ ruleId: error.ruleId, message: error.message, file, evidence: error.evidence })],
      outline: [],
      counts: { elements: 0, landmarks: 0, headings: 0, unresolvedNames: 0, unreadRegions: 0 },
    }
  }

  for (const problem of parsed.problems) findings.push(problemToFinding(problem, file))

  for (const id of duplicatedIds(parsed.byId)) {
    findings.push(
      makeFinding({
        ruleId: 'duplicate-id',
        message: `More than one element carries id "${excerpt(id)}", so every aria-labelledby reference to it is ambiguous.`,
        file,
        pointer: (parsed.byId.get(id) ?? [])[0]?.path,
        suggestion: 'Make the id unique, then export the snapshot again.',
      }),
    )
  }

  // A custom element may hold a shadow root this file does not contain, and a
  // landmark inside one is invisible here. Saying nothing would be reporting a
  // map of a page the tool only partly saw.
  for (const element of parsed.elements) {
    if (!element.tag.includes('-')) continue
    const serialised = element.children.some(
      (child) =>
        child.kind === 'element' &&
        child.tag === 'template' &&
        typeof child.attributes.get('shadowrootmode') === 'string',
    )
    if (serialised) continue
    element.unread = true
    findings.push(
      makeFinding({
        ruleId: 'shadow-root-unknown',
        message: `<${excerpt(element.tag)}> is a custom element with no serialised shadow root in this file. It may hold one, and any landmark or heading inside it is missing from this map.`,
        file,
        pointer: element.path,
        suggestion: PROBLEM_SUGGESTION['shadow-root-unknown'],
      }),
    )
  }

  const structure = mapStructure(parsed.root, parsed.byId)
  for (const problem of structure.problems) findings.push(problemToFinding(problem, file))
  for (const problem of findDuplicateLandmarks(structure.landmarks)) {
    findings.push(problemToFinding(problem, file))
  }
  for (const problem of findHeadingProblems(structure.headings, structure.unread)) {
    findings.push(problemToFinding(problem, file))
  }

  // "This document declares no main landmark" is a claim about the whole
  // document, and a main landmark inside a shadow root, an iframe or a
  // subtree whose role is unknown is exactly the evidence this run does not
  // have. The regions themselves are reported and the run is incomplete, so
  // nothing is passed over in silence -- what is withheld is the verdict.
  if (structure.unread === 0 && !structure.landmarks.some((landmark) => landmark.role === 'main')) {
    findings.push(
      makeFinding({
        ruleId: 'no-main-landmark',
        message:
          'The document declares no main landmark, so there is nothing for a screen reader user to jump to in order to skip the page furniture.',
        file,
        suggestion: 'Wrap the primary content in a <main> element.',
      }),
    )
  }

  const unreadRules = [
    'shadow-root-not-traversed',
    'shadow-root-unknown',
    'iframe-content-unavailable',
    'foreign-content-skipped',
  ]
  return {
    findings,
    outline: structure.outline.map((entry) => ({
      kind: entry.kind,
      depth: entry.depth,
      role: entry.kind === 'landmark' ? singleLine(entry.role) : undefined,
      level: entry.kind === 'heading' ? entry.level : undefined,
      name: entry.name === null ? null : excerpt(entry.name),
      pointer: singleLine(entry.pointer),
    })),
    counts: {
      elements: parsed.elements.length,
      landmarks: structure.landmarks.length,
      headings: structure.headings.length,
      unresolvedNames:
        structure.landmarks.filter((landmark) => !landmark.determined).length +
        structure.headings.filter((heading) => !heading.determined).length,
      unreadRegions: findings.filter((finding) => unreadRules.includes(finding.ruleId)).length,
    },
  }
}

/**
 * Assemble the envelope. `status` is derived HERE and nowhere else: incomplete
 * whenever any emitted rule is in INCOMPLETE_RULES, otherwise fail when
 * anything is an error, otherwise pass. One choke point means no code path can
 * reach "pass" carrying evidence it never obtained.
 */
function buildReport({ findings, documents, counts, limits }) {
  let ordered = sortFindings(dedupe(findings))
  if (ordered.length > limits.maxFindings) {
    const dropped = ordered.length - limits.maxFindings
    ordered = ordered.slice(0, limits.maxFindings)
    ordered.push(
      makeFinding({
        ruleId: 'too-many-findings',
        message: `The report exceeds the ${limits.maxFindings} finding limit; ${dropped} finding(s) were not reported.`,
        suggestion: 'Raise --max-findings, or fix the reported problems and run again.',
      }),
    )
  }

  let { errors, warnings, info, incomplete } = tally(ordered)
  // Green on no evidence is a defect, not a pass.
  if (!incomplete && errors === 0 && counts.checked === 0) {
    ordered = sortFindings([
      ...ordered,
      makeFinding({
        ruleId: 'empty-snapshot',
        message: 'No element was read, so this run has no evidence to pass on.',
        suggestion: 'Supply a snapshot that holds the markup you want mapped.',
      }),
    ])
    ;({ errors, warnings, info, incomplete } = tally(ordered))
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: { ...counts, errors, warnings, info },
    basis: {
      kind: 'exported-dom-snapshot',
      parser: 'bounded-html-subset',
      emulatesScreenReader: false,
      note: EVIDENCE_NOTE,
    },
    documents,
    findings: ordered,
  }
}

/** Map one or more snapshots. Reads them, writes nothing unless `out` is given. */
export async function mapSnapshots({ snapshots, limits: overrides = {}, out = null } = {}) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    throw new ConfigError('At least one --snapshot is required')
  }
  const limits = validateLimits(overrides)

  // A snapshot's file name is somebody's file name: untrusted text that ends
  // up in `location.file`, in `documents[].file` and on a line of the human
  // summary. It is flattened HERE, once, and the flattened form is what the
  // run is keyed on -- so two names that differ only in characters this tool
  // strips are refused as a collision rather than reported as one name twice,
  // which is the very thing the check below exists to prevent.
  const names = new Map()
  for (const snapshot of snapshots) {
    if (typeof snapshot !== 'string' || snapshot === '') {
      throw new ConfigError('Every --snapshot must be a path')
    }
    const name = singleLine(basename(snapshot))
    if (names.has(name)) {
      throw new ConfigError(
        `Two snapshots are both named "${name}", so a finding could not say which one it came from. Rename one, or run them separately.`,
      )
    }
    names.set(name, snapshot)
  }

  // Every path the run RESOLVES belongs in the write guard's input set, and it
  // is recorded BEFORE the read, so a read that then fails does not leave the
  // destination check narrower than the run.
  const resolvedInputs = snapshots.map((snapshot) => resolve(snapshot))
  let destination = null
  if (out !== null) {
    try {
      destination = await assertWritableDestination(out, { inputs: resolvedInputs, root: null })
    } catch (error) {
      if (error instanceof DestinationError) throw new ConfigError(error.message)
      throw error
    }
  }

  const findings = []
  const documents = []
  const counts = {
    checked: 0,
    documents: snapshots.length,
    landmarks: 0,
    headings: 0,
    unresolvedNames: 0,
    unreadRegions: 0,
  }

  for (const [name, snapshot] of names) {
    let source
    try {
      source = await readSnapshot(snapshot, limits)
    } catch (error) {
      if (!(error instanceof HtmlError)) throw error
      findings.push(makeFinding({ ruleId: error.ruleId, message: error.message, file: name }))
      documents.push({ file: name, outline: [] })
      continue
    }
    const analysed = analyseDocument(source, name, limits)
    findings.push(...analysed.findings)
    documents.push({ file: name, outline: analysed.outline })
    counts.checked += analysed.counts.elements
    counts.landmarks += analysed.counts.landmarks
    counts.headings += analysed.counts.headings
    counts.unresolvedNames += analysed.counts.unresolvedNames
    counts.unreadRegions += analysed.counts.unreadRegions
  }

  const report = buildReport({ findings, documents, counts, limits })
  if (destination !== null) await writeFile(destination, renderReport(report))
  return report
}

export function renderReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

const SEVERITY_LABEL = Object.freeze({ error: 'ERROR  ', warning: 'WARNING', info: 'INFO   ' })

export function formatSummary(report) {
  const lines = [`${report.tool}: status ${report.status}`]
  const summary = report.summary
  lines.push(
    `${summary.documents} document(s), ${summary.checked} element(s); ${summary.landmarks} landmark(s), ${summary.headings} heading(s).`,
  )
  lines.push(
    `${summary.unresolvedNames} unresolved name(s), ${summary.unreadRegions} region(s) this snapshot does not contain.`,
  )
  lines.push(`${summary.errors} error, ${summary.warnings} warning, ${summary.info} info.`)
  lines.push(report.basis.note)
  for (const document of report.documents) {
    lines.push(`outline ${document.file}`)
    for (const entry of document.outline) {
      const indent = '  '.repeat(entry.depth + 1)
      const label = entry.kind === 'landmark' ? entry.role : `h${entry.level}`
      const name = entry.name === null ? '(name undetermined)' : `"${entry.name}"`
      lines.push(`${indent}${label} ${name} ${entry.pointer}`)
    }
  }
  for (const finding of report.findings) {
    const where = [finding.location.file ?? '', finding.location.pointer ?? '']
      .filter((part) => part !== '')
      .join(' ')
    lines.push(`${SEVERITY_LABEL[finding.severity]} ${where} ${finding.ruleId} ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'incomplete') return 2
  return report.status === 'fail' ? 1 : 0
}
