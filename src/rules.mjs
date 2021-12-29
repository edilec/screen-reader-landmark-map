/**
 * Identity, bounds, sanitisation and the single severity table.
 *
 * Severity decides whether a run failed or passed, so it lives in exactly one
 * frozen table, every finding takes its value from there, and an unknown rule
 * id throws instead of defaulting to something harmless.
 * `docs/structure-rules.md` is asserted against this table in both directions,
 * and every rule is additionally driven through the real CLI so that the
 * observable exit code -- which no coordinated edit of three declarations can
 * change -- is what pins the severity.
 */

export const TOOL_ID = 'screen-reader-landmark-map'
export const REPORT_SCHEMA_VERSION = '1'

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** Explicit bounds. Each one is enforced, reported when hit, and tested. */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 8388608,
  maxElements: 200000,
  maxDepth: 256,
  maxFindings: 5000,
})

export const RULE_SEVERITY = Object.freeze({
  'depth-exceeded': 'error',
  'duplicate-attribute': 'info',
  'duplicate-id': 'warning',
  'duplicate-landmark-name': 'warning',
  'duplicate-unique-landmark': 'error',
  'duplicate-unlabelled-landmark': 'error',
  'empty-snapshot': 'error',
  'entity-unsupported': 'warning',
  'file-too-large': 'error',
  'first-heading-not-top-level': 'warning',
  'foreign-content-ignored': 'info',
  'foreign-content-skipped': 'warning',
  'heading-empty': 'error',
  'heading-level-skipped': 'error',
  'html-construct-unsupported': 'error',
  'iframe-content-unavailable': 'warning',
  'implied-end-tag': 'info',
  'landmark-role-redundant': 'info',
  'mismatched-end-tag': 'warning',
  'multiple-top-level-headings': 'warning',
  'name-reference-unresolved': 'warning',
  'no-heading': 'warning',
  'no-main-landmark': 'warning',
  'role-unknown': 'warning',
  'shadow-root-not-traversed': 'warning',
  'shadow-root-unknown': 'warning',
  'snapshot-undecodable': 'error',
  'snapshot-unreadable': 'error',
  'stray-end-tag': 'warning',
  'template-content-skipped': 'info',
  'too-many-elements': 'error',
  'too-many-findings': 'error',
  'unclosed-element': 'warning',
})

/**
 * Rules that force `status: "incomplete"`, declared as data rather than as
 * `incomplete = true` scattered through the code.
 *
 * Eleven of these are warnings. For those eleven this list is the ONLY thing
 * between a document the tool could not fully read and a green exit -- delete
 * one entry and the tool starts reporting a clean landmark map for a page
 * whose landmarks are inside a shadow root it never opened. Every entry gets a
 * real scenario in `test/incomplete.test.mjs`, asserted by exit code.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'depth-exceeded',
  'duplicate-id',
  'empty-snapshot',
  'entity-unsupported',
  'file-too-large',
  'foreign-content-skipped',
  'html-construct-unsupported',
  'iframe-content-unavailable',
  'mismatched-end-tag',
  'name-reference-unresolved',
  'role-unknown',
  'shadow-root-not-traversed',
  'shadow-root-unknown',
  'snapshot-undecodable',
  'snapshot-unreadable',
  'stray-end-tag',
  'too-many-elements',
  'too-many-findings',
  'unclosed-element',
])

const EVIDENCE_LIMIT = 160

// Everything a line-oriented consumer may treat as a line break or a control
// sequence, plus everything that can misrepresent the text it is printed in:
//
//   C0        U+0000-U+001F  newline, carriage return, ESC and the rest
//   DEL       U+007F
//   C1        U+0080-U+009F  U+0085 NEL ends a line for Python's splitlines,
//                            U+009B is the 8-bit CSI a terminal obeys
//   line/para U+2028, U+2029  a line break to several JSON consumers
//   bidi      U+200E, U+200F, U+202A-U+202E, U+2066-U+2069
//                            U+202E RIGHT-TO-LEFT OVERRIDE reverses everything
//                            printed after it, so one id can display as another
//
// Written as escape text and built with the RegExp constructor so no raw
// control byte is ever stored in this file. A snapshot is somebody's page: its
// ids, class names, headings and landmark labels are data, never instructions,
// and never a report line of their own.
const UNPRINTABLE = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]',
  'g',
)

/**
 * Characters that occupy no space when rendered. Used ONLY to decide whether
 * a heading or landmark label has anything left to announce, never to rewrite
 * the text that is reported.
 */
