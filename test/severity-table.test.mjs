import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  DEFAULT_LIMITS,
  INCOMPLETE_RULES,
  RULE_SEVERITY,
  SEVERITIES,
  forcesIncomplete,
  severityOf,
} from '../src/index.mjs'

/**
 * The frozen table against the documented catalog, in BOTH directions.
 *
 * This is the source-of-truth check, not the severity guarantee: three
 * declarations agreeing with each other can be edited together.
 * `test/severity-behaviour.test.mjs` is what pins severity, by exit code. What
 * this file catches is the other failure -- a rule that exists in code and is
 * documented nowhere, or documented and never reachable.
 */

const DOCS = resolve(import.meta.dirname, '..', 'docs', 'structure-rules.md')

async function documentedRules() {
  const text = await readFile(DOCS, 'utf8')
  const rows = new Map()
  for (const match of text.matchAll(/^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|/gm)) {
    assert.ok(!rows.has(match[1]), `${match[1]} is documented twice`)
    rows.set(match[1], { severity: match[2], incomplete: match[3] === 'yes' })
  }
  return rows
}

test('every rule in the table is documented, with the same severity', async () => {
  const documented = await documentedRules()
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    const row = documented.get(ruleId)
    assert.ok(row !== undefined, `${ruleId} is in the table but not documented`)
    assert.equal(row.severity, severity, `${ruleId} severity differs from the catalog`)
  }
})

test('every documented rule is in the table', async () => {
  const documented = await documentedRules()
  for (const ruleId of documented.keys()) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is documented but not implemented`)
  }
})

test('the documented incomplete column matches INCOMPLETE_RULES in both directions', async () => {
  const documented = await documentedRules()
  for (const [ruleId, row] of documented) {
    assert.equal(
      row.incomplete,
      INCOMPLETE_RULES.includes(ruleId),
      `${ruleId} incomplete column differs from INCOMPLETE_RULES`,
    )
  }
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(documented.has(ruleId), `${ruleId} forces incomplete but is not documented`)
  }
})

test('every severity is one of the declared three', () => {
  for (const severity of Object.values(RULE_SEVERITY)) assert.ok(SEVERITIES.includes(severity))
})

test('an unknown rule id throws rather than defaulting to something harmless', () => {
  assert.throws(() => severityOf('no-such-rule'), TypeError)
  assert.throws(() => forcesIncomplete('no-such-rule'), TypeError)
})

test('the table and the incomplete list are frozen', () => {
  assert.ok(Object.isFrozen(RULE_SEVERITY))
  assert.ok(Object.isFrozen(INCOMPLETE_RULES))
  assert.ok(Object.isFrozen(DEFAULT_LIMITS))
})

test('every documented limit exists, and every limit is documented', async () => {
  const text = await readFile(DOCS, 'utf8')
  const documented = new Set()
  for (const match of text.matchAll(/^\| `(max[A-Za-z]+)` \| `--[a-z-]+` \| +(\d+) \|$/gm)) {
    documented.add(match[1])
    assert.equal(
      Number(match[2]),
      DEFAULT_LIMITS[match[1]],
      `${match[1]} default differs from the catalog`,
    )
  }
  assert.deepEqual([...documented].sort(), Object.keys(DEFAULT_LIMITS).sort())
})
