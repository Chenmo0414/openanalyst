/**
 * Tukey — the DeepSeek Harness host half.
 *
 * Registers five model-facing tools over `@tukey/core`. Every tool is
 * also reachable from Code Mode as `await tools.data_*(args)` at no extra cost,
 * so the model can chain attach -> profile -> query -> chart inside one program
 * instead of spending a round trip per step. That is why each `output.schema`
 * is written as a programmatic API — handles and fields, with the prose kept in
 * `output.render`.
 *
 * @module tukey
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue as SessionJsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import {
  AnalystEngine,
  attachDatabase,
  buildChart,
  profileDataset,
  suggestCharts,
  type ChartKind,
  type DatabaseKind,
} from '@tukey/core'
import { buildHtmlReport, renderChart } from '@tukey/report'
import { registerPluginEvents } from './events.ts'

export type * from './events.ts'

export const name = 'tukey'
export const inject = ['tools']

const CHART_KINDS = ['bar', 'line', 'scatter', 'histogram', 'area', 'heatmap', 'boxplot', 'sankey', 'sunburst', 'treemap', 'gauge'] as const
const AGGREGATES = ['sum', 'avg', 'count', 'min', 'max', 'none'] as const

/** Reusable schema fragment for a column profile row. */
const COLUMN_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    sqlType: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    nullPercent: { type: 'number', required: true },
    distinct: { type: 'number', required: true },
    distinctExact: {
      type: 'boolean',
      required: true,
      description: 'False means distinct is a HyperLogLog estimate, not a fact.',
    },
    mean: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    stddev: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
    outlierCount: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
  },
} as const

interface ProfileView {
  readonly source: string
  readonly rowCount: number
  readonly columnCount: number
  readonly columns: readonly { readonly name: string; readonly sqlType: string }[]
  readonly issues: readonly {
    readonly severity: string
    readonly column: string | null
    readonly detail: string
  }[]
}

function summarizeProfile(profile: ProfileView): string {
  const warnings = profile.issues.filter((issue) => issue.severity === 'warn')
  const head =
    `${profile.source}: ${profile.rowCount} rows x ${profile.columnCount} columns.`
  const kinds = profile.columns
    .map((column) => `${column.name} (${column.sqlType})`)
    .join(', ')
  const problems =
    profile.issues.length === 0
      ? 'No data-quality issues found.'
      : `${profile.issues.length} issue(s), ${warnings.length} needing attention:\n` +
        profile.issues
          .slice(0, 8)
          .map((issue) => `- [${issue.severity}] ${issue.column ?? 'table'}: ${issue.detail}`)
          .join('\n')

  return `${head}\nColumns: ${kinds}\n${problems}`
}

function summarizeChart(chart: {
  readonly kind: string
  readonly title: string
  readonly rowCount: number
}): string {
  return `Rendered a ${chart.kind} chart "${chart.title}" from ${chart.rowCount} data point(s). It is displayed in the conversation.`
}

/** Engines the plugin may hold at once; beyond this, the least-recent goes. */
const MAX_ENGINES = 32

