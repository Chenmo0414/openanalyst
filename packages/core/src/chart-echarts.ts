/**
 * Data preparation for the ECharts kinds.
 *
 * Each kind needs a different SQL shape — a flow needs source/target/weight
 * triples, a hierarchy needs a grouped roll-up, a gauge needs one number — so
 * the queries live here rather than being forced through the Vega-Lite
 * `buildSql` path, which is built around an x/y/colour grammar these kinds do
 * not share.
 */

import type { AnalystEngine } from './engine.js'
import { asNumber } from './json.js'
import { quoteIdentifier } from './sql.js'
import {
  gaugeOption,
  sankeyOption,
  sunburstOption,
  treemapOption,
  type FlowLink,
  type HierarchyNode,
} from './echarts.js'
import { ChartError } from './chart-error.js'
import type { JsonValue } from './types.js'

/** Columns already resolved against the dataset by the caller. */
export interface EchartsColumns {
  readonly x: string
  readonly y: string | null
  readonly value: string | null
}

export interface EchartsBuild {
  readonly spec: JsonValue
  readonly rowCount: number
}

type Row = { readonly [key: string]: JsonValue }

/**
 * Sankey: x is the source category, y the target category, value the weight.
 *
 * Node names are prefixed by side because a value appearing on both sides
 * would otherwise form a self-loop — "East" as a region and "East" as a
 * destination are different nodes.
 */
async function buildSankey(
  engine: AnalystEngine,
  source: string,
  columns: EchartsColumns,
  title: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<EchartsBuild> {
  if (columns.y === null || columns.value === null) {
    throw new ChartError('A sankey chart needs x (source), y (target), and value (flow weight).')
  }
  const table = quoteIdentifier(source)
  const x = quoteIdentifier(columns.x)
  const y = quoteIdentifier(columns.y)
  const value = quoteIdentifier(columns.value)

  const rows = (await engine.queryInternal(
    `SELECT ${x} AS src, ${y} AS dst, sum(${value}) AS weight FROM ${table} ` +
      `WHERE ${x} IS NOT NULL AND ${y} IS NOT NULL GROUP BY ${x}, ${y} ` +
      `ORDER BY weight DESC LIMIT ${limit}`,
    signal,
  )) as readonly Row[]

  const links: FlowLink[] = rows.flatMap((row) => {
    const weight = asNumber(row['weight'] ?? null)
    if (weight === null || weight <= 0) return []
    return [{
      source: `${columns.x}: ${String(row['src'])}`,
      target: `${columns.y}: ${String(row['dst'])}`,
      value: weight,
    }]
  })
  if (links.length === 0) throw new ChartError('No positive flows to draw in this sankey.')

  return { spec: sankeyOption(title, links), rowCount: links.length }
}

/**
 * Hierarchy: x is the outer group, y the optional inner group, value the size.
 * One level when y is absent.
 */
async function buildHierarchy(
  engine: AnalystEngine,
  source: string,
  columns: EchartsColumns,
  title: string,
  limit: number,
  kind: 'sunburst' | 'treemap',
  signal: AbortSignal | undefined,
): Promise<EchartsBuild> {
  if (columns.value === null) {
    throw new ChartError(`A ${kind} chart needs a numeric value column for the leaf sizes.`)
  }
  const table = quoteIdentifier(source)
  const x = quoteIdentifier(columns.x)
  const value = quoteIdentifier(columns.value)
  const inner = columns.y === null ? null : quoteIdentifier(columns.y)

  const grouping = inner === null ? x : `${x}, ${inner}`
  const projection = inner === null ? `${x} AS outer_key` : `${x} AS outer_key, ${inner} AS inner_key`
  const rows = (await engine.queryInternal(
    `SELECT ${projection}, sum(${value}) AS size FROM ${table} ` +
      `WHERE ${x} IS NOT NULL GROUP BY ${grouping} ORDER BY size DESC LIMIT ${limit}`,
    signal,
  )) as readonly Row[]

  const roots = new Map<string, { total: number; children: Map<string, number> }>()
  for (const row of rows) {
    const size = asNumber(row['size'] ?? null)
    if (size === null || size <= 0) continue
    const outer = String(row['outer_key'])
    const entry = roots.get(outer) ?? { total: 0, children: new Map<string, number>() }
    entry.total += size
    if (inner !== null) {
      const innerKey = String(row['inner_key'])
      entry.children.set(innerKey, (entry.children.get(innerKey) ?? 0) + size)
    }
    roots.set(outer, entry)
  }
  if (roots.size === 0) throw new ChartError(`No positive values to draw in this ${kind}.`)

  const hierarchy: HierarchyNode[] = [...roots].map(([name, entry]) => ({
    name,
    value: entry.total,
    ...(entry.children.size === 0
      ? {}
      : { children: [...entry.children].map(([child, size]) => ({ name: child, value: size })) }),
  }))

  const leaves = hierarchy.reduce((sum, node) => sum + (node.children?.length ?? 1), 0)
  const spec = kind === 'sunburst' ? sunburstOption(title, hierarchy) : treemapOption(title, hierarchy)
  return { spec, rowCount: leaves }
}

/**
 * Gauge: one aggregate of `value`, scaled against the column's own range so
 * the needle position means something without the caller supplying bounds.
 */
async function buildGauge(
  engine: AnalystEngine,
  source: string,
  columns: EchartsColumns,
  title: string,
  aggregate: string,
  signal: AbortSignal | undefined,
): Promise<EchartsBuild> {
  if (columns.value === null) {
    throw new ChartError('A gauge needs a numeric value column.')
  }
  const table = quoteIdentifier(source)
  const value = quoteIdentifier(columns.value)
  const measure = aggregate === 'count' ? `count(${value})` : `${aggregate}(${value})`

  const [row] = (await engine.queryInternal(
    `SELECT ${measure} AS reading, min(${value}) AS low, max(${value}) AS high FROM ${table}`,
    signal,
  )) as readonly Row[]

  const reading = asNumber(row?.['reading'] ?? null)
  if (reading === null) throw new ChartError(`Column "${columns.value}" has no numeric value to gauge.`)

  const low = asNumber(row?.['low'] ?? null) ?? 0
  const high = asNumber(row?.['high'] ?? null) ?? reading
  // A count or a sum exceeds the column's own max, so widen to fit the reading.
  const max = Math.max(high, reading)
  const min = Math.min(low, 0, reading)

  const rounded = Math.round(reading * 100) / 100
  return {
    spec: gaugeOption(title, rounded, min, max === min ? min + 1 : max, `${aggregate}(${columns.value})`),
    rowCount: 1,
  }
}

/** Build one ECharts-backed chart. */
export async function buildEchartsChart(
  engine: AnalystEngine,
  kind: 'sankey' | 'sunburst' | 'treemap' | 'gauge',
  source: string,
  columns: EchartsColumns,
  title: string,
  aggregate: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<EchartsBuild> {
  switch (kind) {
    case 'sankey':
      return buildSankey(engine, source, columns, title, limit, signal)
    case 'sunburst':
    case 'treemap':
      return buildHierarchy(engine, source, columns, title, limit, kind, signal)
    case 'gauge':
      return buildGauge(engine, source, columns, title, aggregate === 'none' ? 'sum' : aggregate, signal)
  }
}
