import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnalystEngine } from './engine.js'
import { buildChart, suggestCharts } from './chart.js'
import { profileDataset } from './profile.js'
import { SqlPolicyError } from './sql.js'
import type { JsonValue } from './types.js'

const SALES_CSV = fileURLToPath(new URL('../fixtures/sales.csv', import.meta.url))
const SALES_2026_CSV = fileURLToPath(new URL('../../../examples/sales-2026.csv', import.meta.url))

let engine: AnalystEngine

beforeAll(async () => {
  engine = await AnalystEngine.create()
  await engine.attach(SALES_CSV)
})

afterAll(async () => {
  await engine.close()
})

describe('attach', () => {
  it('registers a CSV under a derived alias with inferred types', () => {
    const handle = engine.source('sales')
    expect(handle).toBeDefined()
    expect(handle?.rowCount).toBe(10)
    expect(handle?.columns.map((column) => column.name)).toEqual([
      'order_id',
      'region',
      'product',
      'units',
      'revenue',
      'order_date',
      'rep',
    ])
    expect(handle?.columns.find((column) => column.name === 'revenue')?.sqlType).toBe('DOUBLE')
    expect(handle?.columns.find((column) => column.name === 'order_date')?.sqlType).toBe('DATE')
  })

  it('accepts inline rows', async () => {
    const handle = await engine.attachRows('inline_demo', [
      { a: 1, b: 'x' },
      { a: 2, b: 'y' },
    ])
    expect(handle.rowCount).toBe(2)
    expect(handle.origin).toBe('<inline>')
  })
})