export function apply(ctx: Context): void {
  // Must run before any session containing our events is cold-loaded — see
  // registerPluginEvents' doc for why this exists at all.
  registerPluginEvents()

  // One engine PER AGENT, keyed by the owning session id, so two sessions
  // attaching the same alias no longer collide. An agentless caller (rare —
  // e.g. a direct host invocation) shares one fallback engine. The harness
  // does not notify plugins when an agent is disposed, so the map is bounded:
  // past MAX_ENGINES the least-recently-used engine is closed, and that
  // session simply re-attaches on its next call.
  const engines = new Map<string, AnalystEngine>()

  const getEngine = async (exec: { agent?: { id: string } }): Promise<AnalystEngine> => {
    const key = exec.agent?.id ?? '<agentless>'
    const existing = engines.get(key)
    if (existing !== undefined) {
      // Refresh recency (Map preserves insertion order).
      engines.delete(key)
      engines.set(key, existing)
      return existing
    }
    const created = await AnalystEngine.create()
    engines.set(key, created)
    if (engines.size > MAX_ENGINES) {
      const [oldestKey] = engines.keys()
      if (oldestKey !== undefined) {
        const oldest = engines.get(oldestKey)
        engines.delete(oldestKey)
        void oldest?.close()
      }
    }
    return created
  }

  // cordis 4 has no 'dispose' event; a teardown effect is the supported way
  // to release resources with the plugin fiber.
  ctx.effect(() => () => {
    for (const engine of engines.values()) void engine.close()
    engines.clear()
  })

  ctx.tools.register(
    defineTool({
      name: 'data_attach',
      description:
        'Register a data file so it can be profiled, queried, and charted. Supports CSV, TSV, ' +
        'Parquet, JSON/NDJSON, and XLSX. Returns the alias the dataset is queryable under. ' +
        'Call this before data_profile, data_query, or data_chart.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute or workspace-relative path to the data file.',
        },
        alias: {
          type: 'string',
          description: 'Name to query the dataset by. Derived from the filename when omitted.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            alias: { type: 'string', required: true },
            origin: { type: 'string', required: true },
            rowCount: { type: 'number', required: true },
            columns: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  sqlType: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Attached "${value.alias}" (${value.rowCount} rows): ` +
              value.columns.map((column) => `${column.name} ${column.sqlType}`).join(', '),
          },
        ],
      },
      async execute(args, exec) {
        const active = await getEngine(exec)
        const handle = await active.attach(
          args.path,
          args.alias === undefined ? { signal: exec.signal } : { alias: args.alias, signal: exec.signal },
        )
        const columns = handle.columns.map((column) => ({ name: column.name, sqlType: column.sqlType }))
        // Durable breadcrumb for the workbench's data-source list.
        exec.agent?.session.append('tukey/attach', {
          alias: handle.alias,
          origin: handle.origin,
          rowCount: handle.rowCount,
          columns,
        })
        return {
          alias: handle.alias,
          origin: handle.origin,
          rowCount: handle.rowCount,
          columns,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'data_profile',
      description:
        'Profile an attached dataset in one pass: per-column type, missing values, distinct count, ' +
        'quartiles, mean, standard deviation, and IQR outliers, plus data-quality issues worth ' +
        'fixing before analysis. Also returns chart suggestions you can pass straight to data_chart.',
      parameters: {
        source: {
          type: 'string',
          required: true,
          description: 'Alias returned by data_attach.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', required: true },
            rowCount: { type: 'number', required: true },
            columnCount: { type: 'number', required: true },
            columns: { type: 'array', required: true, items: COLUMN_PROFILE_SCHEMA },
            issues: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  column: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  detail: { type: 'string', required: true },
                  severity: { type: 'string', required: true },
                },
              },
            },
            suggestedCharts: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true },
                  x: { type: 'string', required: true },
                  y: { type: 'string' },
                  aggregate: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: 'text', text: summarizeProfile(value) }],
      },
      async execute(args, exec) {
        const active = await getEngine(exec)
        const profile = await profileDataset(active, args.source, { signal: exec.signal })
        return {
          source: profile.source,
          rowCount: profile.rowCount,
          columnCount: profile.columnCount,
          columns: profile.columns.map((column) => ({
            name: column.name,
            sqlType: column.sqlType,
            kind: column.kind,
            nullPercent: column.nullPercent,
            distinct: column.distinct,
            distinctExact: column.distinctExact,
            mean: column.mean,
            stddev: column.stddev,
            outlierCount: column.outlierCount,
          })),
          issues: profile.issues.map((issue) => ({
            kind: issue.kind,
            column: issue.column,
            detail: issue.detail,
            severity: issue.severity,
          })),
          suggestedCharts: suggestCharts(profile).map((suggestion) => ({
            kind: suggestion.kind,
            x: suggestion.x,
            ...(suggestion.y === undefined ? {} : { y: suggestion.y }),
            ...(suggestion.aggregate === undefined ? {} : { aggregate: suggestion.aggregate }),
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'data_query',
      description:
        'Run one read-only SQL statement (DuckDB dialect) against the attached datasets and return ' +
        'the rows. Reference a dataset by its alias. Only SELECT/WITH/FROM/DESCRIBE/SUMMARIZE/' +
        'EXPLAIN/PIVOT/VALUES/SHOW are permitted; anything that writes is rejected.',
      parameters: {
        sql: { type: 'string', required: true, description: 'The read-only SQL statement.' },
        maxRows: {
          type: 'integer',
          description: 'Row cap for the result. Defaults to 500.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            columns: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  sqlType: { type: 'string', required: true },
                },
              },
            },
            rows: { type: 'array', required: true, items: { type: 'json' } },
            rowCount: { type: 'number', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => {
          const header = value.columns.map((column) => column.name).join(' | ')
          const preview = value.rows
            .slice(0, 20)
            .map((row) => {
              // A `type: 'json'` item is any lossless JSON value, so narrow
              // to a record before indexing it by column name.
              if (typeof row !== 'object' || row === null || Array.isArray(row)) return String(row)
              const cells: { readonly [key: string]: unknown } = row
              return value.columns.map((column) => String(cells[column.name] ?? '')).join(' | ')
            })
            .join('\n')
          const tail = value.truncated
            ? `\n(truncated at ${value.rowCount} rows — raise maxRows or aggregate further)`
            : ''
          return [{ type: 'text', text: `${header}\n${preview}${tail}` }]
        },
      },
      async execute(args, exec) {
        const active = await getEngine(exec)
        const result = await active.query(
          args.sql,
          args.maxRows === undefined
            ? { signal: exec.signal }
            : { maxRows: args.maxRows, signal: exec.signal },
        )
        return {
          columns: result.columns.map((column) => ({
            name: column.name,
            sqlType: column.sqlType,
          })),
          // Each row is a JSON object, which is one inhabitant of JsonValue;
          // the readonly index signature is what blocks the direct assignment.
          // The core models a row as a readonly record; the tool schema models
          // it as an unconstrained JSON value. Same data, one cast at the edge.
          rows: result.rows.map((row) => ({ ...row })) as SessionJsonValue[],
          rowCount: result.rowCount,
          truncated: result.truncated,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'data_chart',
      description:
        'Draw a chart from an attached dataset and display it in the conversation. Pick the kind ' +
        'that fits the question: line for a trend over time, bar to compare categories (stack: ' +
        'grouped for side-by-side series), scatter for a relationship between two numbers, ' +
        'histogram for one distribution, area for a cumulative trend, heatmap for two categories ' +
        'x a measure (needs value), boxplot to compare distributions per category. Line and ' +
        'scatter pan/zoom in place; facet splits any of bar/line/scatter/area into small ' +
        'multiples. data_profile suggests good starting points.',
      parameters: {
        source: { type: 'string', required: true, description: 'Alias returned by data_attach.' },
        kind: {
          type: 'string',
          required: true,
          enum: [...CHART_KINDS],
          description: 'bar | line | scatter | histogram | area',
        },
        x: { type: 'string', required: true, description: 'Column for the x axis.' },
        y: {
          type: 'string',
          description:
            'Column for the y axis. Required for every kind except histogram. For heatmap this is ' +
            'the second category axis; for boxplot the numeric column.',
        },
        value: {
          type: 'string',
          description:
            'The measure column. heatmap: what each cell aggregates. sankey: the flow weight. ' +
            'sunburst/treemap: the leaf size. gauge: the value shown. Required for all five.',
        },
        aggregate: {
          type: 'string',
          enum: [...AGGREGATES],
          description:
            'How to combine y (or value) within each group. Defaults to sum for bar/line/area/heatmap and none for scatter/boxplot.',
        },
        color: { type: 'string', description: 'Optional column to split series by colour.' },
        stack: {
          type: 'string',
          enum: ['stacked', 'grouped'],
          description: 'Bar layout when color is present. Defaults to stacked.',
        },
        facet: {
          type: 'string',
          description:
            'Split into small multiples by this low-cardinality column (bar/line/scatter/area only).',
        },
        title: { type: 'string', description: 'Chart title. Derived from the columns when omitted.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true },
            title: { type: 'string', required: true },
            rowCount: { type: 'number', required: true },
            displayed: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: value.displayed
              ? summarizeChart(value)
              : `Built a ${value.kind} chart "${value.title}" from ${value.rowCount} point(s), but there is no conversation to display it in.`,
          },
        ],
      },
      async execute(args, exec) {
        const active = await getEngine(exec)
        const chart = await buildChart(active, {
          source: args.source,
          kind: args.kind as ChartKind,
          x: args.x,
          ...(args.y === undefined ? {} : { y: args.y }),
          ...(args.value === undefined ? {} : { value: args.value }),
          ...(args.aggregate === undefined ? {} : { aggregate: args.aggregate as 'sum' }),
          ...(args.color === undefined ? {} : { color: args.color }),
          ...(args.stack === undefined ? {} : { stack: args.stack as 'stacked' | 'grouped' }),
          ...(args.facet === undefined ? {} : { facet: args.facet }),
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })

        // The chart reaches the UI as a durable event, not as tool-result
        // content: the harness card kinds are a closed set with no chart
        // member, so a real chart can only come from a conversation node.
        // A non-agent caller (Code Mode nested dispatch, CLI) still receives
        // the canonical value; it simply has no conversation to draw into.
        const displayed = exec.agent !== undefined
        if (exec.agent !== undefined) {
          // ECharts kinds are rasterized here rather than in the browser, so
          // the client bundle carries one chart runtime instead of two — see
          // ChartEventData.svg for the trade.
          const svg =
            chart.engine === 'echarts' ? await renderChart(chart, 720) : undefined
          exec.agent.session.append('tukey/chart', {
            title: chart.title,
            kind: chart.kind,
            source: args.source,
            rowCount: chart.rowCount,
            engine: chart.engine,
            spec: chart.spec,
            ...(svg === undefined ? {} : { svg }),
          })
        }

        return {
          kind: chart.kind,
          title: chart.title,
          rowCount: chart.rowCount,
          displayed,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'data_sources',
      description: 'List the datasets currently attached in this session, with their columns.',
      parameters: {},
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              alias: { type: 'string', required: true },
              origin: { type: 'string', required: true },
              rowCount: { type: 'number', required: true },
              columnCount: { type: 'number', required: true },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              value.length === 0
                ? 'No datasets are attached yet. Use data_attach to add one.'
                : value
                    .map((item) => `${item.alias} — ${item.rowCount} rows, ${item.columnCount} columns (${item.origin})`)
                    .join('\n'),
          },
        ],
      },
      async execute(_args, exec) {
        const active = await getEngine(exec)
        return active.sources().map((handle) => ({
          alias: handle.alias,
          origin: handle.origin,
          rowCount: handle.rowCount,
          columnCount: handle.columns.length,
        }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'data_attach_db',
      description:
        'Attach a PostgreSQL, MySQL, or SQLite database READ-ONLY and list its tables. Pass a ' +
        'postgres:// or mysql:// connection string, or a path to a .db/.sqlite file. Query tables ' +
        'afterwards as alias.table (Postgres: alias.schema.table) with data_query. The first use ' +
        'of each connector downloads a DuckDB extension.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description:
            'Connection string (postgres://user:pass@host:port/db, mysql://...) or SQLite file path.',
        },
        alias: {
          type: 'string',
          description: 'Name to reference the database by. Defaults to the connector kind.',
        },
        kind: {
          type: 'string',
          enum: ['postgres', 'mysql', 'sqlite'],
          description: 'Force the connector; inferred from the target when omitted.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            alias: { type: 'string', required: true },
            kind: { type: 'string', required: true },
            origin: { type: 'string', required: true },
            tables: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  schema: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
                  name: { type: 'string', required: true },
                  estimatedRows: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Attached ${value.kind} database as "${value.alias}" (read-only). Tables:\n` +
              value.tables
                .map(
                  (table) =>
                    `- ${table.schema === null ? '' : `${table.schema}.`}${table.name} (~${table.estimatedRows} rows)`,
                )
                .join('\n'),
          },
        ],
      },
      async execute(args, exec) {
        const active = await getEngine(exec)
        const handle = await attachDatabase(active, args.target, {
          ...(args.alias === undefined ? {} : { alias: args.alias }),
          ...(args.kind === undefined ? {} : { kind: args.kind as DatabaseKind }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        return {
          alias: handle.alias,
          kind: handle.kind,
          origin: handle.redactedOrigin,
          tables: handle.tables.map((table) => ({
            schema: table.schema,
            name: table.name,
            estimatedRows: table.estimatedRows,
          })),
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'data_report',
      description:
        'Build a self-contained HTML analysis report (profile tables, data-quality findings, and ' +
        'charts embedded as SVG) and write it to a file. Covers every attached file dataset by ' +
        'default. The file opens offline and prints to PDF from any browser.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path for the .html file to write.',
        },
        title: {
          type: 'string',
          description: 'Report title. Derived from the sources when omitted.',
        },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Dataset aliases to include. Every attached file source when omitted.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true },
            title: { type: 'string', required: true },
            sources: { type: 'array', required: true, items: { type: 'string' } },
            chartCount: { type: 'number', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: `Wrote "${value.title}" (${value.chartCount} chart(s), sources: ${value.sources.join(', ')}) to ${value.path}`,
          },
        ],
      },
      async execute(args, exec) {
        const active = await getEngine(exec)
        const report = await buildHtmlReport(active, {
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.sources === undefined ? {} : { sources: args.sources }),
          ...(exec.signal === undefined ? {} : { signal: exec.signal }),
        })
        const target = resolvePath(args.path)
        await mkdir(resolvePath(target, '..'), { recursive: true })
        await writeFile(target, report.html, 'utf-8')
        // Durable breadcrumb: the workbench panel folds these events into the
        // session's report archive, so listing needs no host round trip.
        exec.agent?.session.append('tukey/report', {
          path: target,
          title: report.title,
          sources: [...report.sources],
          chartCount: report.chartCount,
        })
        return {
          path: target,
          title: report.title,
          sources: [...report.sources],
          chartCount: report.chartCount,
        }
      },
    }),
  )
}
