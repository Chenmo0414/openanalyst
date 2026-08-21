/**
 * Self-contained HTML analysis report.
 *
 * One file, zero external requests: styles inlined, every chart embedded as
 * SVG markup. It opens from disk, attaches to an email, and prints to PDF from
 * any browser — which is why PDF is not a separate export path.
 *
 * The layout follows the data-viz method this repo's charts use: a stat-tile
 * row for the headline numbers, charts on cards with recessive chrome, tables
 * with right-aligned tabular numerals, and status severities carried by an
 * icon + label pairing — never by color alone. The report deliberately commits
 * to a single light look: its destiny is print.
 */

import {
  buildChart,
  profileDataset,
  suggestCharts,
  type AnalystEngine,
  type ChartRequest,
  type ChartSpec,
  type ColumnProfile,
  type DatasetProfile,
} from '@tukey/core'
import { chartToSvg } from './svg.js'

export interface ReportOptions {
  /** Dataset aliases to include. Every attached file source when omitted. */
  readonly sources?: readonly string[]
  /** Report title. */
  readonly title?: string
  /**
   * Charts to render per source. When omitted, each dataset gets its
   * profile-driven suggestions (the same ones `data_profile` returns).
   */
  readonly charts?: readonly ChartRequest[]
  readonly signal?: AbortSignal
}

