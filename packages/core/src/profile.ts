/**
 * Automatic exploratory data analysis.
 *
 * The heavy statistics come from DuckDB's built-in `SUMMARIZE`, which returns
 * min/max/avg/std/quartiles/approx_unique/null_percentage for every column in
 * one pass. Only the things SUMMARIZE does not cover — IQR outliers, duplicate
 * rows, and the judgement calls about what is worth flagging — are computed
 * here.
 */

import type { AnalystEngine } from './engine.js'
import { asNumber } from './json.js'
import { quoteIdentifier } from './sql.js'
import type {
  ColumnKind,
  ColumnProfile,
  DataIssue,
  DatasetProfile,
  JsonValue,
} from './types.js'

const NUMERIC_TYPES = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL)/i
const TEMPORAL_TYPES = /^(DATE|TIME|TIMESTAMP|INTERVAL)/i
const TEXT_TYPES = /^(VARCHAR|CHAR|TEXT|STRING|ENUM|UUID)/i

/** Fraction of distinct values above which a text column reads as an identifier. */
const ID_LIKE_RATIO = 0.9

/**
 * Row ceiling for computing exact distinct counts.
 *
 * DuckDB's `SUMMARIZE` reports `approx_unique` from a HyperLogLog sketch,
 * which is off by one or two at small cardinalities — a 4-value column can
 * come back as 3. A profile is read as a statement of fact about the data, so
 * below this size the counts are recomputed exactly; above it the estimate is
 * kept and flagged, because an exact count over a very wide, very long table
 * is not worth the scan.
 */
export const EXACT_DISTINCT_MAX_ROWS = 2_000_000
/** Row count below which cardinality ratios are noise. */
const CARDINALITY_MIN_ROWS = 20

export function classifyType(sqlType: string): ColumnKind {
  if (NUMERIC_TYPES.test(sqlType)) return 'numeric'
  if (TEMPORAL_TYPES.test(sqlType)) return 'temporal'
  if (/^BOOLEAN/i.test(sqlType)) return 'boolean'
  if (TEXT_TYPES.test(sqlType)) return 'categorical'
  return 'other'
}

interface OutlierBound {
  readonly column: string
  readonly low: number
  readonly high: number
}

function outlierBound(column: string, q25: JsonValue, q75: JsonValue): OutlierBound | null {
  const lowQuartile = asNumber(q25)
  const highQuartile = asNumber(q75)
  if (lowQuartile === null || highQuartile === null) return null

  const iqr = highQuartile - lowQuartile
  // A zero IQR means at least half the values are identical; the rule would
  // flag every distinct value as an outlier, which is noise, not a finding.
  if (!(iqr > 0)) return null

  return { column, low: lowQuartile - 1.5 * iqr, high: highQuartile + 1.5 * iqr }
}

async function countOutliers(
  engine: AnalystEngine,
  alias: string,
  bounds: readonly OutlierBound[],
  signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (bounds.length === 0) return counts

  const projections = bounds.map((bound) => {
    const column = quoteIdentifier(bound.column)
    return (
      `count(*) FILTER (WHERE ${column} < ${bound.low} OR ${column} > ${bound.high}) ` +
      `AS ${quoteIdentifier(bound.column)}`
    )
  })

  const [row] = await engine.queryInternal(
    `SELECT ${projections.join(', ')} FROM ${quoteIdentifier(alias)}`,
    signal,
  )
  if (row === undefined) return counts

  for (const bound of bounds) {
    const value = asNumber(row[bound.column] ?? null)
    if (value !== null) counts.set(bound.column, value)
  }
  return counts
}

/**
 * Exact distinct count per column, in one pass.
 * @returns a map from column name to its exact count.
 */
async function countDistinctExact(
  engine: AnalystEngine,
  alias: string,
  columns: readonly string[],
  signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (columns.length === 0) return counts

  const projections = columns.map(
    (column) => `count(DISTINCT ${quoteIdentifier(column)}) AS ${quoteIdentifier(column)}`,
  )
  const [row] = await engine.queryInternal(
    `SELECT ${projections.join(', ')} FROM ${quoteIdentifier(alias)}`,
    signal,
  )
  if (row === undefined) return counts

  for (const column of columns) {
    const value = asNumber(row[column] ?? null)
    if (value !== null) counts.set(column, value)
  }
  return counts
}

async function countDuplicateRows(
  engine: AnalystEngine,
  alias: string,
  signal: AbortSignal | undefined,
): Promise<number> {
  const table = quoteIdentifier(alias)
  const [row] = await engine.queryInternal(
    `SELECT (SELECT count(*) FROM ${table}) - (SELECT count(*) FROM (SELECT DISTINCT * FROM ${table})) AS n`,
    signal,
  )
  return asNumber(row?.['n'] ?? null) ?? 0
}

