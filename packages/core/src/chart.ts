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
import { CHART_CONFIG } from './theme.js'
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
  /**
   * Column on the y axis. Required for every kind except `histogram`.
   * For `heatmap` this is the SECOND category axis; for `boxplot` the numeric
   * column whose distribution is drawn per x category.
   */
  readonly y?: string
  /** Numeric column a heatmap cell aggregates. Heatmap only. */
  readonly value?: string
  /** How to combine y (or `value`) within each group. Defaults to `sum` for bar/line/area/heatmap, `none` for scatter/boxplot. */
  readonly aggregate?: Aggregate
  /** Optional column to split series by colour. */
  readonly color?: string
  /**
   * Bar layout when `color` is present: `stacked` (default) piles segments,
   * `grouped` places bars side by side within each x band.
   */
  readonly stack?: 'stacked' | 'grouped'
  /**
   * Split into small multiples by this (low-cardinality) column — one panel
   * per value, wrapped at three columns.
   */
  readonly facet?: string
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

/** Point-marker ceiling for lines: beyond this, markers are noise, not marks. */
const LINE_MARKER_MAX_POINTS = 60

function markFor(kind: ChartKind, pointCount: number): JsonValue {
  // Visual specifics (widths, radii, colors, sizes) live in CHART_CONFIG so
  // every renderer inherits the same theme; the mark carries only semantics.
  switch (kind) {
    case 'bar':
    case 'histogram':
      return { type: 'bar', tooltip: true }
    case 'line':
      // Selective marking: a sparse series gets per-point markers, a dense one
      // keeps only the line — markers on 200 points read as texture, not data.
      return { type: 'line', point: pointCount <= LINE_MARKER_MAX_POINTS, tooltip: true }
    case 'area':
      return { type: 'area', line: true, tooltip: true }
    case 'scatter':
      return { type: 'point', tooltip: true }
    case 'heatmap':
      return { type: 'rect', tooltip: true }
    case 'boxplot':
      // extent 1.5 draws whiskers at the same 1.5-IQR rule the profiler uses
      // to count outliers, so the chart and data_profile tell one story.
      return { type: 'boxplot', extent: 1.5 }
  }
}

function defaultAggregate(kind: ChartKind): Aggregate {
  return kind === 'scatter' || kind === 'histogram' || kind === 'boxplot' ? 'none' : 'sum'
}

interface ResolvedColumn {
  readonly name: string
  readonly sqlType: string
}

export interface ResolvedColumns {
  readonly x: ResolvedColumn
  readonly y: ResolvedColumn | null
  readonly value: ResolvedColumn | null
  readonly color: ResolvedColumn | null
  readonly facet: ResolvedColumn | null
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
  if (request.kind === 'heatmap' && request.value === undefined) {
    throw new ChartError('A heatmap needs a numeric `value` column to aggregate into each cell.')
  }
  if (request.facet !== undefined && (request.kind === 'heatmap' || request.kind === 'boxplot')) {
    throw new ChartError(`Faceting is not supported for ${request.kind} charts.`)
  }

  return {
    x: find(request.x, 'x'),
    y: request.y === undefined ? null : find(request.y, 'y'),
    value: request.value === undefined ? null : find(request.value, 'value'),
    color: request.color === undefined ? null : find(request.color, 'color'),
    facet: request.facet === undefined ? null : find(request.facet, 'facet'),
  }
}

