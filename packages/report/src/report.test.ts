import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnalystEngine, buildChart } from '@tukey/core'
import { buildHtmlReport } from './html.js'
import { chartToSvg, renderChart } from './svg.js'

const SALES_CSV = fileURLToPath(new URL('../../../examples/sales-2026.csv', import.meta.url))

let engine: AnalystEngine

beforeAll(async () => {
  engine = await AnalystEngine.create()
  await engine.attach(SALES_CSV)
})

afterAll(async () => {
  await engine.close()
})

describe('chartToSvg', () => {
  it('renders SVG without mutating the spec', async () => {
    const chart = await buildChart(engine, {
      source: 'sales_2026',
      kind: 'bar',
      x: 'region',
      y: 'revenue',
    })
    const before = JSON.stringify(chart.spec)
    const svg = await chartToSvg(chart.spec)

    expect(svg).toContain('<svg')
    expect(svg.length).toBeGreaterThan(2000)
    // The regression the MCP tests caught: vega parse() stamps Symbol(vega_id)
    // onto shared data rows. JSON text equality proves no enumerable change;
    // the deep clone inside chartToSvg guards the symbol case.
    expect(JSON.stringify(chart.spec)).toBe(before)
  })
})

describe('ECharts rendering', () => {
  it('renders an ECharts kind to SVG without a canvas or a browser', async () => {
    const chart = await buildChart(engine, {
      source: 'sales_2026',
      kind: 'sankey',
      x: 'region',
      y: 'product',
      value: 'revenue',
    })
    expect(chart.engine).toBe('echarts')
    const before = JSON.stringify(chart.spec)
    const svg = await renderChart(chart)

    expect(svg).toContain('<svg')
    expect(svg.length).toBeGreaterThan(1000)
    // ECharts' setOption must not mutate the option — the spec is a durable
    // whole-value checkpoint that gets re-rendered on every replay.
    expect(JSON.stringify(chart.spec)).toBe(before)
  })

  it('dispatches on the chart engine, not the caller', async () => {
    const vegaChart = await buildChart(engine, {
      source: 'sales_2026',
      kind: 'bar',
      x: 'region',
      y: 'revenue',
    })
    const gauge = await buildChart(engine, {
      source: 'sales_2026',
      kind: 'gauge',
      x: 'region',
      value: 'revenue',
      aggregate: 'avg',
    })
    for (const chart of [vegaChart, gauge]) {
      expect(await renderChart(chart)).toContain('<svg')
    }
  })
})

describe('buildHtmlReport', () => {
  it('builds a self-contained document with profile, issues, and charts', async () => {
    const report = await buildHtmlReport(engine, { title: 'Sales 2026 review' })

    expect(report.title).toBe('Sales 2026 review')
    expect(report.sources).toEqual(['sales_2026'])
    expect(report.chartCount).toBeGreaterThanOrEqual(2)

    const { html } = report
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('Sales 2026 review')
    // Profile table, stat tiles, and the known quality findings.
    expect(html).toContain('class="col-name">revenue')
    expect(html).toContain('class="tiles"')
    expect(html).toContain('exact duplicates')
    // Charts are embedded as inline SVG, not referenced. Self-contained means
    // no element FETCHES anything: no src/href pointing at a URL. (SVG's
    // xmlns is a namespace identifier, not a request.)
    expect((html.match(/<svg/g) ?? []).length).toBe(report.chartCount)
    expect(html).not.toMatch(/\s(?:src|href)\s*=\s*"https?:/i)
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<script')
  })

  it('honours an explicit chart list', async () => {
    const report = await buildHtmlReport(engine, {
      sources: ['sales_2026'],
      charts: [
        { source: 'sales_2026', kind: 'histogram', x: 'revenue' },
      ],
    })
    expect(report.chartCount).toBe(1)
    expect(report.html).toContain('Distribution of revenue')
  })

  it('fails loud with nothing attached', async () => {
    const empty = await AnalystEngine.create()
    try {
      await expect(buildHtmlReport(empty)).rejects.toThrow(/attach at least one/)
    } finally {
      await empty.close()
    }
  })

  it('escapes HTML in titles', async () => {
    const report = await buildHtmlReport(engine, { title: '<script>alert(1)</script>' })
    expect(report.html).not.toContain('<script>alert')
    expect(report.html).toContain('&lt;script&gt;')
  })
})
