/**
 * The OpenAnalyst workbench: a session-header button that opens a floating
 * panel listing this session's data sources, charts, and generated reports.
 *
 * The model is collected from the DOM this plugin's own conversation nodes
 * render — chart figures carry `data-oa-chart`, and the attach/report marker
 * nodes carry their payload in `data-oa-json`. A MutationObserver keeps the
 * panel current as the conversation grows. Self-contained by design: reading
 * the conversation snapshot from a header slot is not supported by the host
 * (`snapshot.chat` is guarded by the chat render context), and the DOM these
 * markers form is owned entirely by this plugin.
 */

import { createElement as h, Fragment, useEffect, useState, type ReactNode } from 'react'

interface SourceRow {
  readonly alias: string
  readonly origin: string
  readonly rowCount: number
  readonly columns: readonly { readonly name: string }[]
}

interface ChartRow {
  readonly id: string
  readonly title: string
}

interface ReportRow {
  readonly path: string
  readonly title: string
  readonly chartCount: number
}

interface Model {
  readonly sources: readonly SourceRow[]
  readonly charts: readonly ChartRow[]
  readonly reports: readonly ReportRow[]
}

const EMPTY: Model = { sources: [], charts: [], reports: [] }

function parseJsonAttr<T>(element: Element): T | null {
  const raw = element.getAttribute('data-oa-json')
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Collect the workbench model from the plugin's own marker/figure DOM. */
function collect(): Model {
  const sources = new Map<string, SourceRow>()
  for (const marker of document.querySelectorAll('[data-oa-kind="attach"]')) {
    const data = parseJsonAttr<SourceRow>(marker)
    if (data !== null) sources.set(data.alias, data)
  }

  const charts: ChartRow[] = []
  for (const figure of document.querySelectorAll('figure.openanalyst-chart[data-oa-chart]')) {
    const id = figure.getAttribute('data-oa-chart') ?? ''
    const title = figure.querySelector('figcaption')?.textContent?.split('·')[0]?.trim() ?? `chart ${id}`
    charts.push({ id, title })
  }

  const reports: ReportRow[] = []
  for (const marker of document.querySelectorAll('[data-oa-kind="report"]')) {
    const data = parseJsonAttr<ReportRow>(marker)
    if (data !== null) reports.push(data)
  }

  return { sources: [...sources.values()], charts, reports }
}

function sameModel(left: Model, right: Model): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: 56,
  right: 16,
  width: 340,
  maxHeight: 'calc(100vh - 96px)',
  overflowY: 'auto',
  background: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  boxShadow: '0 12px 32px rgba(15, 23, 42, 0.14)',
  padding: '0.75rem',
  zIndex: 60,
  fontSize: 13,
  color: '#111827',
}

const H_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#6b7280',
  margin: '0.6rem 0 0.3rem',
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  padding: '0.3rem 0.4rem',
  borderRadius: 6,
  alignItems: 'baseline',
}

function scrollToChart(id: string): void {
  const target = document.querySelector(`[data-oa-chart="${CSS.escape(id)}"]`)
  target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

export function WorkbenchHeaderAction(): ReactNode {
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState<Model>(EMPTY)

  useEffect(() => {
    let scheduled = false
    const refresh = (): void => {
      if (scheduled) return
      scheduled = true
      // setTimeout, not requestAnimationFrame: rAF never fires in a page
      // that is not compositing (hidden panel, background tab), and the
      // workbench must still fold there.
      setTimeout(() => {
        scheduled = false
        const next = collect()
        setModel((previous) => (sameModel(previous, next) ? previous : next))
      }, 50)
    }
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(document.body, { childList: true, subtree: true })
    return (): void => observer.disconnect()
  }, [])

  const total = model.sources.length + model.charts.length + model.reports.length
  if (total === 0) return null

  return h(
    Fragment,
    null,
    h(
      'button',
      {
        type: 'button',
        onClick: () => setOpen((value) => !value),
        title: 'OpenAnalyst workbench',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          background: open ? '#eff6ff' : 'transparent',
          padding: '2px 8px',
          fontSize: 12,
          cursor: 'pointer',
          color: '#374151',
        },
      },
      '\u{1F4CA}',
      h('span', null, String(model.charts.length)),
    ),
    open
      ? h(
          'div',
          { style: PANEL_STYLE },
          h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'OpenAnalyst · 工作台'),

          model.sources.length > 0
            ? h(
                Fragment,
                null,
                h('div', { style: H_STYLE }, `数据源 Sources (${model.sources.length})`),
                ...model.sources.map((source) =>
                  h(
                    'div',
                    { key: source.alias, style: ROW_STYLE },
                    h('code', { style: { fontWeight: 600 } }, source.alias),
                    h(
                      'span',
                      { style: { color: '#6b7280', fontSize: 12 } },
                      `${source.rowCount.toLocaleString()} 行 · ${source.columns.length} 列`,
                    ),
                  ),
                ),
              )
            : null,

          model.charts.length > 0
            ? h(
                Fragment,
                null,
                h('div', { style: H_STYLE }, `图表 Charts (${model.charts.length})`),
                ...model.charts.map((chart) =>
                  h(
                    'button',
                    {
                      key: chart.id,
                      type: 'button',
                      onClick: () => {
                        scrollToChart(chart.id)
                        setOpen(false)
                      },
                      style: {
                        ...ROW_STYLE,
                        width: '100%',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        textAlign: 'left',
                      },
                    },
                    h('span', null, chart.title),
                    h('span', { style: { color: '#2a78d6', fontSize: 12, flex: 'none' } }, '定位 →'),
                  ),
                ),
              )
            : null,

          model.reports.length > 0
            ? h(
                Fragment,
                null,
                h('div', { style: H_STYLE }, `报告 Reports (${model.reports.length})`),
                ...model.reports.map((report, index) =>
                  h(
                    'div',
                    { key: index, style: { ...ROW_STYLE, flexDirection: 'column', alignItems: 'stretch' } },
                    h('span', { style: { fontWeight: 550 } }, report.title),
                    h(
                      'span',
                      { style: { color: '#6b7280', fontSize: 11, wordBreak: 'break-all' } },
                      `${report.chartCount} chart(s) · ${report.path}`,
                    ),
                  ),
                ),
              )
            : null,
        )
      : null,
  )
}
