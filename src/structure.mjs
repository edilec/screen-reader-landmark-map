/**
 * Landmarks, heading hierarchy and the navigable outline.
 *
 * Everything here is DOM-BASED EVIDENCE. The input is markup somebody
 * exported; no browser was opened, no assistive technology was run, and the
 * order in the outline is document order, not announcement order. Where the
 * markup does not settle a question -- a label reference that names nothing in
 * this document, an id more than one element carries, a role this tool has
 * never heard of -- the answer is UNRESOLVED, and an unresolved landmark is
 * excluded from a comparison whose result would otherwise be a positive claim.
 */

import { isPerceivable, renderText } from './rules.mjs'

/** The landmark roles this tool maps. */
export const LANDMARK_ROLES = Object.freeze([
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
])

/** Roles a page is expected to carry at most once. */
export const UNIQUE_LANDMARK_ROLES = Object.freeze(['banner', 'contentinfo', 'main'])

/**
 * Roles that legitimately repeat, and therefore have to be told apart. Two of
 * these with no accessible name is the defect this tool exists to locate.
 */
export const REPEATABLE_LANDMARK_ROLES = Object.freeze([
  'complementary',
  'form',
  'navigation',
  'region',
  'search',
])

/** ARIA roles this tool recognises on a `role` attribute. Anything else is unknown. */
export const KNOWN_ROLES = Object.freeze([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
  'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo',
  'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure',
  'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'meter', 'navigation', 'none', 'note', 'option',
  'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
  'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
  'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
  'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
])

/**
 * HTML's SECTIONING CONTENT category, which is exactly `article`, `aside`,
 * `nav` and `section`. `main` is not sectioning content and is deliberately
 * absent.
 */
const SECTIONING = Object.freeze(['article', 'aside', 'nav', 'section'])

/**
 * What scopes a `header` or a `footer` out of being the page's banner or
 * contentinfo. HTML-AAM lists `article`, `aside`, `main`, `nav` and `section`
 * for those two elements, so this is a DIFFERENT list from sectioning content:
 * a `header` inside `main` is a section header, while an `aside` inside `main`
 * is still `complementary` whether or not it is named.
 *
 * One shared list conflated them. Every unnamed `<aside>` inside `<main>` was
 * demoted out of the landmark map, so it never appeared in the outline and two
 * of them were never reported as landmarks a screen reader user cannot tell
 * apart.
 */
const SCOPES_HEADER_FOOTER = Object.freeze(['article', 'aside', 'main', 'nav', 'section'])

