/**
 * DuckDB value -> lossless JSON.
 *
 * DuckDB's Node API hands back values that `JSON.stringify` cannot serialize:
 * BIGINT arrives as a `bigint`, DECIMAL as a `DuckDBDecimalValue`, and DATE /
 * TIMESTAMP / TIME / INTERVAL as their own wrapper classes. A dsh tool must
 * return a canonical value the registry can snapshot as lossless JSON, so the
 * conversion belongs here rather than in every adapter.
 */

import type { JsonValue } from './types.js'

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = -MAX_SAFE

interface DecimalLike {
  readonly toDouble: () => number
}

function isDecimalLike(value: object): value is DecimalLike {
  return typeof (value as { toDouble?: unknown }).toDouble === 'function'
}

function isDuckDbWrapper(value: object): boolean {
  const name = value.constructor?.name
  return typeof name === 'string' && name.startsWith('DuckDB')
}

/**
 * Convert one DuckDB cell to JSON.
 *
 * Integers outside the IEEE-754 safe range become strings rather than losing
 * precision silently — a row id of 9007199254740993 must not come back as
 * ...92. Non-finite doubles (NaN, Infinity) become null, since JSON has no
 * representation for them.
 */
export function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : null
    case 'bigint':
      return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString()
    case 'object':
      break
    default:
      return null
  }

  if (Array.isArray(value)) return value.map(toJsonValue)
  if (value instanceof Date) return value.toISOString()

  const object = value as object

  // DECIMAL keeps full precision through toDouble(); it is the only wrapper
  // that should stay numeric, because charts and aggregates consume it.
  if (isDecimalLike(object)) {
    const asDouble = object.toDouble()
    return Number.isFinite(asDouble) ? asDouble : null
  }

  // Temporal and other wrappers stringify to a stable, sortable form
  // (`2026-01-02`, `2026-01-02 03:04:05`) that Vega-Lite parses directly.
  if (isDuckDbWrapper(object)) return String(object)

  if (object instanceof Map) {
    const fromMap: Record<string, JsonValue> = {}
    for (const [key, entry] of object) fromMap[String(key)] = toJsonValue(entry)
    return fromMap
  }

  const record: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(object)) record[key] = toJsonValue(entry)
  return record
}

/** Convert a full result row. */
export function toJsonRow(row: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(row)) out[key] = toJsonValue(value)
  return out
}

/** Narrow a JSON cell to a finite number, or null when it is not numeric. */
export function asNumber(value: JsonValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