const RENDERS_NOTHING = new RegExp('[\\s\\p{Cc}\\p{Cf}]', 'gu')

/** Plain code-unit ordering. Locale collation varies with the ICU data a Node build ships. */
export function byCodeUnit(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

export function severityOf(ruleId) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) throw new TypeError(`Unknown ruleId "${ruleId}"`)
  return RULE_SEVERITY[ruleId]
}

export function forcesIncomplete(ruleId) {
  severityOf(ruleId)
  return INCOMPLETE_RULES.includes(ruleId)
}

/**
 * Describe a value without ever calling `String()` on an object.
 *
 * `String({toString: {}})` THROWS: the property exists, so the object is not
 * treated as plain, and a non-callable `toString` is a TypeError. Anything
 * that is not already a string is described by its shape rather than
 * reproduced, so no single odd value can abort a run at this boundary.
 */
export function describeValue(value) {
  if (typeof value === 'string') return value
  if (value === null) return '[null]'
  if (value === undefined) return '[undefined]'
  const type = typeof value
  if (type === 'number' || type === 'boolean' || type === 'bigint') return `${value}`
  if (type === 'symbol') return '[symbol]'
  if (type === 'function') return '[function]'
  if (Array.isArray(value)) return `[array of ${value.length}]`
  return '[object]'
}

/** Flatten everything that could end a line or reverse one. */
export function singleLine(value) {
  return describeValue(value).replace(UNPRINTABLE, ' ')
}

/** A bounded, flattened excerpt. Snapshot content is data, never an instruction. */
export function excerpt(value) {
  const flattened = singleLine(value).trim()
  if (flattened.length <= EVIDENCE_LIMIT) return flattened
  return `${flattened.slice(0, EVIDENCE_LIMIT)}...`
}

/** Text as it will actually be reported: unprintables flattened, whitespace collapsed. */
export function renderText(value) {
  return singleLine(value).replace(new RegExp('\\s+', 'gu'), ' ').trim()
}

/**
 * Is there anything left to announce?
 *
 * `value.trim().length > 0` is the wrong question: `trim` removes ECMAScript
 * whitespace only, so a heading of U+0001, U+0085 or U+200E passes it and then
 * renders as the empty string. This asks about the RENDERED form.
 */
export function isPerceivable(value) {
  return renderText(value).replace(RENDERS_NOTHING, '').length > 0
}

export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Build one finding. Severity is never passed in: it is looked up, so no
 * construction site can quietly downgrade a refusal.
 */
export function makeFinding({ ruleId, message, file, pointer, evidence, suggestion }) {
  const location = {}
  if (typeof file === 'string' && file !== '') location.file = singleLine(file)
  if (typeof pointer === 'string' && pointer !== '') location.pointer = singleLine(pointer)

  const finding = {
    ruleId,
    severity: severityOf(ruleId),
    message: singleLine(message),
    location,
  }
  if (evidence !== undefined) finding.evidence = excerpt(evidence)
  if (suggestion !== undefined) finding.suggestion = singleLine(suggestion)
  return finding
}

/** Documented order: location.file, then location.pointer, then ruleId, then message. */
export function sortFindings(findings) {
  return [...findings].sort(
    (left, right) =>
      byCodeUnit(left.location.file ?? '', right.location.file ?? '') ||
      byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '') ||
      byCodeUnit(left.ruleId, right.ruleId) ||
      byCodeUnit(left.message, right.message),
  )
}

export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}