const HEADING_TAGS = Object.freeze(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** The implicit landmark role of an element, before its name is known. */
const IMPLICIT_LANDMARK = Object.freeze({
  aside: 'complementary',
  form: 'form',
  main: 'main',
  nav: 'navigation',
  search: 'search',
  section: 'region',
})

/** Implicit roles that exist only when the element carries an accessible name. */
const NEEDS_NAME_TO_BE_A_LANDMARK = Object.freeze(['form', 'region'])

function tokens(value) {
  return typeof value === 'string' ? value.split(/\s+/u).filter((token) => token !== '') : []
}

function attribute(element, name) {
  const value = element.attributes.get(name)
  return typeof value === 'string' ? value : null
}

function hasAncestorIn(element, tags) {
  for (let node = element.parent; node !== null; node = node.parent) {
    if (node.kind === 'element' && tags.includes(node.tag)) return true
  }
  return false
}

/**
 * Elements whose text alternative is an attribute rather than their contents.
 *
 * HTML-AAM gives `img` and `area` their name from `alt`. Both are void
 * elements, so a walk that only concatenates descendant text finds nothing in
 * them at all -- which reported `<h1><img alt="Acme"></h1>` as a heading with
 * no accessible name, at error severity, and a landmark labelled by such a
 * heading as unlabelled. The sister tool `aria-name-explainer` reads the same
 * `alt` in the same step.
 */
const ALT_NAMED = Object.freeze(['area', 'img'])

/** Button-like `input` types whose `value` is their name, with the HTML default. */
const BUTTON_INPUT_DEFAULTS = Object.freeze({ button: '', reset: 'Reset', submit: 'Submit' })

/**
 * A `select` embedded in somebody else's name contributes the chosen option,
 * not every option it holds.
 */
function selectedOptionText(element, index, state, inLabelledby) {
  let fallback = null
  for (const child of element.children) {
    if (child.kind !== 'element' || child.tag !== 'option') continue
    if (fallback === null) fallback = child
    if (child.attributes.has('selected')) return contributedText(child, index, state, { inLabelledby })
  }
  return fallback === null ? '' : contributedText(fallback, index, state, { inLabelledby })
}

/**
 * The text an embedded control or replaced element contributes, or null when
 * the element is neither and its contents are what count.
 *
 * `textarea` is deliberately absent: HTML makes its child text its value, and
 * this parser reads it as exactly that, so the ordinary walk is already right.
 */
function embeddedText(element, index, state, inLabelledby) {
  const tag = element.tag
  if (ALT_NAMED.includes(tag)) return attribute(element, 'alt') ?? ''
  // An EQUIVALENT MUTANT: deleting this line changes nothing that is ever
  // reported. The parent joins what it collects with a single space, and
  // every name reaches the report through `renderText`, which collapses runs
  // of whitespace and trims -- so ' ' and '' cannot be told apart.
  if (tag === 'br') return ' '
  if (tag === 'select') return selectedOptionText(element, index, state, inLabelledby)
  if (tag !== 'input') return null
  const type = (attribute(element, 'type') ?? 'text').toLowerCase()
  if (Object.hasOwn(BUTTON_INPUT_DEFAULTS, type)) {
    return attribute(element, 'value') ?? BUTTON_INPUT_DEFAULTS[type]
  }
  if (type === 'image') return attribute(element, 'alt') ?? ''
  return attribute(element, 'value') ?? ''
}

/**
 * The text a node contributes to somebody else's accessible name.
 *
 * Step 2F of the accessible name computation does not concatenate raw text:
 * for each descendant it computes THAT node's accessible name, so a
 * descendant's `aria-labelledby`, its `aria-label` and its own text
 * alternative all count. Concatenating raw text instead is what made a
 * heading whose only child is `<img alt="Acme">` come back empty.
 *
 * `aria-hidden="true"` removes a subtree from the accessibility tree, so its
 * text is not part of any name -- with ONE exception, and the exception is
 * step 2A: a node referenced DIRECTLY by `aria-labelledby` contributes its
 * text even when it carries `aria-hidden`. The reference is the author saying
 * "this element is the label", and hiding it does not withdraw that. It is
 * deliberate specification behaviour, it surprises people, and the sister
 * tool `aria-name-explainer` implements the same rule. The exception is for
 * the referenced node ITSELF: an `aria-hidden` element inside it still
 * contributes nothing, which is why `directReference` is never passed down.
 *
 * `inLabelledby` stops the recursion following a second `aria-labelledby`
 * from inside a reference that is already being resolved, which is what the
 * computation requires; `state.visited` stops a node contributing to its own
 * name twice.
 *
 * Nothing else is modelled: this is the DOM's text, not a rendering, and CSS
 * that hides or generates text is not in the snapshot.
 */
export function contributedText(element, index, state, options = {}) {
  const { directReference = false, inLabelledby = false } = options
  if (element.kind === 'text') return element.text
  if (!directReference && attribute(element, 'aria-hidden') === 'true') return ''
  if (state.visited.has(element)) return ''
  state.visited.add(element)

  if (!inLabelledby) {
    const references = tokens(attribute(element, 'aria-labelledby'))
    if (references.length > 0) return resolveReferences(references, index, state)
  }

  const label = attribute(element, 'aria-label')
  if (label !== null && isPerceivable(label)) return label

  const embedded = embeddedText(element, index, state, inLabelledby)
  if (embedded !== null) return embedded

  return element.children
    .map((child) => contributedText(child, index, state, { inLabelledby }))
    .join(' ')
}

/**
 * Accumulate the text an `aria-labelledby` token list contributes.
 *
 * A token naming nothing this document contains, or naming an id more than
 * one element carries, records itself on `state` and contributes nothing. The
 * caller turns that into an UNRESOLVED name: "this evidence cannot say what
 * the name is" is a different answer from "there is no name", and the two are
 * never folded together.
 */
function resolveReferences(references, index, state) {
  const parts = []
  for (const reference of references) {
    const targets = index.get(reference)
    if (targets === undefined || targets.length !== 1) {
      if (state.unresolved === null) state.unresolved = reference
      continue
    }
    parts.push(contributedText(targets[0], index, state, { directReference: true, inLabelledby: true }))
  }
  return parts.join(' ')
}

/**
 * Resolve the accessible name of a landmark or heading.
 *
 * Returns `{ name, source }`, or `{ unresolved: true }` when the markup names
 * something this document does not contain or contains twice. Unresolved is
 * not "unnamed": the two lead to different conclusions and they stay apart.
 */
export function accessibleName(element, index, { fromContent }) {
  const references = tokens(attribute(element, 'aria-labelledby'))
  if (references.length > 0) {
    // The element names itself out of its own reference resolution: a
    // self-reference asks for its contents, not for a second pass over the
    // reference it is already following.
    const state = { visited: new Set([element]), unresolved: null }
    const text = resolveReferences(references, index, state)
    if (state.unresolved !== null) return { unresolved: true, reference: state.unresolved }
    const name = renderText(text)
    if (isPerceivable(name)) return { name, source: 'aria-labelledby' }
    // Step 2B of the computation returns the accumulated text only IF IT IS
    // NOT EMPTY; a reference that resolves to nothing perceivable falls
    // through to the next source, exactly as an empty `aria-label` does.
    // Returning here reported a heading whose own text is visible, and a
    // landmark carrying an `aria-label`, as having no accessible name -- at
    // error severity, on correct markup.
  }

  const label = attribute(element, 'aria-label')
  if (label !== null && isPerceivable(label)) {
    return { name: renderText(label), source: 'aria-label' }
  }

  if (fromContent) {
    const state = { visited: new Set([element]), unresolved: null }
    const content = element.children
      .map((child) => contributedText(child, index, state, {}))
      .join(' ')
    // A reference the document cannot resolve is unresolved wherever it is
    // reached from, including from inside the contents. Reporting the text
    // that happened to accumulate around it would be a name built on evidence
    // dropped while building it.
    if (state.unresolved !== null) return { unresolved: true, reference: state.unresolved }
    if (isPerceivable(content)) return { name: renderText(content), source: 'content' }
  }

  const title = attribute(element, 'title')
  if (title !== null && isPerceivable(title)) return { name: renderText(title), source: 'title' }

  return { name: '', source: null }
}

/** The explicit role token, or null. Throws nothing: unknown is an answer. */
export function declaredRole(element) {
  const declared = tokens(attribute(element, 'role'))[0]
  // An EQUIVALENT MUTANT: without this line the fall-through returns
  // `{ role: null, unknown: undefined }`, and every caller tests
  // `unknown !== undefined`, so the two answers behave identically.
  if (declared === undefined) return { role: null }
  if (!KNOWN_ROLES.includes(declared)) return { role: null, unknown: declared }
  return { role: declared }
}

/**
 * The implicit landmark role of an element.
 *
 * `hasName` is a THREE-valued answer and the third value is the point of it.
 * `section` and `form` are landmarks only when they are named, so an element
 * whose name reference this document cannot resolve has an UNKNOWN role -- and
 * `null` here would quietly turn that unknown into "not a landmark", which is
 * a positive claim about a region the evidence cannot see. `hasName === null`
 * therefore keeps the role, and the caller reports it with an undetermined
 * name and marks the run incomplete.
 */
export function implicitLandmarkRole(element, hasName) {
  const tag = element.tag
  if (tag === 'header' || tag === 'footer') {
    if (hasAncestorIn(element, SCOPES_HEADER_FOOTER)) return null
    return tag === 'header' ? 'banner' : 'contentinfo'
  }
  const role = IMPLICIT_LANDMARK[tag]
  if (role === undefined) return null
  if (NEEDS_NAME_TO_BE_A_LANDMARK.includes(role) && hasName === false) return null
  // A nested `aside` is complementary only when it is named; otherwise it is
  // generic, which is what the HTML accessibility mapping says.
  if (role === 'complementary' && hasAncestorIn(element, SECTIONING) && hasName === false) return null
  return role
}

/** The heading level of an element, or null when it is not a heading. */
export function headingLevel(element, role) {
  const explicit = attribute(element, 'aria-level')
  const isHeading = role === 'heading' || HEADING_TAGS.includes(element.tag)
  if (!isHeading) return null
  if (explicit !== null && /^[1-9][0-9]?$/.test(explicit)) return Number(explicit)
  if (HEADING_TAGS.includes(element.tag)) return Number(element.tag.slice(1))
  return 2
}

/**
 * Walk the document once and produce the landmarks, the headings and the
 * outline that threads them together.
 *
 * The outline's `depth` is landmark nesting depth in the DOM. It is not a
 * reading order and it is not what a screen reader's landmark rotor will
 * present; it is where these elements sit in the markup that was exported.
 */
export function mapStructure(root, index) {
  const landmarks = []
  const headings = []
  const outline = []
  const problems = []

  // Regions of the page this run did not read, counted in document order. A
  // heading records how many were passed BEFORE it, which is what makes
  // "is there an unread region between these two headings" answerable.
  let unread = 0

  const walk = (element, depth) => {
    let nextDepth = depth
    if (element.kind === 'element' && element.tag !== '#document') {
      // `aria-hidden="true"` removes the element AND its subtree from the
      // accessibility tree, so there is no landmark and no heading in here to
      // map -- and nothing in here can change a claim about the rest of the
      // page either, which is why it is not counted as an unread region.
      // Mapping it anyway reported a decorative `<h2 aria-hidden="true">` as
      // `heading-empty` and a pair of navigation regions inside an
      // `aria-hidden` wrapper as duplicates, both at error severity, exit 1,
      // on markup where none of it is exposed to anyone. The same rule was
      // already applied to the text these elements contribute to a name;
      // `aria-name-explainer` applies it to controls, which it reports as
      // `control-not-exposed` and does not require a name of.
      if (attribute(element, 'aria-hidden') === 'true') return
      if (element.unread === true) unread += 1
      const declared = declaredRole(element)
      if (declared.unknown !== undefined) {
        // The element is something this tool has never heard of, so what its
        // descendants mean is unknown too: a role can change how its contents
        // are exposed. The subtree is left unmapped and the run is incomplete,
        // which is the conservative answer and the one the rule documents.
        problems.push({ ruleId: 'role-unknown', detail: declared.unknown, pointer: element.path })
        unread += 1
        return
      }

      const level = headingLevel(element, declared.role)
      const isHeading = level !== null
      const named = accessibleName(element, index, { fromContent: isHeading })

      if (isHeading) {
        if (named.unresolved === true) {
          problems.push({
            ruleId: 'name-reference-unresolved',
            detail: `the heading at ${element.path} names id "${named.reference}"`,
            pointer: element.path,
          })
          headings.push({ element, level, name: null, determined: false, unreadBefore: unread })
          outline.push({ kind: 'heading', level, name: null, pointer: element.path, depth })
        } else {
          headings.push({ element, level, name: named.name, determined: true, unreadBefore: unread })
          outline.push({ kind: 'heading', level, name: named.name, pointer: element.path, depth })
        }
      } else {
        const hasName =
          named.unresolved === true ? null : named.source !== null && isPerceivable(named.name)
        const implicit = implicitLandmarkRole(element, hasName)
        const role = declared.role !== null ? declared.role : implicit

        if (role !== null && LANDMARK_ROLES.includes(role)) {
          if (declared.role !== null && declared.role === implicit) {
            problems.push({
              ruleId: 'landmark-role-redundant',
              detail: `${element.tag} already means ${role}`,
              pointer: element.path,
            })
          }
          if (named.unresolved === true) {
            problems.push({
              ruleId: 'name-reference-unresolved',
              detail: `the ${role} landmark at ${element.path} names id "${named.reference}", so the duplicate-landmark comparison for ${role} could not be completed`,
              pointer: element.path,
            })
            landmarks.push({ element, role, name: null, source: null, determined: false, depth })
          } else {
            landmarks.push({
              element,
              role,
              name: named.name,
              source: named.source,
              determined: true,
              depth,
            })
          }
          outline.push({
            kind: 'landmark',
            role,
            name: named.unresolved === true ? null : named.name,
            pointer: element.path,
            depth,
          })
          nextDepth = depth + 1
        }
      }
    }
    for (const child of element.children) {
      if (child.kind === 'element') walk(child, nextDepth)
    }
  }

  walk(root, 0)
  return { landmarks, headings, outline, problems, unread }
}

/**
 * Locate duplicate landmarks that cannot be told apart.
 *
 * A landmark whose name could not be resolved is NOT counted as unnamed. It is
 * left out of the comparison, and the run is already incomplete because of it,
 * so the comparison is never reported as clean on evidence that was dropped
 * while making it.
 */
export function findDuplicateLandmarks(landmarks) {
  const byRole = new Map()
  for (const landmark of landmarks) {
    const list = byRole.get(landmark.role)
    if (list === undefined) byRole.set(landmark.role, [landmark])
    else list.push(landmark)
  }

  const problems = []
  for (const role of LANDMARK_ROLES) {
    const group = byRole.get(role) ?? []
    if (group.length === 0) continue

    if (UNIQUE_LANDMARK_ROLES.includes(role) && group.length > 1) {
      for (const landmark of group.slice(1)) {
        problems.push({
          ruleId: 'duplicate-unique-landmark',
          detail: `${role} appears ${group.length} times`,
          pointer: landmark.element.path,
        })
      }
    }

    if (!REPEATABLE_LANDMARK_ROLES.includes(role)) continue

    const determined = group.filter((landmark) => landmark.determined)
    const unnamed = determined.filter((landmark) => landmark.source === null)
    if (unnamed.length > 1) {
      for (const landmark of unnamed) {
        problems.push({
          ruleId: 'duplicate-unlabelled-landmark',
          detail: `${unnamed.length} ${role} landmarks carry no accessible name`,
          pointer: landmark.element.path,
        })
      }
    }

    const seen = new Map()
    for (const landmark of determined) {
      if (landmark.source === null) continue
      const list = seen.get(landmark.name)
      if (list === undefined) seen.set(landmark.name, [landmark])
      else list.push(landmark)
    }
    for (const [name, list] of seen) {
      if (list.length < 2) continue
      for (const landmark of list) {
        problems.push({
          ruleId: 'duplicate-landmark-name',
          detail: `${list.length} ${role} landmarks are all named "${name}"`,
          pointer: landmark.element.path,
        })
      }
    }
  }
  return problems
}

/**
 * Locate skipped levels in the heading hierarchy.
 *
 * A heading whose name could not be resolved still has a LEVEL, so it stays in
 * the hierarchy check; only the emptiness check is skipped for it, because
 * "this heading is empty" would be a claim the evidence does not support.
 *
 * `unread` is the same rule applied to the OTHER kind of missing evidence.
 * This list holds the headings of the part of the page that was read; every
 * heading inside a shadow root, an iframe or a subtree whose role this tool
 * does not know was dropped while building it. A gap that an unread region
 * sits in is therefore a gap in the EVIDENCE, and "level 1 is followed by
 * level 3" would be a positive claim about markup this file does not contain
 * -- the mistake findDuplicateLandmarks is careful not to make. The claims
 * that survive are the ones no absent markup could change: a level jump with
 * nothing unread between the two headings, and more than one level 1 heading,
 * which is a fact about the headings that ARE here.
 */
export function findHeadingProblems(headings, unread = 0) {
  const problems = []
  if (headings.length === 0) {
    // "The document declares no heading at all" is a claim about the whole
    // document, so any unread region withdraws it.
    if (unread === 0) {
      problems.push({ ruleId: 'no-heading', detail: 'the document declares no heading' })
    }
    return problems
  }

  if (headings[0].level !== 1 && headings[0].unreadBefore === 0) {
    problems.push({
      ruleId: 'first-heading-not-top-level',
      detail: `the first heading is level ${headings[0].level}`,
      pointer: headings[0].element.path,
    })
  }

  const topLevel = headings.filter((heading) => heading.level === 1)
  if (topLevel.length > 1) {
    for (const heading of topLevel.slice(1)) {
      problems.push({
        ruleId: 'multiple-top-level-headings',
        detail: `${topLevel.length} level 1 headings`,
        pointer: heading.element.path,
      })
    }
  }

  let previous = headings[0]
  for (const heading of headings.slice(1)) {
    const across = heading.unreadBefore > previous.unreadBefore
    if (heading.level > previous.level + 1 && !across) {
      problems.push({
        ruleId: 'heading-level-skipped',
        detail: `level ${previous.level} is followed by level ${heading.level}`,
        pointer: heading.element.path,
      })
    }
    previous = heading
  }

  for (const heading of headings) {
    if (!heading.determined) continue
    if (heading.name === '') {
      problems.push({
        ruleId: 'heading-empty',
        detail: `the level ${heading.level} heading has no accessible name`,
        pointer: heading.element.path,
      })
    }
  }
  return problems
}
