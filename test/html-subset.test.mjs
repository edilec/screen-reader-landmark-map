import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, HtmlError, decodeReferences, parseHtml } from '../src/index.mjs'

/**
 * The declared subset, both halves of it.
 *
 * A bounded parser is only honest if the boundary is real in both directions:
 * what it says it handles must actually work, and what it says it refuses must
 * actually be refused rather than quietly given a best guess. Each test below
 * is on one side of that line.
 */

const parse = (source, limits = DEFAULT_LIMITS) => parseHtml(source, limits)
const rules = (parsed) => parsed.problems.map((problem) => problem.ruleId)
const paths = (parsed) => parsed.elements.map((element) => element.path)

test('the parser refuses a source that is not a string, rather than reading nothing', () => {
  // Without this precondition `index < source.length` is false immediately,
  // so a non-string source parses to an EMPTY TREE and is reported as
  // `empty-snapshot` -- a claim about a document that was never read.
  for (const source of [42, null, undefined, ['<main></main>'], { source: '<main></main>' }]) {
    assert.throws(() => parseHtml(source, DEFAULT_LIMITS), /The snapshot text must be a string/)
  }
  assert.deepEqual(rules(parse('<main><h1>A</h1></main>')), [])
})

test('the parser refuses a limits value that is not an object', () => {
  // Without this precondition every limit comparison becomes `n > undefined`,
  // which is false, so maxElements and maxDepth are not enforced AT ALL --
  // the contract's "a documented limit never enforced" defect class, reached
  // by a caller passing the wrong shape rather than by a missing check.
  for (const limits of ['nope', 42, null, [], undefined]) {
    assert.throws(() => parseHtml('<main></main>', limits), /Limits must be an object/)
  }
})

test('attributes are read in all three quoting styles', () => {
  const parsed = parse('<div id="a" class=\'b c\' data-x=plain hidden></div>')
  const attributes = parsed.elements[0].attributes
  assert.equal(attributes.get('id'), 'a')
  assert.equal(attributes.get('class'), 'b c')
  assert.equal(attributes.get('data-x'), 'plain')
  assert.equal(attributes.get('hidden'), '')
  assert.deepEqual(rules(parsed), [])
})

test('tag names and attribute names are lowercased', () => {
  const parsed = parse('<DIV ID="a"><SPAN></SPAN></DIV>')
  assert.deepEqual(paths(parsed), ['/div[1]', '/div[1]/span[1]'])
  assert.equal(parsed.elements[0].attributes.get('id'), 'a')
})

test('the character references in the declared set are decoded', () => {
  const problems = []
  assert.equal(decodeReferences('a &amp; b &lt;c&gt; &#65; &#x42; &mdash;', problems, ''), 'a & b <c> A B —')
  assert.deepEqual(problems, [])
})

test('a character reference outside the set is left as written and reported', () => {
  const problems = []
  // Guessing here would put text in a heading that the page never had.
  assert.equal(decodeReferences('f&fnof;o', problems, ''), 'f&fnof;o')
  assert.deepEqual(problems.map((problem) => problem.ruleId), ['entity-unsupported'])
})

test('a bare ampersand is not a character reference and is not reported', () => {
  const problems = []
  assert.equal(decodeReferences('AT&T and Q&A', problems, ''), 'AT&T and Q&A')
  assert.deepEqual(problems, [])
})

test('comments and the doctype are skipped', () => {
  const parsed = parse('<!DOCTYPE html><!-- <h1>not a heading</h1> --><p>text</p>')
  assert.deepEqual(paths(parsed), ['/p[1]'])
  assert.deepEqual(rules(parsed), [])
})

test('void elements do not swallow what follows them', () => {
  const parsed = parse('<p>a<br>b<img src="x.png">c</p><h1>Real</h1>')
  assert.deepEqual(paths(parsed), ['/p[1]', '/p[1]/br[1]', '/p[1]/img[1]', '/h1[1]'])
  assert.deepEqual(rules(parsed), [])
})

test('markup inside a script or style is text, not markup', () => {
  const parsed = parse('<script>var s = "<h1>fake</h1>";</script><style>a{content:"<nav>"}</style><h1>Real</h1>')
  assert.deepEqual(paths(parsed), ['/script[1]', '/style[1]', '/h1[1]'])
})

test('title and textarea hold text with character references, never markup', () => {
  const parsed = parse('<title>A &amp; B</title><textarea><b>x</b></textarea>')
  assert.equal(parsed.elements[0].children[0].text, 'A & B')
  assert.equal(parsed.elements[1].children[0].text, '<b>x</b>')
  assert.deepEqual(paths(parsed), ['/title[1]', '/textarea[1]'])
})

