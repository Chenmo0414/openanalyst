/**
 * Self-contained HTML analysis report.
 *
 * One file, zero external requests: styles inlined, every chart embedded as
 * SVG markup. It opens from disk, attaches to an email, and prints to PDF from
 * any browser — which is why PDF is not a separate export path.
 */

import {
  buildChart,
  profileDataset,
  suggestCharts,
  type AnalystEngine,
  type ChartRequest,
  type ChartSpec,
  type DatasetProfile,
} from '@openanalyst/core'
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

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '<span class="null">null</span>'
  if (typeof value === 'number') {
    return escapeHtml(Number.isInteger(value) ? String(value) : value.toLocaleString('en-US', { maximumFractionDigits: 3 }))
  }
  return escapeHtml(String(value))
}

function profileSection(profile: DatasetProfile): string {
  const header =
    '<tr><th>column</th><th>type</th><th>kind</th><th>null %</th><th>distinct</th>' +
    '<th>mean</th><th>stddev</th><th>outliers</th></tr>'
  const rows = profile.columns
    .map(
      (column) =>
        `<tr><td><code>${escapeHtml(column.name)}</code></td><td>${escapeHtml(column.sqlType)}</td>` +
        `<td>${column.kind}</td><td>${column.nullPercent}%</td>` +
        `<td>${column.distinct}${column.distinctExact ? '' : ' <span class="approx">≈</span>'}</td>` +
        `<td>${formatCell(column.mean)}</td><td>${formatCell(column.stddev)}</td>` +
        `<td>${formatCell(column.outlierCount)}</td></tr>`,
    )
    .join('\n')

  const issues =
    profile.issues.length === 0
      ? '<p class="ok">No data-quality issues found.</p>'
      : '<ul class="issues">' +
        profile.issues
          .map(
            (issue) =>
              `<li class="${issue.severity}"><b>${issue.severity}</b> · ` +
              `${issue.column === null ? 'table' : `<code>${escapeHtml(issue.column)}</code>`}: ` +
              `${escapeHtml(issue.detail)}</li>`,
          )
          .join('\n') +
        '</ul>'

  return (
    `<section><h2>${escapeHtml(profile.source)}</h2>` +
    `<p class="meta">${profile.rowCount.toLocaleString('en-US')} rows × ${profile.columnCount} columns</p>` +
    `<table>${header}\n${rows}</table>` +
    `<h3>Data quality</h3>${issues}</section>`
  )
}

function chartSection(chart: ChartSpec, svg: string): string {
  return (
    `<figure><figcaption>${escapeHtml(chart.title)} · ${chart.rowCount} point(s)</figcaption>` +
    `${svg}</figure>`
  )
}

const STYLE = `
  :root { color-scheme: light; }
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a202c;
         max-width: 960px; margin: 2rem auto; padding: 0 1.25rem; background: #ffffff; }
  h1 { font-size: 1.6rem; border-bottom: 2px solid #e2e8f0; padding-bottom: .5rem; }
  h2 { font-size: 1.25rem; margin-top: 2.2rem; }
  h3 { font-size: 1rem; margin-top: 1.4rem; }
  .meta, .generated { color: #64748b; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { border: 1px solid #e2e8f0; padding: .35rem .6rem; text-align: left; }
  th { background: #f8fafc; }
  code { background: #f1f5f9; padding: 0 .25rem; border-radius: 3px; }
  .null { color: #94a3b8; font-style: italic; }
  .approx { color: #b45309; }
  .issues { padding-left: 1.2rem; }
  .issues .warn { color: #b91c1c; }
  .issues .info { color: #475569; }
  .ok { color: #15803d; }
  figure { margin: 1.6rem 0; }
  figcaption { font-size: .85rem; color: #64748b; margin-bottom: .4rem; }
  figure svg { max-width: 100%; height: auto; }
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
    `<h1>${escapeHtml(title)}</h1>\n<p class="generated">Generated by OpenAnalyst</p>\n` +
    sections.join('\n') +
    '\n</body>\n</html>\n'

  return { html, title, sources, chartCount }
}
