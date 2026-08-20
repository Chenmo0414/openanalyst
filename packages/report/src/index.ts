/**
 * @openanalyst/report — chart rendering (Vega-Lite -> SVG, pure JS) and
 * self-contained HTML reports over `@openanalyst/core`.
 *
 * Split from the core so hosts that render charts themselves (the dsh browser
 * half) never carry the server-side vega dependency.
 */

export { chartToSvg, DEFAULT_SVG_WIDTH } from './svg.js'
export { buildHtmlReport } from './html.js'
export type { BuiltReport, ReportOptions } from './html.js'