test('an omitted list-item end tag nests the items as siblings', () => {
  const parsed = parse('<ul><li>One<li>Two<li>Three</ul>')
  assert.deepEqual(paths(parsed), [
    '/ul[1]',
    '/ul[1]/li[1]',
    '/ul[1]/li[2]',
    '/ul[1]/li[3]',
  ])
  assert.deepEqual(rules(parsed), ['implied-end-tag'])
})

test('an omitted paragraph end tag is closed by the next block element', () => {
  const parsed = parse('<div><p>One<p>Two<h2>Heading</h2></div>')
  assert.deepEqual(paths(parsed), ['/div[1]', '/div[1]/p[1]', '/div[1]/p[2]', '/div[1]/h2[1]'])
  assert.equal(parsed.elements[3].parent.tag, 'div')
})

test('an end tag matching nothing that is open is refused, not ignored', () => {
  const parsed = parse('<div>text</div></span>')
  assert.deepEqual(rules(parsed), ['stray-end-tag'])
})

test('an end tag that does not nest is refused', () => {
  const parsed = parse('<div><span>text</div>')
  assert.deepEqual(rules(parsed), ['mismatched-end-tag'])
})

test('an element still open at the end of the input is refused', () => {
  const parsed = parse('<div><section>text')
  assert.deepEqual(rules(parsed), ['unclosed-element', 'unclosed-element'])
})

test('an omitted optional end tag at the end of the input is ordinary HTML', () => {
  // `p` may be left open; `ul` may not, which is why the list case above is
  // reported and this one is not.
  const parsed = parse('<p>One<p>Two')
  assert.deepEqual(rules(parsed), ['implied-end-tag'])
})

test('XML self-closing syntax on a non-void element is reported, and HTML is followed', () => {
  const parsed = parse('<div/><p>after</p>')
  assert.ok(rules(parsed).includes('html-construct-unsupported'))
  // HTML keeps the element open. The paragraph is therefore INSIDE it, which
  // is what a browser does and what the finding warns about.
  assert.equal(parsed.elements[1].parent.tag, 'div')
})

test('XML self-closing syntax on a void element is ordinary HTML', () => {
  const parsed = parse('<p>a<br/>b</p>')
  assert.deepEqual(rules(parsed), [])
})

test('a CDATA section stops the parse rather than being guessed at', () => {
  assert.throws(() => parse('<p><![CDATA[x]]></p>'), (error) => {
    assert.ok(error instanceof HtmlError)
    assert.equal(error.ruleId, 'html-construct-unsupported')
    return true
  })
})

test('a processing instruction stops the parse', () => {
  assert.throws(() => parse('<?xml version="1.0"?><p>x</p>'), HtmlError)
})

test('an unterminated tag, comment or attribute value stops the parse', () => {
  assert.throws(() => parse('<div class="a'), HtmlError)
  assert.throws(() => parse('<div '), HtmlError)
  assert.throws(() => parse('<!-- never closed'), HtmlError)
})

test('a repeated attribute keeps the first value and says so', () => {
  const parsed = parse('<div id="first" id="second"></div>')
  assert.equal(parsed.elements[0].attributes.get('id'), 'first')
  assert.deepEqual(rules(parsed), ['duplicate-attribute'])
})

test('a template is not walked into, and a serialised shadow root is named', () => {
  const plain = parse('<template><nav>hidden</nav></template>')
  assert.deepEqual(paths(plain), ['/template[1]'])
  assert.deepEqual(rules(plain), ['template-content-skipped'])

  const shadow = parse('<x-a><template shadowrootmode="open"><nav>inside</nav></template></x-a>')
  assert.deepEqual(rules(shadow), ['shadow-root-not-traversed'])
})

test('an SVG subtree is not walked into, but its own start tag is read', () => {
  const parsed = parse('<svg role="img" aria-label="Chart"><path d="M0 0"/></svg><h1>After</h1>')
  assert.deepEqual(paths(parsed), ['/svg[1]', '/h1[1]'])
  assert.equal(parsed.elements[0].attributes.get('aria-label'), 'Chart')
  assert.deepEqual(rules(parsed), ['foreign-content-ignored'])
})

test('an SVG holding a foreignObject is reported as content that was not read', () => {
  const parsed = parse('<svg><foreignObject><h1>Hidden</h1></foreignObject></svg>')
  assert.deepEqual(rules(parsed), ['foreign-content-skipped'])
})