export interface BuiltReport {
  readonly html: string
  readonly title: string
  /** Sources actually included. */
  readonly sources: readonly string[]
  readonly chartCount: number
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const NUMBER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function formatNumber(value: number): string {
  return NUMBER.format(value)
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '<span class="null">—</span>'
  if (typeof value === 'number') return escapeHtml(formatNumber(value))
  return escapeHtml(String(value))
}

const KIND_LABEL: Record<ColumnProfile['kind'], string> = {
  numeric: 'num',
  temporal: 'time',
  categorical: 'cat',
  boolean: 'bool',
  other: 'other',
}

function statTile(label: string, value: string, hint?: string): string {
  return (
    `<div class="tile"><div class="tile-label">${escapeHtml(label)}</div>` +
    `<div class="tile-value">${escapeHtml(value)}</div>` +
    (hint === undefined ? '' : `<div class="tile-hint">${escapeHtml(hint)}</div>`) +
    `</div>`
  )
}

function profileSection(profile: DatasetProfile): string {
  const warnings = profile.issues.filter((issue) => issue.severity === 'warn').length

  const tiles =
    `<div class="tiles">` +
    statTile('Rows', formatNumber(profile.rowCount)) +
    statTile('Columns', String(profile.columnCount)) +
    statTile(
      'Quality findings',
      String(profile.issues.length),
      warnings > 0 ? `${warnings} need attention` : 'none critical',
    ) +
    statTile(
      'Complete cells',
      `${(
        100 -
        profile.columns.reduce((sum, column) => sum + column.nullPercent, 0) /
          Math.max(1, profile.columnCount)
      ).toFixed(1)}%`,
      'average across columns',
    ) +
    `</div>`

  const header =
    '<tr><th>Column</th><th>Type</th><th class="num">Null %</th><th class="num">Distinct</th>' +
    '<th class="num">Mean</th><th class="num">Std dev</th><th class="num">Outliers</th></tr>'
  const rows = profile.columns
    .map(
      (column) =>
        `<tr><td class="col-name">${escapeHtml(column.name)}` +
        `<span class="badge badge-${column.kind}">${KIND_LABEL[column.kind]}</span></td>` +
        `<td class="type">${escapeHtml(column.sqlType)}</td>` +
        `<td class="num">${column.nullPercent === 0 ? '<span class="null">0</span>' : `${column.nullPercent}%`}</td>` +
        `<td class="num">${formatNumber(column.distinct)}${column.distinctExact ? '' : ' <span title="HyperLogLog estimate">≈</span>'}</td>` +
        `<td class="num">${formatCell(column.mean)}</td>` +
        `<td class="num">${formatCell(column.stddev)}</td>` +
        `<td class="num">${column.outlierCount === null ? '<span class="null">—</span>' : formatCell(column.outlierCount)}</td></tr>`,
    )
    .join('\n')

  const issues =
    profile.issues.length === 0
      ? '<p class="ok">✓ No data-quality issues found.</p>'
      : '<ul class="issues">' +
        profile.issues
          .map(
            (issue) =>
              `<li class="issue-${issue.severity}">` +
              `<span class="issue-mark">${issue.severity === 'warn' ? '⚠' : 'ℹ'}</span>` +
              `<span><b>${issue.column === null ? 'table' : escapeHtml(issue.column)}</b> · ` +
              `${escapeHtml(issue.detail)}</span></li>`,
          )
          .join('\n') +
        '</ul>'

  return (
    `<section><h2>${escapeHtml(profile.source)}</h2>` +
    tiles +
    `<div class="card"><table>${header}\n${rows}</table></div>` +
    `<h3>Data quality</h3>${issues}</section>`
  )
}

function chartSection(chart: ChartSpec, svg: string): string {
  return (
    `<figure class="card chart-card">` +
    `${svg}` +
    `<figcaption>${escapeHtml(chart.title)} · ${formatNumber(chart.rowCount)} point(s)</figcaption>` +
    `</figure>`
  )
}

const STYLE = `
  :root {
    color-scheme: light;
    --surface: #fcfcfb;
    --card: #ffffff;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --ink-3: #8a887f;
    --edge: #e7e5e0;
    --accent: #2a78d6;
    --warn: #d03b3b;
  }
  * { box-sizing: border-box; }
  body {
    font: 15px/1.55 Inter, "SF Pro Text", "Segoe UI", system-ui, -apple-system,
      "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--ink);
    background: var(--surface);
    max-width: 880px;
    margin: 0 auto;
    padding: 3rem 1.5rem 4rem;
  }
  header.report { margin-bottom: 2.25rem; }
  h1 { font-size: 1.7rem; font-weight: 650; letter-spacing: -0.015em; margin: 0 0 .3rem; }
  .generated { color: var(--ink-3); font-size: .85rem; margin: 0; }
  h2 { font-size: 1.15rem; font-weight: 600; letter-spacing: -0.01em; margin: 2.6rem 0 1rem; }
  h3 { font-size: .95rem; font-weight: 600; color: var(--ink-2); margin: 1.8rem 0 .6rem; }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin-bottom: 1.25rem; }
  .tile { background: var(--card); border: 1px solid var(--edge); border-radius: 10px; padding: .8rem 1rem; }
  .tile-label { font-size: .75rem; color: var(--ink-3); }
  .tile-value { font-size: 1.5rem; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin-top: .1rem; }
  .tile-hint { font-size: .72rem; color: var(--ink-3); margin-top: .15rem; }

  .card { background: var(--card); border: 1px solid var(--edge); border-radius: 12px; overflow: hidden; }
  .chart-card { margin: 1.1rem 0; padding: 1.1rem 1.1rem .7rem; }
  .chart-card svg { max-width: 100%; height: auto; display: block; }
  figcaption { font-size: .78rem; color: var(--ink-3); margin-top: .55rem; }

  table { border-collapse: collapse; width: 100%; font-size: .84rem; }
  th, td { padding: .5rem .8rem; text-align: left; border-bottom: 1px solid var(--edge); }
  tr:last-child td { border-bottom: none; }
  th { background: #f7f6f3; color: var(--ink-2); font-weight: 550; font-size: .76rem; }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.type { color: var(--ink-3); font: .78rem/1.4 ui-monospace, "Cascadia Code", Consolas, monospace; }
  td.col-name { font-weight: 550; }
  .null { color: #b9b7ae; }

  .badge { display: inline-block; font-size: .64rem; font-weight: 600; text-transform: uppercase;
           letter-spacing: .04em; border-radius: 4px; padding: .1rem .35rem; margin-left: .5rem;
           vertical-align: 1px; }
  .badge-numeric { background: #e4eefb; color: #1c5cab; }
  .badge-temporal { background: #e2f4ec; color: #0c6b4a; }
  .badge-categorical { background: #fdeee6; color: #a83f16; }
  .badge-boolean { background: #efe9fb; color: #4a3aa7; }
  .badge-other { background: #efeeea; color: var(--ink-2); }

  .issues { list-style: none; padding: 0; margin: 0; display: grid; gap: .45rem; }
  .issues li { display: flex; gap: .6rem; align-items: baseline; background: var(--card);
               border: 1px solid var(--edge); border-radius: 8px; padding: .55rem .8rem; font-size: .85rem; }
  .issue-warn { border-left: 3px solid var(--warn); }
  .issue-info { border-left: 3px solid var(--edge); color: var(--ink-2); }
  .issue-mark { flex: none; }
  .issue-warn .issue-mark { color: var(--warn); }
  .ok { color: #0c6b4a; }

  footer { margin-top: 3rem; font-size: .75rem; color: var(--ink-3); border-top: 1px solid var(--edge); padding-top: .8rem; }
  @media print {
    body { max-width: none; padding: 0; }
    .card, .tile, .issues li { break-inside: avoid; }
  }
`

/**
 * Build a self-contained HTML report for the attached datasets.
 *
 * @throws when a requested source is not attached, or nothing is attached.
 */
export async function buildHtmlReport(
  engine: AnalystEngine,
  options: ReportOptions = {},
): Promise<BuiltReport> {
  const sources =
    options.sources ?? engine.sources().map((handle) => handle.alias)
  if (sources.length === 0) {
    throw new Error('Nothing to report on: attach at least one dataset first.')
  }

  const title = options.title ?? `Data report — ${sources.join(', ')}`
  const sections: string[] = []
  let chartCount = 0

  for (const source of sources) {
    const profile = await profileDataset(engine, source, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    sections.push(profileSection(profile))

    const requests =
      options.charts?.filter((request) => request.source === source) ??
      suggestCharts(profile)
    for (const request of requests) {
      const chart = await buildChart(engine, {
        ...request,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      sections.push(chartSection(chart, await chartToSvg(chart.vegaLite)))
      chartCount += 1
    }
  }

  // The timestamp is presentation, not data: reports are files a human dates
  // by their filesystem entry anyway, and keeping it out of tests' way matters
  // more than embedding a second clock.
  const html =
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(title)}</title>\n<style>${STYLE}</style>\n</head>\n<body>\n` +
    `<header class="report"><h1>${escapeHtml(title)}</h1>\n` +
    `<p class="generated">Generated by Tukey</p></header>\n` +
    sections.join('\n') +
    '\n<footer>Tukey · DuckDB · Vega-Lite — self-contained report, prints to PDF</footer>' +
    '\n</body>\n</html>\n'

  return { html, title, sources, chartCount }
}
