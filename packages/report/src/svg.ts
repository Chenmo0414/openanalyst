/**
 * Chart spec -> SVG string, pure JS, for both engines.
 *
 * No canvas binding, no headless browser: `vega`'s SVG renderer and ECharts'
 * SSR mode both run anywhere Node runs, which keeps every consumer — the
 * `npx`-installed MCP server included — a zero-toolchain install.
 *
 * This module is also what lets the DeepSeek Harness browser half stay on
 * Vega-Lite alone. ECharts kinds are rendered to SVG here, on the host, and
 * the markup travels in the session event; the browser displays it without
 * bundling a second 600 kB chart runtime that a chart-free session would still
 * have to download.
 */

import * as vega from 'vega'
import * as vegaLite from 'vega-lite'
import * as echarts from 'echarts'
import type { ChartEngine, ChartSpec, JsonValue } from '@tukey/core'

/** Default raster width: the core emits `width: 'container'`, which only
 * means something inside a browser layout. */
export const DEFAULT_SVG_WIDTH = 640

/** Default height for ECharts kinds, which size to their container. */
const DEFAULT_ECHARTS_HEIGHT = 320

async function vegaLiteToSvg(spec: JsonValue, width: number): Promise<string> {
  const cloned = structuredClone(spec as Record<string, JsonValue>)
  // A faceted spec sizes per panel and rejects autosize "fit"; leave its own
  // width/autosize untouched and only pin single-view specs to a raster width.
  const faceted =
    typeof cloned['encoding'] === 'object' &&
    cloned['encoding'] !== null &&
    'facet' in (cloned['encoding'] as Record<string, unknown>)
  const pinned = faceted
    ? cloned
    : { ...cloned, width, autosize: { type: 'fit', contains: 'padding' } }

  const compiled = vegaLite.compile(pinned as never).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  try {
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}

function echartsToSvg(option: JsonValue, width: number, height: number): string {
  // ssr: true gives a headless instance; the SVG renderer keeps it pure JS.
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height })
  try {
    // Unlike vega's parse(), setOption does not mutate the option object —
    // verified — so the caller's spec stays a clean whole-value checkpoint.
    chart.setOption(option as never)
    return chart.renderToSVGString()
  } finally {
    chart.dispose()
  }
}

/**
 * Render one self-contained chart spec to an SVG string.
 *
 * The Vega-Lite path deep-copies first: vega's `parse()` MUTATES the inlined
 * data rows (it stamps a `Symbol(vega_id)` on each), and callers hand the same
 * spec object onward in protocol payloads.
 */
export async function chartToSvg(
  spec: JsonValue,
  width = DEFAULT_SVG_WIDTH,
  engine: ChartEngine = 'vega-lite',
): Promise<string> {
  return engine === 'echarts'
    ? echartsToSvg(spec, width, DEFAULT_ECHARTS_HEIGHT)
    : vegaLiteToSvg(spec, width)
}

/** Render a built chart, taking the engine from the chart itself. */
export async function renderChart(chart: ChartSpec, width = DEFAULT_SVG_WIDTH): Promise<string> {
  return chartToSvg(chart.spec, width, chart.engine)
}
