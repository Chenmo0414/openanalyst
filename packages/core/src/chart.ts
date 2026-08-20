/**
 * Chart generation as self-contained Vega-Lite specifications.
 *
 * The output is one plain JSON value with its data inlined. That shape is what
 * makes the dsh conversation node work: the host writes the spec into a session
 * event as a whole-value checkpoint, and replaying the log rebuilds the exact
 * same chart as a pure function of that event — no clock, no random, no live
 * state. Any renderer that speaks Vega-Lite can draw it, which also keeps the
 * MCP and CLI adapters honest.
 */

import type { AnalystEngine } from './engine.js'
import { quoteIdentifier } from './sql.js'
import { classifyType } from './profile.js'
import type {
  ChartKind,
  ChartSpec,
  ColumnProfile,
  DatasetProfile,
  JsonValue,
} from './types.js'

/** Cap on inlined data points, so one chart event stays a reasonable size. */
export const MAX_POINTS = 2000

/** Distinct-value ceiling for a column to work as a bar-chart axis. */
const MAX_CATEGORIES = 50

export type Aggregate = 'sum' | 'avg' | 'count' | 'min' | 'max' | 'none'

export interface ChartRequest {
  /** Alias of an attached dataset. */
  readonly source: string
  readonly kind: ChartKind
  /** Column on the x axis. Must exist in the dataset. */
  readonly x: string
  /** Column on the y axis. Required for every kind except `histogram`. */
  readonly y?: string
  /** How to combine y within each x. Defaults to `sum` for bar/line/area, `none` for scatter. */
  readonly aggregate?: Aggregate
  /** Optional column to split series by colour. */
  readonly color?: string
  readonly title?: string
  readonly limit?: number
  readonly signal?: AbortSignal
}

export class ChartError extends Error {
  override readonly name = 'ChartError'
}

function vegaType(kind: ReturnType<typeof classifyType>): 'quantitative' | 'temporal' | 'nominal' {
  if (kind === 'numeric') return 'quantitative'
  if (kind === 'temporal') return 'temporal'
  return 'nominal'
}

function markFor(kind: ChartKind): JsonValue {
  switch (kind) {
    case 'bar':
    case 'histogram':
      return { type: 'bar', tooltip: true }
    case 'line':
      return { type: 'line', point: true, tooltip: true }
    case 'area':
      return { type: 'area', tooltip: true, line: true, opacity: 0.75 }
    case 'scatter':
      return { type: 'point', tooltip: true, filled: true, size: 60 }
  }
}

function defaultAggregate(kind: ChartKind): Aggregate {
  return kind === 'scatter' || kind === 'histogram' ? 'none' : 'sum'
}

export interface ResolvedColumns {
  readonly x: { readonly name: string; readonly sqlType: string }
  readonly y: { readonly name: string; readonly sqlType: string } | null
  readonly color: { readonly name: string; readonly sqlType: string } | null
}

/**
 * Resolve requested column names against the dataset.
 *
 * Column names reach SQL only after matching a known column, so an
 * agent-supplied name can never become arbitrary SQL.
 */
function resolveColumns(engine: AnalystEngine, request: ChartRequest): ResolvedColumns {
  const handle = engine.source(request.source)
  if (handle === undefined) {
    throw new ChartError(`No dataset is attached under the name "${request.source}".`)
  }

  const find = (name: string, role: string): { name: string; sqlType: string } => {
    const match = handle.columns.find((column) => column.name === name)
    if (match === undefined) {
      const available = handle.columns.map((column) => column.name).join(', ')
      throw new ChartError(`Column "${name}" (${role}) is not in "${request.source}". Available: ${available}`)
    }
    return { name: match.name, sqlType: match.sqlType }
  }

  if (request.kind !== 'histogram' && request.y === undefined) {
    throw new ChartError(`A ${request.kind} chart needs a y column.`)
  }

  return {
    x: find(request.x, 'x'),
    y: request.y === undefined ? null : find(request.y, 'y'),
    color: request.color === undefined ? null : find(request.color, 'color'),
  }
}

function buildSql(request: ChartRequest, columns: ResolvedColumns, limit: number): string {
  const table = quoteIdentifier(request.source)
  const x = quoteIdentifier(columns.x.name)
  const aggregate = request.aggregate ?? defaultAggregate(request.kind)

  if (request.kind === 'histogram') {
    return `SELECT ${x} FROM ${table} WHERE ${x} IS NOT NULL LIMIT ${limit}`
  }

  const yColumn = columns.y
  if (yColumn === null) throw new ChartError('Internal: missing y column after resolution.')
  const y = quoteIdentifier(yColumn.name)
  const color = columns.color === null ? null : quoteIdentifier(columns.color.name)

  if (aggregate === 'none') {
    const projection = [x, y, ...(color === null ? [] : [color])].join(', ')
    const filter = `${x} IS NOT NULL AND ${y} IS NOT NULL`
    return `SELECT ${projection} FROM ${table} WHERE ${filter} LIMIT ${limit}`
  }

  const grouping = [x, ...(color === null ? [] : [color])].join(', ')
  const measure = aggregate === 'count' ? `count(${y})` : `${aggregate}(${y})`
  return (
    `SELECT ${grouping}, ${measure} AS ${y} FROM ${table} ` +
    `WHERE ${x} IS NOT NULL GROUP BY ${grouping} ORDER BY ${x} LIMIT ${limit}`
  )
}