test('an iframe is reported as a document this file does not contain', () => {
  const parsed = parse('<iframe src="/x" title="Usage"><nav>fallback</nav></iframe><h1>After</h1>')
  assert.deepEqual(paths(parsed), ['/iframe[1]', '/h1[1]'])
  assert.deepEqual(rules(parsed), ['iframe-content-unavailable'])
})

test('nested elements of the same name are counted separately in the pointer', () => {
  const parsed = parse('<div><div></div><div></div></div>')
  assert.deepEqual(paths(parsed), ['/div[1]', '/div[1]/div[1]', '/div[1]/div[2]'])
})

test('the element and depth limits stop the parse rather than truncating it', () => {
  assert.throws(
    () => parse('<a></a><b></b><i></i>', { ...DEFAULT_LIMITS, maxElements: 2 }),
    (error) => error.ruleId === 'too-many-elements',
  )
  assert.throws(
    () => parse('<div><div><div></div></div></div>', { ...DEFAULT_LIMITS, maxDepth: 2 }),
    (error) => error.ruleId === 'depth-exceeded',
  )
})

test('a raw text element ends at its first end tag, whatever its text contains', () => {
  // Raw text elements cannot nest, so counting `<script` occurrences inside one
  // would treat the STRING "<script>" as a real nested element and run off the
  // end of the document looking for a second end tag.
  const parsed = parse('<script>var s = "<script>x";</script><h1>Real</h1>')
  assert.deepEqual(paths(parsed), ['/script[1]', '/h1[1]'])
  assert.deepEqual(rules(parsed), [])
})

test('a template CAN nest, so its end tag is counted', () => {
  const parsed = parse('<template><template><p>x</p></template></template><h1>Real</h1>')
  assert.deepEqual(paths(parsed), ['/template[1]', '/h1[1]'])
  assert.deepEqual(rules(parsed), ['template-content-skipped'])
})

test('a nested svg does not end the outer one early', () => {
  const parsed = parse('<svg><svg><circle/></svg></svg><h1>Real</h1>')
  assert.deepEqual(paths(parsed), ['/svg[1]', '/h1[1]'])
})

test('a numeric character reference outside Unicode is reported, not decoded', () => {
  const problems = []
  // The numeric branch has its own refusal: a code point past U+10FFFF and a
  // lone surrogate are both outside what a document may legally say.
  assert.equal(decodeReferences('a&#1114112;b', problems, ''), 'a&#1114112;b')
  assert.equal(decodeReferences('a&#xD800;b', problems, ''), 'a&#xD800;b')
  assert.deepEqual(
    problems.map((problem) => problem.ruleId),
    ['entity-unsupported', 'entity-unsupported'],
  )
})

test('an end tag for a void element matches nothing that is open', () => {
  const parsed = parse('<p>a<br>b</br></p>')
  assert.deepEqual(rules(parsed), ['stray-end-tag'])
})

test('each refused construct carries the message that says which check refused it', () => {
  // Several of these fall through to a LATER refusal when one is removed, with
  // the same rule id and the same exception type, so the type alone cannot
  // tell them apart.
  const cases = [
    ['<p><![CDATA[x]]></p>', /CDATA section is outside the subset/],
    ['<?xml version="1.0"?><p>x</p>', /processing instruction is outside the subset/],
    ['<!ENTITY x "y"><p>x</p>', /markup declaration this tool does not read/],
    ['<!doctype html', /doctype is never closed/],
    ['<div ', /The <div> tag is never closed/],
    ['<div =x>', /cannot read as an attribute/],
    ['<div class="a', /attribute value in <div> is never closed/],
    ['<!-- never closed', /comment is never closed/],
  ]
  for (const [source, expected] of cases) {
    assert.throws(
      () => parse(source),
      (error) => {
        assert.ok(error instanceof HtmlError, `${source} did not raise HtmlError`)
        assert.equal(error.ruleId, 'html-construct-unsupported')
        assert.match(error.message, expected)
        return true
      },
      `for ${JSON.stringify(source)}`,
    )
  }
})

test('a raw text, escapable raw text or opaque element with no end tag is reported', () => {
  for (const source of ['<script>x', '<title>x', '<svg><circle/>', '<textarea>x', '<iframe>x']) {
    const parsed = parse(source)
    assert.ok(
      rules(parsed).includes('unclosed-element'),
      `${source} produced ${rules(parsed).join(', ')}`,
    )
  }
})
