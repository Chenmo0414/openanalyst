/**
 * The OpenAnalyst chart theme, as a Vega-Lite `config` block.
 *
 * One definition serves every renderer — the dsh conversation node, the
 * server-side SVG in reports, and any MCP client that draws the spec itself —
 * because it travels INSIDE the spec rather than being a renderer option.
 *
 * The palette is the validated reference instance from the data-viz method
 * (adjacent-pair CVD ΔE ≥ 8, normal-vision ΔE ≥ 15, checked with its
 * validator, not by eye). Slots are assigned in fixed order and never cycled;
 * three light-surface slots sit below 3:1 contrast, which is why every chart
 * keeps visible axis labels and tooltips as the mandated relief.
 */

import type { JsonValue } from './types.js'

/** Categorical slots, fixed order. The order IS the CVD-safety mechanism. */
export const CATEGORICAL = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
  '#e34948', // red
] as const

/** Single-series mark color: categorical slot 1. */
export const SERIES_1 = CATEGORICAL[0]

/** Ink tokens (light surface). Text never wears a series color. */
const INK = '#0b0b0b'
const INK_SECONDARY = '#52514e'
const INK_MUTED = '#8a887f'
const GRID = '#ecebe7'
const AXIS = '#d6d4cd'

const FONT =
  'Inter, "SF Pro Text", "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'

/**
 * The shared Vega-Lite config. Marks stay thin, grid recessive, data-ends
 * rounded at 4px (square at the baseline), lines 2px with ≥8px point markers —
 * the mark specs of the method, expressed as Vega-Lite options.
 */
export const CHART_CONFIG: JsonValue = {
  background: 'transparent',
  font: FONT,
  view: { stroke: null },
  padding: { top: 8, right: 12, bottom: 4, left: 4 },
  title: {
    font: FONT,
    fontSize: 14,
    fontWeight: 600,
    color: INK,
    anchor: 'start',
    offset: 14,
    subtitleColor: INK_SECONDARY,
  },
  axis: {
    labelFont: FONT,
    labelFontSize: 11,
    labelColor: INK_SECONDARY,
    titleFont: FONT,
    titleFontSize: 11,
    titleFontWeight: 500,
    titleColor: INK_MUTED,
    titlePadding: 10,
    gridColor: GRID,
    gridWidth: 1,
    domainColor: AXIS,
    tickColor: AXIS,
    tickSize: 4,
  },
  axisX: { grid: false },
  // Horizontal category labels; vega's auto-overlap handles the long tail.
  axisXDiscrete: { labelAngle: 0 },
  axisY: { domain: false, ticks: false, labelPadding: 6 },
  legend: {
    labelFont: FONT,
    labelFontSize: 11,
    labelColor: INK_SECONDARY,
    titleFont: FONT,
    titleFontSize: 11,
    titleFontWeight: 500,
    titleColor: INK_MUTED,
    symbolSize: 80,
    symbolType: 'circle',
  },
  range: { category: [...CATEGORICAL] },
  bar: {
    fill: SERIES_1,
    cornerRadiusTopLeft: 4,
    cornerRadiusTopRight: 4,
    // Mark-spec cap: bars stay <=24px thick — the band's leftover is air,
    // not wider bars.
    discreteBandSize: 24,
  },
  line: { stroke: SERIES_1, strokeWidth: 2, strokeJoin: 'round', strokeCap: 'round' },
  point: { fill: SERIES_1, size: 64, filled: true, stroke: '#ffffff', strokeWidth: 1 },
  area: { fill: SERIES_1, line: { stroke: SERIES_1, strokeWidth: 2 }, opacity: 0.16 },
  rule: { color: AXIS },
}