function buildEncoding(
  request: ChartRequest,
  columns: ResolvedColumns,
  aggregate: Aggregate,
): JsonValue {
  const xType = vegaType(classifyType(columns.x.sqlType))

  const encoding: Record<string, JsonValue> = {
    x:
      request.kind === 'histogram'
        ? { field: columns.x.name, type: 'quantitative', bin: { maxbins: 30 }, title: columns.x.name }
        : { field: columns.x.name, type: xType, title: columns.x.name },
  }

  if (request.kind === 'histogram') {
    encoding['y'] = { aggregate: 'count', type: 'quantitative', title: 'count' }
  } else if (columns.y !== null) {
    const label = aggregate === 'none' ? columns.y.name : `${aggregate}(${columns.y.name})`
    encoding['y'] = {
      field: columns.y.name,
      type: vegaType(classifyType(columns.y.sqlType)),
      title: label,
    }
  }

  if (columns.color !== null) {
    encoding['color'] = {
      field: columns.color.name,
      type: vegaType(classifyType(columns.color.sqlType)),
      title: columns.color.name,
    }
  }

  return encoding
}

function defaultTitle(request: ChartRequest, columns: ResolvedColumns, aggregate: Aggregate): string {
  if (request.kind === 'histogram') return `Distribution of ${columns.x.name}`
  const measure =
    columns.y === null
      ? ''
      : aggregate === 'none'
        ? columns.y.name
        : `${aggregate}(${columns.y.name})`
  const by = columns.color === null ? '' : ` by ${columns.color.name}`
  return `${measure} over ${columns.x.name}${by}`
}

/** Build one chart from an attached dataset. */
export async function buildChart(
  engine: AnalystEngine,
  request: ChartRequest,
): Promise<ChartSpec> {
  const columns = resolveColumns(engine, request)
  const aggregate = request.aggregate ?? defaultAggregate(request.kind)
  const limit = Math.min(request.limit ?? MAX_POINTS, MAX_POINTS)

  const rows = await engine.queryInternal(buildSql(request, columns, limit), request.signal)
  const title = request.title ?? defaultTitle(request, columns, aggregate)

  const vegaLite: JsonValue = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title,
    data: { values: rows },
    mark: markFor(request.kind),
    encoding: buildEncoding(request, columns, aggregate),
    width: 'container',
    height: 280,
    autosize: { type: 'fit', contains: 'padding' },
  }

  return { kind: request.kind, title, vegaLite, rowCount: rows.length }
}

/**
 * Propose charts worth drawing for a profiled dataset.
 *
 * Ordered by how much a first-time reader learns from them: a time trend beats
 * a category breakdown, which beats a correlation, which beats a distribution.
 * Columns already flagged as identifier-like are skipped — a bar chart with one
 * bar per row teaches nothing.
 */
export function suggestCharts(profile: DatasetProfile, max = 3): ChartRequest[] {
  const usable = (column: ColumnProfile): boolean =>
    column.nullPercent < 95 && column.distinct > 1

  const numeric = profile.columns.filter((column) => column.kind === 'numeric' && usable(column))
  const temporal = profile.columns.filter((column) => column.kind === 'temporal' && usable(column))
  const categorical = profile.columns.filter(
    (column) =>
      column.kind === 'categorical' &&
      usable(column) &&
      column.distinct <= MAX_CATEGORIES,
  )

  const suggestions: ChartRequest[] = []
  const firstNumeric = numeric[0]

  if (temporal[0] !== undefined && firstNumeric !== undefined) {
    suggestions.push({
      source: profile.source,
      kind: 'line',
      x: temporal[0].name,
      y: firstNumeric.name,
      aggregate: 'sum',
    })
  }

  if (categorical[0] !== undefined && firstNumeric !== undefined) {
    suggestions.push({
      source: profile.source,
      kind: 'bar',
      x: categorical[0].name,
      y: firstNumeric.name,
      aggregate: 'sum',
    })
  }

  if (numeric.length >= 2 && numeric[0] !== undefined && numeric[1] !== undefined) {
    suggestions.push({
      source: profile.source,
      kind: 'scatter',
      x: numeric[0].name,
      y: numeric[1].name,
      aggregate: 'none',
    })
  }

  if (firstNumeric !== undefined) {
    suggestions.push({ source: profile.source, kind: 'histogram', x: firstNumeric.name })
  }

  return suggestions.slice(0, max)
}
