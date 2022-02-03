/**
 * A BOUNDED, EXPLICIT subset of HTML. This is not an HTML parser.
 *
 * A real HTML parser implements insertion modes, foster parenting, adoption
 * agency, and a table of over two thousand character references. This reads
 * the part of the grammar a serialised DOM snapshot actually contains, and
 * REFUSES the rest. A construct outside the subset does not get a best guess:
 * it is reported, and it makes the run incomplete, because a landmark map
 * built on markup the tool misread is worse than no map.
 *
 * WHAT IT HANDLES
 *   start tags, end tags, and attributes quoted with " or ' or unquoted
 *   comments, and the doctype
 *   the void elements, listed below
 *   raw text elements: script, style, iframe, noscript
 *   escapable raw text elements: title, textarea
 *   the optional end tags that real markup omits: p, li, dd, dt, option,
 *     optgroup, tr, td, th, thead, tbody, tfoot, rt, rp, head, body, html
 *   the named character references listed below, plus numeric references
 *
 * WHAT IT REFUSES, EACH WITH ITS OWN RULE
 *   CDATA sections and processing instructions   html-construct-unsupported
 *   an unterminated tag, comment or quoted value html-construct-unsupported
 *   XML self-closing syntax on a non-void element html-construct-unsupported
 *   an end tag matching nothing that is open      stray-end-tag
 *   an end tag that would close across an element  mismatched-end-tag
 *     whose end tag is not optional
 *   an element still open at the end of the input  unclosed-element
 *   a named character reference outside the list   entity-unsupported
 *
 * WHAT IT DOES NOT SEE, AND SAYS SO
 *   shadow roots, serialised or not                shadow-root-not-traversed
 *                                                  shadow-root-unknown
 *   the content of an iframe, which is another      iframe-content-unavailable
 *     document and is not in this file
 *   HTML inside an SVG foreignObject                foreign-content-skipped
 */

import { excerpt, isRecord, singleLine } from './rules.mjs'

/** A refusal that stops the parse, carrying the rule id the report records. */
export class HtmlError extends Error {
  constructor(ruleId, message, evidence) {
    super(message)
    this.name = 'HtmlError'
    this.ruleId = ruleId
    this.evidence = evidence
  }
}

export const VOID_ELEMENTS = Object.freeze([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track',
  'wbr',
])

/** Content is text, never markup, until the matching end tag. */
const RAW_TEXT = Object.freeze(['script', 'style', 'iframe', 'noscript'])

/** Content is text with character references, never markup. */
const ESCAPABLE_RAW_TEXT = Object.freeze(['title', 'textarea'])

/** Subtrees this subset does not walk into. */
const OPAQUE = Object.freeze(['svg', 'math', 'template'])

/** Elements whose end tag real markup is allowed to omit. */
export const OPTIONAL_END_TAG = Object.freeze([
  'body', 'dd', 'dt', 'head', 'html', 'li', 'optgroup', 'option', 'p', 'rp', 'rt', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr',
])

