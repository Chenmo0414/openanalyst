/**
 * OpenAnalyst — the DeepSeek Harness host half.
 *
 * Registers five model-facing tools over `@openanalyst/core`. Every tool is
 * also reachable from Code Mode as `await tools.data_*(args)` at no extra cost,
 * so the model can chain attach -> profile -> query -> chart inside one program
 * instead of spending a round trip per step. That is why each `output.schema`
 * is written as a programmatic API — handles and fields, with the prose kept in
 * `output.render`.
 *
 * @module openanalyst
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue as SessionJsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  AnalystEngine,
  buildChart,
  profileDataset,
  suggestCharts,
  type ChartKind,
} from '@openanalyst/core'
// Side-effect import: contributes the `openanalyst/chart` SessionEventMap entry.
import type {} from './events.ts'

export type * from './events.ts'

export const name = 'openanalyst'
export const inject = ['tools']

const CHART_KINDS = ['bar', 'line', 'scatter', 'histogram', 'area'] as const
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

export function apply(ctx: Context): void {
  // One engine per plugin activation. M1 limitation: datasets are shared by
  // every agent in this process, so two sessions attaching the same alias see
  // the last one to win. Per-agent isolation is scheduled for M2 — see README.
  let engine: AnalystEngine | undefined

  const getEngine = async (): Promise<AnalystEngine> => {
    engine ??= await AnalystEngine.create()
    return engine
  }

  // cordis 4 has no 'dispose' event; a teardown effect is the supported way
  // to release a resource with the plugin fiber.
  ctx.effect(() => () => {
    void engine?.close()
    engine = undefined
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
        const active = await getEngine()
        const handle = await active.attach(
          args.path,
          args.alias === undefined ? { signal: exec.signal } : { alias: args.alias, signal: exec.signal },
        )
        return {
          alias: handle.alias,
          origin: handle.origin,
          rowCount: handle.rowCount,
          columns: handle.columns.map((column) => ({ name: column.name, sqlType: column.sqlType })),
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
        const active = await getEngine()
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
        const active = await getEngine()
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
        'that fits the question: line for a trend over time, bar to compare categories, scatter for ' +
        'a relationship between two numbers, histogram for one distribution, area for a cumulative ' +
        'trend. data_profile suggests good starting points.',
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
          description: 'Column for the y axis. Required for every kind except histogram.',
        },
        aggregate: {
          type: 'string',
          enum: [...AGGREGATES],
          description:
            'How to combine y within each x. Defaults to sum for bar/line/area and none for scatter.',
        },
        color: { type: 'string', description: 'Optional column to split series by colour.' },
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
        const active = await getEngine()
        const chart = await buildChart(active, {
          source: args.source,
          kind: args.kind as ChartKind,
          x: args.x,
          ...(args.y === undefined ? {} : { y: args.y }),
          ...(args.aggregate === undefined ? {} : { aggregate: args.aggregate as 'sum' }),
          ...(args.color === undefined ? {} : { color: args.color }),
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
          exec.agent.session.append('openanalyst/chart', {
            title: chart.title,
            kind: chart.kind,
            source: args.source,
            rowCount: chart.rowCount,
            vegaLite: chart.vegaLite,
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
      async execute() {
        const active = await getEngine()
        return active.sources().map((handle) => ({
          alias: handle.alias,
          origin: handle.origin,
          rowCount: handle.rowCount,
          columnCount: handle.columns.length,
        }))
      },
    }),
  )
}