function collectIssues(
  columns: readonly ColumnProfile[],
  rowCount: number,
  duplicateRows: number,
): DataIssue[] {
  const issues: DataIssue[] = []

  for (const column of columns) {
    if (column.nullPercent >= 30) {
      issues.push({
        kind: 'high-null',
        column: column.name,
        detail: `${column.nullPercent}% of values are missing.`,
        severity: 'warn',
      })
    } else if (column.nullPercent >= 5) {
      issues.push({
        kind: 'high-null',
        column: column.name,
        detail: `${column.nullPercent}% of values are missing.`,
        severity: 'info',
      })
    }

    if (rowCount > 1 && column.distinct <= 1) {
      issues.push({
        kind: 'constant',
        column: column.name,
        detail: 'Every row holds the same value, so this column cannot explain anything.',
        severity: 'warn',
      })
    }

    if (
      column.kind === 'categorical' &&
      rowCount >= CARDINALITY_MIN_ROWS &&
      column.distinct / rowCount >= ID_LIKE_RATIO
    ) {
      issues.push({
        kind: 'high-cardinality',
        column: column.name,
        detail: `${column.distinct} distinct values across ${rowCount} rows — this looks like an identifier, not a category.`,
        severity: 'info',
      })
    }

    if (column.outlierCount !== null && column.outlierCount > 0) {
      issues.push({
        kind: 'outliers',
        column: column.name,
        detail: `${column.outlierCount} value(s) fall outside 1.5×IQR of the quartiles.`,
        severity: 'info',
      })
    }
  }

  if (duplicateRows > 0) {
    issues.push({
      kind: 'duplicate-rows',
      column: null,
      detail: `${duplicateRows} row(s) are exact duplicates of another row.`,
      severity: 'warn',
    })
  }

  // Warnings first; the caller renders them in order and a model reads the
  // top of the list when the tail is truncated.
  return issues.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'warn' ? -1 : 1))
}

export interface ProfileOptions {
  readonly signal?: AbortSignal
}

/**
 * Profile one attached dataset.
 *
 * @param alias - a dataset previously registered through `engine.attach`.
 */
export async function profileDataset(
  engine: AnalystEngine,
  alias: string,
  options: ProfileOptions = {},
): Promise<DatasetProfile> {
  const handle = engine.source(alias)
  if (handle === undefined) {
    throw new Error(`No dataset is attached under the name "${alias}".`)
  }

  const summary = await engine.queryInternal(
    `SUMMARIZE SELECT * FROM ${quoteIdentifier(alias)}`,
    options.signal,
  )

  const draft = summary.map((row) => {
    const name = String(row['column_name'] ?? '')
    const sqlType = String(row['column_type'] ?? '')
    return {
      name,
      sqlType,
      kind: classifyType(sqlType),
      nullPercent: asNumber(row['null_percentage'] ?? null) ?? 0,
      distinct: asNumber(row['approx_unique'] ?? null) ?? 0,
      min: row['min'] ?? null,
      max: row['max'] ?? null,
      mean: asNumber(row['avg'] ?? null),
      stddev: asNumber(row['std'] ?? null),
      q25: row['q25'] ?? null,
      q50: row['q50'] ?? null,
      q75: row['q75'] ?? null,
    }
  })

  const bounds = draft
    .filter((column) => column.kind === 'numeric')
    .map((column) => outlierBound(column.name, column.q25, column.q75))
    .filter((bound): bound is OutlierBound => bound !== null)

  const exactDistinct = handle.rowCount <= EXACT_DISTINCT_MAX_ROWS

  const [outliers, duplicateRows, distinctCounts] = await Promise.all([
    countOutliers(engine, alias, bounds, options.signal),
    countDuplicateRows(engine, alias, options.signal),
    exactDistinct
      ? countDistinctExact(engine, alias, draft.map((column) => column.name), options.signal)
      : Promise.resolve(new Map<string, number>()),
  ])

  const columns: ColumnProfile[] = draft.map((column) => ({
    ...column,
    distinct: distinctCounts.get(column.name) ?? column.distinct,
    distinctExact: distinctCounts.has(column.name),
    outlierCount: column.kind === 'numeric' ? (outliers.get(column.name) ?? 0) : null,
  }))

  return {
    source: alias,
    rowCount: handle.rowCount,
    columnCount: columns.length,
    columns,
    issues: collectIssues(columns, handle.rowCount, duplicateRows),
  }
}