describe('query', () => {
  it('returns lossless JSON rows', async () => {
    const result = await engine.query(
      'SELECT region, sum(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC',
    )
    expect(result.rowCount).toBe(4)
    expect(result.truncated).toBe(false)
    // North: 455.25 + 12299.99 outranks East: 1440 + 3000 + 5390 + 1800.
    expect(result.rows[0]).toEqual({ region: 'North', total: 12755.24 })
    // No BigInt, no wrapper objects: the whole result must survive JSON.
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('converts BIGINT beyond the safe range to a string rather than losing digits', async () => {
    const result = await engine.query('SELECT 9007199254740993::BIGINT AS big')
    expect(result.rows[0]?.['big']).toBe('9007199254740993')
  })

  it('converts DECIMAL to a number and DATE to a stable string', async () => {
    const result = await engine.query(
      "SELECT 1.25::DECIMAL(4,2) AS d, DATE '2026-01-02' AS day",
    )
    expect(result.rows[0]?.['d']).toBe(1.25)
    expect(result.rows[0]?.['day']).toBe('2026-01-02')
  })

  it('marks a clipped result as truncated', async () => {
    const result = await engine.query('SELECT * FROM sales', { maxRows: 3 })
    expect(result.rowCount).toBe(3)
    expect(result.truncated).toBe(true)
  })

  it('does not mark an exactly-at-cap result as truncated', async () => {
    const result = await engine.query('SELECT * FROM sales', { maxRows: 10 })
    expect(result.rowCount).toBe(10)
    expect(result.truncated).toBe(false)
  })

  it('refuses to mutate', async () => {
    await expect(engine.query('DROP VIEW sales')).rejects.toThrow(SqlPolicyError)
    await expect(engine.query('SELECT 1; DROP VIEW sales')).rejects.toThrow(SqlPolicyError)
    // The view must still be there.
    expect((await engine.query('SELECT count(*) AS n FROM sales')).rows[0]?.['n']).toBe(10)
  })

  it('reports a failing query as an error, not a silent empty result', async () => {
    await expect(engine.query('SELECT no_such_column FROM sales')).rejects.toThrow(/Query failed/)
  })
})

describe('profileDataset', () => {
  it('summarises every column', async () => {
    const profile = await profileDataset(engine, 'sales')
    expect(profile.rowCount).toBe(10)
    expect(profile.columnCount).toBe(7)

    const revenue = profile.columns.find((column) => column.name === 'revenue')
    expect(revenue?.kind).toBe('numeric')
    expect(revenue?.nullPercent).toBe(0)
    expect(revenue?.mean).toBeCloseTo(2661.524, 3)
    expect(revenue?.outlierCount).toBeGreaterThanOrEqual(0)

    const region = profile.columns.find((column) => column.name === 'region')
    expect(region?.kind).toBe('categorical')
    expect(region?.distinct).toBe(4)
    expect(region?.distinctExact).toBe(true)
    expect(region?.outlierCount).toBeNull()

    const orderDate = profile.columns.find((column) => column.name === 'order_date')
    expect(orderDate?.kind).toBe('temporal')
  })

  it('flags the column with missing values', async () => {
    const profile = await profileDataset(engine, 'sales')
    const issue = profile.issues.find(
      (candidate) => candidate.kind === 'high-null' && candidate.column === 'units',
    )
    expect(issue).toBeDefined()
    expect(issue?.detail).toContain('10')
  })

  it('produces a JSON-serialisable profile', async () => {
    const profile = await profileDataset(engine, 'sales')
    expect(() => JSON.stringify(profile)).not.toThrow()
  })

  it('rejects an unknown dataset by name', async () => {
    await expect(profileDataset(engine, 'nope')).rejects.toThrow(/No dataset is attached/)
  })

  it('counts distinct values exactly, not from the HyperLogLog sketch', async () => {
    // Regression: DuckDB's SUMMARIZE reports approx_unique = 3 for this
    // column, which actually holds 4 products. A profile is read as fact
    // about the data, so an off-by-one estimate is a wrong answer.
    const wide = await AnalystEngine.create()
    try {
      const handle = await wide.attach(SALES_2026_CSV)
      const profile = await profileDataset(wide, handle.alias)

      const product = profile.columns.find((column) => column.name === 'product')
      expect(product?.distinct).toBe(4)
      expect(product?.distinctExact).toBe(true)

      const approx = await wide.query(
        `SELECT approx_count_distinct(product) AS n FROM ${handle.alias}`,
      )
      expect(approx.rows[0]?.['n']).toBe(3)
    } finally {
      await wide.close()
    }
  })
})

describe('buildChart', () => {
  it('builds a bar chart with data inlined into the spec', async () => {
    const chart = await buildChart(engine, {
      source: 'sales',
      kind: 'bar',
      x: 'region',
      y: 'revenue',
      aggregate: 'sum',
    })

    expect(chart.kind).toBe('bar')
    expect(chart.rowCount).toBe(4)

    const spec = chart.vegaLite as Record<string, JsonValue>
    expect(spec['mark']).toEqual({ type: 'bar', tooltip: true })

    const data = spec['data'] as { values: readonly JsonValue[] }
    expect(data.values).toHaveLength(4)

    const encoding = spec['encoding'] as Record<string, Record<string, JsonValue>>
    expect(encoding['x']?.['field']).toBe('region')
    expect(encoding['x']?.['type']).toBe('nominal')
    expect(encoding['y']?.['field']).toBe('revenue')
    expect(encoding['y']?.['type']).toBe('quantitative')
  })

  it('maps a date axis to a temporal encoding', async () => {
    const chart = await buildChart(engine, {
      source: 'sales',
      kind: 'line',
      x: 'order_date',
      y: 'revenue',
    })
    const encoding = (chart.vegaLite as Record<string, Record<string, Record<string, JsonValue>>>)['encoding']
    expect(encoding?.['x']?.['type']).toBe('temporal')
  })

  it('bins a histogram and needs no y column', async () => {
    const chart = await buildChart(engine, { source: 'sales', kind: 'histogram', x: 'revenue' })
    const encoding = (chart.vegaLite as Record<string, Record<string, Record<string, JsonValue>>>)['encoding']
    expect(encoding?.['x']?.['bin']).toEqual({ maxbins: 30 })
    expect(encoding?.['y']?.['aggregate']).toBe('count')
  })

  it('keeps the spec pure JSON so it can be replayed from a session log', async () => {
    const chart = await buildChart(engine, {
      source: 'sales',
      kind: 'bar',
      x: 'product',
      y: 'units',
    })
    const roundTripped = JSON.parse(JSON.stringify(chart.vegaLite)) as unknown
    expect(roundTripped).toEqual(chart.vegaLite)
  })

  it('rejects a column that is not in the dataset', async () => {
    await expect(
      buildChart(engine, { source: 'sales', kind: 'bar', x: 'nope', y: 'revenue' }),
    ).rejects.toThrow(/is not in "sales"/)
  })

  it('rejects a SQL injection attempt through a column name', async () => {
    await expect(
      buildChart(engine, { source: 'sales', kind: 'bar', x: 'region"; DROP VIEW sales; --', y: 'revenue' }),
    ).rejects.toThrow(/is not in "sales"/)
    expect((await engine.query('SELECT count(*) AS n FROM sales')).rows[0]?.['n']).toBe(10)
  })

  it('requires a y column for non-histogram charts', async () => {
    await expect(engine && buildChart(engine, { source: 'sales', kind: 'bar', x: 'region' })).rejects.toThrow(
      /needs a y column/,
    )
  })
})

describe('new chart kinds', () => {
  let wide: AnalystEngine

  beforeAll(async () => {
    wide = await AnalystEngine.create()
    await wide.attach(SALES_2026_CSV)
  })

  afterAll(async () => {
    await wide.close()
  })

  it('builds a heatmap with aggregated cells and a quantitative color', async () => {
    const chart = await buildChart(wide, {
      source: 'sales_2026',
      kind: 'heatmap',
      x: 'region',
      y: 'product',
      value: 'revenue',
      aggregate: 'sum',
    })
    // 4 regions x 4 products, minus any empty combination.
    expect(chart.rowCount).toBeGreaterThanOrEqual(12)
    expect(chart.rowCount).toBeLessThanOrEqual(16)

    const spec = chart.vegaLite as Record<string, JsonValue>
    expect(spec['mark']).toEqual({ type: 'rect', tooltip: true })
    const encoding = spec['encoding'] as Record<string, Record<string, JsonValue>>
    expect(encoding['color']?.['type']).toBe('quantitative')
    expect(encoding['color']?.['field']).toBe('revenue')
    expect(chart.title).toContain('\u00d7')
  })

  it('requires a value column for heatmaps', async () => {
    await expect(
      buildChart(wide, { source: 'sales_2026', kind: 'heatmap', x: 'region', y: 'product' }),
    ).rejects.toThrow(/needs a numeric/)
  })

  it('builds a boxplot from raw rows with the 1.5-IQR whisker rule', async () => {
    const chart = await buildChart(wide, {
      source: 'sales_2026',
      kind: 'boxplot',
      x: 'region',
      y: 'revenue',
    })
    expect(chart.rowCount).toBe(482)
    const spec = chart.vegaLite as Record<string, JsonValue>
    expect(spec['mark']).toEqual({ type: 'boxplot', extent: 1.5 })
    const encoding = spec['encoding'] as Record<string, Record<string, JsonValue>>
    expect(encoding['y']?.['type']).toBe('quantitative')
  })

  it('samples boxplot rows deterministically past the cap', async () => {
    const first = await buildChart(wide, {
      source: 'sales_2026',
      kind: 'boxplot',
      x: 'region',
      y: 'revenue',
      limit: 100,
    })
    const second = await buildChart(wide, {
      source: 'sales_2026',
      kind: 'boxplot',
      x: 'region',
      y: 'revenue',
      limit: 100,
    })
    expect(first.rowCount).toBe(100)
    // Seeded reservoir: byte-identical across runs, so replay stays pure.
    expect(first.vegaLite).toEqual(second.vegaLite)
  })

  it('lays grouped bars side by side via xOffset', async () => {
    const chart = await buildChart(wide, {
      source: 'sales_2026',
      kind: 'bar',
      x: 'region',
      y: 'revenue',
      color: 'product',
      stack: 'grouped',
    })
    const encoding = (chart.vegaLite as Record<string, Record<string, Record<string, JsonValue>>>)['encoding']
    expect(encoding?.['xOffset']?.['field']).toBe('product')
  })

  it('facets into small multiples with per-panel sizing', async () => {
    const chart = await buildChart(wide, {
      source: 'sales_2026',
      kind: 'line',
      x: 'order_date',
      y: 'revenue',
      facet: 'region',
    })
    const spec = chart.vegaLite as Record<string, JsonValue>
    const encoding = spec['encoding'] as Record<string, Record<string, JsonValue>>
    expect(encoding['facet']?.['field']).toBe('region')
    expect(encoding['facet']?.['columns']).toBe(3)
    expect(spec['width']).toBe(210)
  })

  it('adds pan/zoom params to continuous charts only', async () => {
    const line = await buildChart(wide, { source: 'sales_2026', kind: 'line', x: 'order_date', y: 'revenue' })
    const bar = await buildChart(wide, { source: 'sales_2026', kind: 'bar', x: 'region', y: 'revenue' })
    expect((line.vegaLite as Record<string, unknown>)['params']).toBeDefined()
    expect((bar.vegaLite as Record<string, unknown>)['params']).toBeUndefined()
  })

  it('rejects faceted heatmaps and boxplots', async () => {
    await expect(
      buildChart(wide, { source: 'sales_2026', kind: 'boxplot', x: 'region', y: 'revenue', facet: 'product' }),
    ).rejects.toThrow(/not supported/)
  })
})

describe('suggestCharts', () => {
  it('leads with a time trend and a category breakdown', async () => {
    const profile = await profileDataset(engine, 'sales')
    const suggestions = suggestCharts(profile)

    expect(suggestions.length).toBeGreaterThanOrEqual(2)
    expect(suggestions[0]?.kind).toBe('line')
    expect(suggestions[0]?.x).toBe('order_date')
    expect(suggestions[1]?.kind).toBe('bar')

    // Every suggestion must actually build.
    for (const suggestion of suggestions) {
      const chart = await buildChart(engine, suggestion)
      expect(chart.rowCount).toBeGreaterThan(0)
    }
  })

  it('skips identifier-like columns as bar axes', async () => {
    const profile = await profileDataset(engine, 'sales')
    const suggestions = suggestCharts(profile, 5)
    expect(suggestions.some((item) => item.kind === 'bar' && item.x === 'order_id')).toBe(false)
  })

  it('proposes a heatmap for two small categories plus a measure, and a boxplot for outliers', async () => {
    const wide = await AnalystEngine.create()
    try {
      await wide.attach(SALES_2026_CSV)
      const profile = await profileDataset(wide, 'sales_2026')
      const suggestions = suggestCharts(profile, 8)
      const heatmap = suggestions.find((item) => item.kind === 'heatmap')
      expect(heatmap?.value).toBeDefined()
      expect(suggestions.some((item) => item.kind === 'boxplot')).toBe(true)
      // Every suggestion must actually build.
      for (const suggestion of suggestions) {
        const chart = await buildChart(wide, suggestion)
        expect(chart.rowCount).toBeGreaterThan(0)
      }
    } finally {
      await wide.close()
    }
  })
})