/** Opening any of these closes an open `p`. */
const CLOSES_P = Object.freeze([
  'address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dd', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup',
  'hr', 'li', 'main', 'menu', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'search', 'section',
  'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])

/** Opening the key closes an open element whose tag is in the value. */
const CLOSES_SIBLING = Object.freeze({
  dd: ['dd', 'dt'],
  dt: ['dd', 'dt'],
  li: ['li'],
  optgroup: ['optgroup', 'option'],
  option: ['option'],
  rp: ['rp', 'rt'],
  rt: ['rp', 'rt'],
  tbody: ['tbody', 'tfoot', 'thead', 'td', 'th', 'tr'],
  td: ['td', 'th'],
  tfoot: ['tbody', 'tfoot', 'thead', 'td', 'th', 'tr'],
  th: ['td', 'th'],
  thead: ['td', 'th', 'tr'],
  tr: ['td', 'th', 'tr'],
})

/**
 * The named character references this subset decodes. Anything else is left
 * exactly as it was written and reported, because silently passing `&foo;`
 * through would put the wrong text in a heading and the wrong label on a
 * landmark.
 */
export const NAMED_REFERENCES = Object.freeze({
  amp: '&', apos: "'", bull: '\u2022', cent: '\u00a2', copy: '\u00a9', dagger: '\u2020',
  darr: '\u2193', deg: '\u00b0', ndash: '\u2013', mdash: '\u2014', emsp: '\u2003',
  ensp: '\u2002', euro: '\u20ac', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be',
  ge: '\u2265', gt: '>', harr: '\u2194', hellip: '\u2026', laquo: '\u00ab', larr: '\u2190',
  ldquo: '\u201c', le: '\u2264', lsquo: '\u2018', lt: '<', micro: '\u00b5', middot: '\u00b7',
  nbsp: '\u00a0', ne: '\u2260', para: '\u00b6', permil: '\u2030', plusmn: '\u00b1',
  pound: '\u00a3', prime: '\u2032', quot: '"', raquo: '\u00bb', rarr: '\u2192', rdquo: '\u201d',
  reg: '\u00ae', rsquo: '\u2019', sect: '\u00a7', shy: '\u00ad', sup2: '\u00b2', sup3: '\u00b3',
  thinsp: '\u2009', times: '\u00d7', trade: '\u2122', uarr: '\u2191', yen: '\u00a5',
})

const TAG_START = /^<([a-zA-Z][^\s/>]*)/
const END_TAG = /^<\/([a-zA-Z][^\s/>]*)\s*>/
const ATTRIBUTE_NAME = /^[^\s/>=]+/
const REFERENCE = /&(?:#([0-9]+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g

/**
 * Decode the character references this subset knows.
 *
 * `problems` receives one entry per reference it does not know. The text is
 * left exactly as written in that case: guessing is how a heading ends up
 * reported under a name the page never had.
 */
export function decodeReferences(text, problems, pointer) {
  if (!text.includes('&')) return text
  return text.replace(REFERENCE, (whole, decimal, hexadecimal, name) => {
    if (decimal !== undefined || hexadecimal !== undefined) {
      const code = Number.parseInt(decimal ?? hexadecimal, decimal !== undefined ? 10 : 16)
      if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        problems.push({ ruleId: 'entity-unsupported', detail: whole, pointer })
        return whole
      }
      return String.fromCodePoint(code)
    }
    if (Object.hasOwn(NAMED_REFERENCES, name)) return NAMED_REFERENCES[name]
    problems.push({ ruleId: 'entity-unsupported', detail: whole, pointer })
    return whole
  })
}

function lower(value) {
  return value.toLowerCase()
}

/**
 * Parse one snapshot into a tree.
 *
 * Throws `HtmlError` when the input leaves the subset in a way that stops the
 * parse. Everything else lands in `problems`, which the caller turns into
 * findings; several of those rules force the run incomplete, which is how a
 * document this subset only partly read stops being reportable as clean.
 */
export function parseHtml(source, limits) {
  if (typeof source !== 'string') throw new TypeError('The snapshot text must be a string')
  if (!isRecord(limits)) throw new TypeError('Limits must be an object')

  const root = { kind: 'element', tag: '#document', attributes: new Map(), children: [], parent: null, path: '' }
  const stack = [root]
  const elements = []
  const byId = new Map()
  const problems = []

  let index = 0
  let pending = ''

  const top = () => stack[stack.length - 1]

  const flushText = () => {
    if (pending === '') return
    const parent = top()
    parent.children.push({
      kind: 'text',
      text: decodeReferences(pending, problems, parent.path),
      parent,
    })
    pending = ''
  }

  const appendElement = (tag, attributes) => {
    const parent = top()
    let ordinal = 0
    for (const child of parent.children) if (child.kind === 'element' && child.tag === tag) ordinal += 1
    const element = {
      kind: 'element',
      tag,
      attributes,
      children: [],
      parent,
      path: `${parent.path}/${tag}[${ordinal + 1}]`,
    }
    parent.children.push(element)
    elements.push(element)
    if (elements.length > limits.maxElements) {
      throw new HtmlError(
        'too-many-elements',
        `The snapshot holds more than ${limits.maxElements} elements, so it was not mapped.`,
      )
    }
    const id = attributes.get('id')
    if (typeof id === 'string' && id !== '') {
      const seen = byId.get(id)
      if (seen === undefined) byId.set(id, [element])
      else seen.push(element)
    }
    return element
  }

  const push = (element) => {
    stack.push(element)
    if (stack.length - 1 > limits.maxDepth) {
      throw new HtmlError(
        'depth-exceeded',
        `The snapshot nests deeper than ${limits.maxDepth} levels at ${singleLine(element.path)}, so it was not mapped.`,
      )
    }
  }

  /** Apply the documented implied-end-tag table before opening `tag`. */
  const closeImplied = (tag) => {
    for (;;) {
      const current = top()
      if (current === root) return
      if (tag === 'p' || CLOSES_P.includes(tag)) {
        if (current.tag === 'p') {
          stack.pop()
          continue
        }
      }
      const siblings = Object.hasOwn(CLOSES_SIBLING, tag) ? CLOSES_SIBLING[tag] : null
      if (siblings !== null && siblings.includes(current.tag)) {
        stack.pop()
        continue
      }
      return
    }
  }

  /**
   * Consume to the matching end tag of `tag`. Returns the raw inside.
   *
   * `nestable` matters: `template`, `svg` and `math` can contain another of
   * themselves, so their end tag has to be counted. A raw text element cannot
   * -- `<script>` holds text, not elements -- so counting there would treat the
   * string `"<script>"` inside a script as a real nested element and run off
   * the end of the document looking for a second end tag.
   */
  const skipTo = (tag, from, nestable = false) => {
    const open = new RegExp(`<${tag}(?=[\\s/>])`, 'gi')
    const close = new RegExp(`</${tag}\\s*>`, 'gi')
    let depth = 1
    let cursor = from
    for (;;) {
      close.lastIndex = cursor
      const end = close.exec(source)
      if (end === null) return null
      let nested = 0
      if (nestable) {
        open.lastIndex = cursor
        let match
        while ((match = open.exec(source)) !== null && match.index < end.index) nested += 1
      }
      depth += nested - 1
      cursor = end.index + end[0].length
      if (depth <= 0) return { inside: source.slice(from, end.index), next: cursor }
    }
  }

  while (index < source.length) {
    const character = source[index]
    if (character !== '<') {
      const next = source.indexOf('<', index)
      pending += next === -1 ? source.slice(index) : source.slice(index, next)
      index = next === -1 ? source.length : next
      continue
    }

    const rest = source.slice(index)

    if (rest.startsWith('<!--')) {
      const end = source.indexOf('-->', index + 4)
      if (end === -1) {
        throw new HtmlError('html-construct-unsupported', 'A comment is never closed.')
      }
      index = end + 3
      continue
    }
    if (/^<!\[CDATA\[/.test(rest)) {
      throw new HtmlError(
        'html-construct-unsupported',
        'A CDATA section is outside the subset this tool reads.',
      )
    }
    if (rest.startsWith('<?')) {
      throw new HtmlError(
        'html-construct-unsupported',
        'A processing instruction is outside the subset this tool reads.',
      )
    }
    if (/^<!doctype/i.test(rest)) {
      const end = source.indexOf('>', index)
      if (end === -1) throw new HtmlError('html-construct-unsupported', 'A doctype is never closed.')
      index = end + 1
      continue
    }
    if (rest.startsWith('<!')) {
      throw new HtmlError(
        'html-construct-unsupported',
        'A markup declaration this tool does not read starts here.',
        rest.slice(0, 24),
      )
    }

    const closing = END_TAG.exec(rest)
    if (closing !== null) {
      flushText()
      const tag = lower(closing[1])
      index += closing[0].length
      if (VOID_ELEMENTS.includes(tag)) {
        problems.push({ ruleId: 'stray-end-tag', detail: tag, pointer: top().path })
        continue
      }
      let depth = -1
      for (let position = stack.length - 1; position >= 1; position -= 1) {
        if (stack[position].tag === tag) {
          depth = position
          break
        }
      }
      if (depth === -1) {
        problems.push({ ruleId: 'stray-end-tag', detail: tag, pointer: top().path })
        continue
      }
      const crossed = stack.slice(depth + 1).map((element) => element.tag)
      const unexpected = crossed.filter((name) => !OPTIONAL_END_TAG.includes(name))
      if (unexpected.length > 0) {
        problems.push({
          ruleId: 'mismatched-end-tag',
          detail: `${tag} closes across ${unexpected.join(', ')}`,
          pointer: stack[depth].path,
        })
      } else if (crossed.length > 0) {
        problems.push({
          ruleId: 'implied-end-tag',
          detail: `${crossed.join(', ')} closed by ${tag}`,
          pointer: stack[depth].path,
        })
      }
      stack.length = depth
      continue
    }

    const opening = TAG_START.exec(rest)
    if (opening === null) {
      pending += '<'
      index += 1
      continue
    }

    flushText()
    const tag = lower(opening[1])
    let cursor = index + opening[0].length
    const attributes = new Map()
    // A repeated attribute is reported against the element that carries it,
    // so the notes wait until the element exists: its path depends on the
    // parent, which the implied-end-tag table may still change.
    const repeated = []
    let selfClosing = false

    for (;;) {
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1
      if (cursor >= source.length) {
        throw new HtmlError('html-construct-unsupported', `The <${singleLine(tag)}> tag is never closed.`)
      }
      if (source[cursor] === '>') {
        cursor += 1
        break
      }
      if (source[cursor] === '/' && source[cursor + 1] === '>') {
        selfClosing = true
        cursor += 2
        break
      }
      const name = ATTRIBUTE_NAME.exec(source.slice(cursor))
      if (name === null) {
        throw new HtmlError(
          'html-construct-unsupported',
          `The <${singleLine(tag)}> tag holds something this tool cannot read as an attribute.`,
          source.slice(cursor, cursor + 24),
        )
      }
      cursor += name[0].length
      let value = ''
      let scan = cursor
      while (scan < source.length && /\s/u.test(source[scan])) scan += 1
      if (source[scan] === '=') {
        scan += 1
        while (scan < source.length && /\s/u.test(source[scan])) scan += 1
        const quote = source[scan]
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, scan + 1)
          if (end === -1) {
            throw new HtmlError(
              'html-construct-unsupported',
              `An attribute value in <${singleLine(tag)}> is never closed.`,
            )
          }
          value = source.slice(scan + 1, end)
          cursor = end + 1
        } else {
          const unquoted = /^[^\s>]*/.exec(source.slice(scan))
          value = unquoted[0]
          cursor = scan + unquoted[0].length
        }
      }
      const key = lower(name[0])
      if (attributes.has(key)) {
        repeated.push(key)
      } else {
        attributes.set(key, decodeReferences(value, problems, top().path))
      }
    }

    closeImplied(tag)
    const element = appendElement(tag, attributes)
    for (const key of repeated) {
      problems.push({ ruleId: 'duplicate-attribute', detail: key, pointer: element.path })
    }
    index = cursor

    if (VOID_ELEMENTS.includes(tag)) continue

    if (selfClosing) {
      // `<div/>` means different things in HTML and in XML, so the tool does
      // not choose one quietly. It follows HTML -- the element stays open --
      // and says that the document left the subset.
      problems.push({ ruleId: 'html-construct-unsupported', detail: tag, pointer: element.path })
    }

    if (RAW_TEXT.includes(tag)) {
      const skipped = skipTo(tag, index)
      if (skipped === null) {
        problems.push({ ruleId: 'unclosed-element', detail: tag, pointer: element.path })
        index = source.length
      } else index = skipped.next
      if (tag === 'iframe') {
        problems.push({ ruleId: 'iframe-content-unavailable', detail: tag, pointer: element.path })
      }
      continue
    }

    if (ESCAPABLE_RAW_TEXT.includes(tag)) {
      const skipped = skipTo(tag, index)
      if (skipped === null) {
        problems.push({ ruleId: 'unclosed-element', detail: tag, pointer: element.path })
        index = source.length
        continue
      }
      element.children.push({
        kind: 'text',
        text: decodeReferences(skipped.inside, problems, element.path),
        parent: element,
      })
      index = skipped.next
      continue
    }

    if (OPAQUE.includes(tag)) {
      const skipped = skipTo(tag, index, true)
      const inside = skipped === null ? source.slice(index) : skipped.inside
      index = skipped === null ? source.length : skipped.next
      if (skipped === null) {
        problems.push({ ruleId: 'unclosed-element', detail: tag, pointer: element.path })
      }
      if (tag === 'template') {
        const mode = attributes.get('shadowrootmode')
        if (typeof mode === 'string' && mode !== '') {
          problems.push({
            ruleId: 'shadow-root-not-traversed',
            detail: mode,
            pointer: element.path,
          })
        } else {
          problems.push({ ruleId: 'template-content-skipped', detail: tag, pointer: element.path })
        }
      } else if (/<foreignobject[\s/>]/i.test(inside)) {
        problems.push({ ruleId: 'foreign-content-skipped', detail: tag, pointer: element.path })
      } else {
        problems.push({ ruleId: 'foreign-content-ignored', detail: tag, pointer: element.path })
      }
      continue
    }

    push(element)
  }

  flushText()

  const left = stack.slice(1).map((element) => ({ tag: element.tag, path: element.path }))
  const unexpected = left.filter((element) => !OPTIONAL_END_TAG.includes(element.tag))
  for (const element of unexpected) {
    problems.push({ ruleId: 'unclosed-element', detail: element.tag, pointer: element.path })
  }
  if (unexpected.length === 0 && left.length > 0) {
    problems.push({
      ruleId: 'implied-end-tag',
      detail: `${left.map((element) => element.tag).join(', ')} closed by the end of the document`,
      pointer: left[0].path,
    })
  }

  return { root, elements, byId, problems }
}

/** Every element whose id is shared with another, in document order. */
export function duplicatedIds(byId) {
  const ids = []
  for (const [id, nodes] of byId) if (nodes.length > 1) ids.push(id)
  return ids
}

/** A short, redacted excerpt of the markup around a byte offset, for evidence. */
export function excerptAt(source, offset, span = 40) {
  return excerpt(source.slice(Math.max(offset - span, 0), offset + span))
}