/** Deterministic reservoir seed: same data + same request = same sample. */
const SAMPLE_SEED = 42

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

  if (request.kind === 'heatmap') {
    const valueColumn = columns.value
    if (valueColumn === null) throw new ChartError('Internal: missing value column after resolution.')
    const value = quoteIdentifier(valueColumn.name)
    const cell = aggregate === 'none' ? `sum(${value})` : aggregate === 'count' ? `count(${value})` : `${aggregate}(${value})`
    return (
      `SELECT ${x}, ${y}, ${cell} AS ${value} FROM ${table} ` +
      `WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL GROUP BY ${x}, ${y} ` +
      `ORDER BY ${x}, ${y} LIMIT ${limit}`
    )
  }

  if (request.kind === 'boxplot') {
    // Raw rows feed vega's box statistics. Past the cap, a seeded reservoir
    // sample keeps the query deterministic — same request, same sample.
    return (
      `SELECT ${x}, ${y} FROM ` +
      `(SELECT ${x}, ${y} FROM ${table} WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL) ` +
      `USING SAMPLE reservoir(${limit} ROWS) REPEATABLE (${SAMPLE_SEED})`
    )
  }

  const color = columns.color === null ? null : quoteIdentifier(columns.color.name)
  const facet = columns.facet === null ? null : quoteIdentifier(columns.facet.name)
  const extras = [...(color === null ? [] : [color]), ...(facet === null ? [] : [facet])]

  if (aggregate === 'none') {
    const projection = [x, y, ...extras].join(', ')
    const filter = `${x} IS NOT NULL AND ${y} IS NOT NULL`
    return `SELECT ${projection} FROM ${table} WHERE ${filter} LIMIT ${limit}`
  }

  const grouping = [x, ...extras].join(', ')
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

  if (request.kind === 'heatmap') {
    const valueColumn = columns.value
    const yColumn = columns.y
    if (valueColumn === null || yColumn === null) {
      throw new ChartError('Internal: heatmap columns missing after resolution.')
    }
    encoding['x'] = { field: columns.x.name, type: 'nominal', title: columns.x.name }
    encoding['y'] = { field: yColumn.name, type: 'nominal', title: yColumn.name }
    // The theme's `range.heatmap` sequential ramp colors the cells.
    encoding['color'] = {
      field: valueColumn.name,
      type: 'quantitative',
      title: aggregate === 'none' ? `sum(${valueColumn.name})` : `${aggregate}(${valueColumn.name})`,
    }
    return encoding
  }

  if (request.kind === 'boxplot') {
    const yColumn = columns.y
    if (yColumn === null) throw new ChartError('Internal: boxplot y column missing after resolution.')
    encoding['x'] = { field: columns.x.name, type: 'nominal', title: columns.x.name }
    encoding['y'] = {
      field: yColumn.name,
      type: 'quantitative',
      title: yColumn.name,
      scale: { zero: false },
    }
    return encoding
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
    // Grouped bars sit side by side inside each x band; stacked is the
    // vega-lite default for bar + color, so only `grouped` needs an offset.
    if (request.kind === 'bar' && request.stack === 'grouped') {
      encoding['xOffset'] = { field: columns.color.name }
    }
  }

  if (columns.facet !== null) {
    encoding['facet'] = {
      field: columns.facet.name,
      type: 'nominal',
      columns: 3,
      title: columns.facet.name,
    }
  }

  return encoding
}

function defaultTitle(request: ChartRequest, columns: ResolvedColumns, aggregate: Aggregate): string {
  if (request.kind === 'histogram') return `Distribution of ${columns.x.name}`
  if (request.kind === 'heatmap') {
    const measure = aggregate === 'none' ? 'sum' : aggregate
    return `${measure}(${columns.value?.name ?? ''}) — ${columns.x.name} × ${columns.y?.name ?? ''}`
  }
  if (request.kind === 'boxplot') {
    return `Distribution of ${columns.y?.name ?? ''} by ${columns.x.name}`
  }
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

  // Faceted specs size per panel; `container` would size the whole grid to
  // one panel's box and overflow.
  const faceted = columns.facet !== null

  const vegaLite: JsonValue = {
    $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
    title,
    data: { values: rows },
    mark: markFor(request.kind, rows.length),
    encoding: buildEncoding(request, columns, aggregate),
    width: faceted ? 210 : 'container',
    height: faceted ? 160 : 280,
    autosize: faceted ? { type: 'pad' } : { type: 'fit', contains: 'padding' },
    config: CHART_CONFIG,
    // Continuous-axis charts pan and zoom in place (drag / wheel). The param
    // lives in the spec, so replay still reproduces the identical chart — the
    // interaction state is view-local and resets to this same initial view.
    ...(request.kind === 'line' || request.kind === 'scatter'
      ? { params: [{ name: 'view_pan_zoom', select: 'interval', bind: 'scales' }] }
      : {}),
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

  // Two small category axes and a measure — the shape a heatmap exists for.
  if (categorical.length >= 2 && firstNumeric !== undefined) {
    const [firstCat, secondCat] = categorical
    if (firstCat !== undefined && secondCat !== undefined) {
      suggestions.push({
        source: profile.source,
        kind: 'heatmap',
        x: firstCat.name,
        y: secondCat.name,
        value: firstNumeric.name,
        aggregate: 'sum',
      })
    }
  }

  // A numeric column with outliers, split by a category: the boxplot shows
  // exactly what the profiler's 1.5-IQR count flagged.
  const outlierColumn = numeric.find((column) => (column.outlierCount ?? 0) > 0)
  if (outlierColumn !== undefined && categorical[0] !== undefined) {
    suggestions.push({
      source: profile.source,
      kind: 'boxplot',
      x: categorical[0].name,
      y: outlierColumn.name,
    })
  }

  if (firstNumeric !== undefined) {
    suggestions.push({ source: profile.source, kind: 'histogram', x: firstNumeric.name })
  }

  return suggestions.slice(0, max)
}
