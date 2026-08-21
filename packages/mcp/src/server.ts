/**
 * Tukey MCP server: the same five data tools the DeepSeek Harness plugin
 * exposes, for every MCP client — Claude Code, Codex, Cursor, and anything
 * else that speaks the protocol.
 *
 * The analysis logic lives entirely in `@tukey/core`; this file only
 * translates between MCP shapes and the core's lossless-JSON domain types.
 * Tool names match the dsh plugin exactly, so prompts and docs transfer
 * between hosts unchanged.
 *
 * Chart delivery differs from the dsh plugin by necessity: there is no
 * conversation node to draw into, so `data_chart` renders the spec to an SVG
 * file server-side and returns the path plus the full spec in
 * `structuredContent` for clients that render Vega themselves.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  AnalystEngine,
  attachDatabase,
  buildChart,
  profileDataset,
  suggestCharts,
  AnalystError,
  ChartError,
  SqlPolicyError,
  type ChartKind,
  type DatabaseKind,
  type JsonValue,
} from '@tukey/core'
import { buildHtmlReport } from '@tukey/report'
import { renderChartSvg } from './render.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'

const CHART_KINDS = ['bar', 'line', 'scatter', 'histogram', 'area', 'heatmap', 'boxplot'] as const
const AGGREGATES = ['sum', 'avg', 'count', 'min', 'max', 'none'] as const

/** Where rendered SVGs land unless the client overrides per call. */
const DEFAULT_CHART_DIR = join(homedir(), '.tukey', 'charts')

export interface ServerOptions {
  /** Override the chart output directory (tests use a temp dir). */
  readonly chartDir?: string
}

/**
 * Build the configured server. Exported separately from the stdio bootstrap so
 * tests can drive it through an in-memory transport.
 */
export function createServer(options: ServerOptions = {}): McpServer {
  const chartDir = options.chartDir ?? DEFAULT_CHART_DIR

  const server = new McpServer({
    name: 'tukey-mcp-server',
    version: '0.1.0',
  })

  // One engine per server process. MCP clients spawn one stdio process each,
  // so this is naturally session-scoped — cleaner isolation than the dsh
  // plugin's process-wide singleton.
  let engine: AnalystEngine | undefined
  const getEngine = async (): Promise<AnalystEngine> => {
    engine ??= await AnalystEngine.create()
    return engine
  }

  /** Map a thrown error to an MCP tool failure with an actionable message. */
  const fail = (error: unknown): { content: [{ type: 'text'; text: string }]; isError: true } => {
    const message =
      error instanceof SqlPolicyError || error instanceof AnalystError || error instanceof ChartError
        ? error.message
        : error instanceof Error
          ? `Unexpected error: ${error.message}`
          : String(error)
    return { content: [{ type: 'text', text: message }], isError: true }
  }

  const ok = (
    text: string,
    structured: Record<string, JsonValue>,
  ): {
    content: [{ type: 'text'; text: string }]
    structuredContent: Record<string, JsonValue>
  } => ({ content: [{ type: 'text', text }], structuredContent: structured })

  server.registerTool(
    'data_attach',
    {
      title: 'Attach a dataset',
      description:
        'Register a data file so it can be profiled, queried, and charted. Supports CSV, TSV, ' +
        'Parquet, JSON/NDJSON, and XLSX. Returns the alias the dataset is queryable under. ' +
        'Call this before data_profile, data_query, or data_chart.',
      inputSchema: {
        path: z.string().min(1).describe('Absolute path to the data file.'),
        alias: z
          .string()
          .optional()
          .describe('Name to query the dataset by. Derived from the filename when omitted.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, alias }) => {
      try {
        const active = await getEngine()
        const handle = await active.attach(path, alias === undefined ? {} : { alias })
        const columns = handle.columns.map((column) => ({
          name: column.name,
          sqlType: column.sqlType,
        }))
        return ok(
          `Attached "${handle.alias}" (${handle.rowCount} rows): ` +
            columns.map((column) => `${column.name} ${column.sqlType}`).join(', '),
          { alias: handle.alias, origin: handle.origin, rowCount: handle.rowCount, columns },
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'data_profile',
    {
      title: 'Profile a dataset',
      description:
        'Profile an attached dataset in one pass: per-column type, missing values, exact distinct ' +
        'counts, quartiles, mean, standard deviation, and IQR outliers, plus data-quality issues ' +
        'worth fixing before analysis. Also returns chart suggestions for data_chart.',
      inputSchema: {
        source: z.string().min(1).describe('Alias returned by data_attach.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ source }) => {
      try {
        const active = await getEngine()
        const profile = await profileDataset(active, source)
        const issueLines =
          profile.issues.length === 0
            ? 'No data-quality issues found.'
            : profile.issues
                .map((issue) => `- [${issue.severity}] ${issue.column ?? 'table'}: ${issue.detail}`)
                .join('\n')

        return ok(
          `${profile.source}: ${profile.rowCount} rows x ${profile.columnCount} columns.\n${issueLines}`,
          {
            source: profile.source,
            rowCount: profile.rowCount,
            columnCount: profile.columnCount,
            columns: profile.columns.map((column) => ({ ...column })),
            issues: profile.issues.map((issue) => ({ ...issue })),
            suggestedCharts: suggestCharts(profile).map((suggestion) => ({
              kind: suggestion.kind,
              x: suggestion.x,
              ...(suggestion.y === undefined ? {} : { y: suggestion.y }),
              ...(suggestion.aggregate === undefined ? {} : { aggregate: suggestion.aggregate }),
            })),
          },
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'data_query',
    {
      title: 'Query with SQL',
      description:
        'Run one read-only SQL statement (DuckDB dialect) against the attached datasets and return ' +
        'the rows. Reference datasets by their alias. Only SELECT/WITH/FROM/DESCRIBE/SUMMARIZE/' +
        'EXPLAIN/PIVOT/VALUES/SHOW are permitted; anything that writes is rejected.',
      inputSchema: {
        sql: z.string().min(1).describe('The read-only SQL statement.'),
        maxRows: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .optional()
          .describe('Row cap for the result. Defaults to 500.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sql, maxRows }) => {
      try {
        const active = await getEngine()
        const result = await active.query(sql, maxRows === undefined ? {} : { maxRows })
        const header = result.columns.map((column) => column.name).join(' | ')
        const preview = result.rows
          .slice(0, 20)
          .map((row) => result.columns.map((column) => String(row[column.name] ?? '')).join(' | '))
          .join('\n')
        const tail = result.truncated
          ? `\n(truncated at ${result.rowCount} rows — raise maxRows or aggregate further)`
          : ''
        return ok(`${header}\n${preview}${tail}`, {
          columns: result.columns.map((column) => ({ ...column })),
          rows: result.rows.map((row) => ({ ...row })),
          rowCount: result.rowCount,
          truncated: result.truncated,
        })
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'data_chart',
    {
      title: 'Draw a chart',
      description:
        'Draw a chart from an attached dataset. Renders an SVG file and returns its path plus the ' +
        'full Vega-Lite spec. Pick the kind that fits the question: line for a trend over time, ' +
        'bar to compare categories, scatter for a relationship, histogram for one distribution, ' +
        'area for a cumulative trend. data_profile suggests good starting points.',
      inputSchema: {
        source: z.string().min(1).describe('Alias returned by data_attach.'),
        kind: z.enum(CHART_KINDS).describe('bar | line | scatter | histogram | area'),
        x: z.string().min(1).describe('Column for the x axis.'),
        y: z
          .string()
          .optional()
          .describe(
            'Column for the y axis. Required for every kind except histogram. For heatmap the ' +
              'second category axis; for boxplot the numeric column.',
          ),
        value: z.string().optional().describe('Heatmap only: numeric column aggregated into each cell.'),
        aggregate: z
          .enum(AGGREGATES)
          .optional()
          .describe(
            'How to combine y (or value) within each group. Defaults to sum for bar/line/area/heatmap, none for scatter/boxplot.',
          ),
        color: z.string().optional().describe('Optional column to split series by colour.'),
        stack: z
          .enum(['stacked', 'grouped'])
          .optional()
          .describe('Bar layout when color is present. Defaults to stacked.'),
        facet: z
          .string()
          .optional()
          .describe('Split into small multiples by this low-cardinality column (bar/line/scatter/area only).'),
        title: z.string().optional().describe('Chart title. Derived from the columns when omitted.'),
      },
      // Writes one new SVG file; never modifies existing data.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ source, kind, x, y, value, aggregate, color, stack, facet, title }) => {
      try {
        const active = await getEngine()
        const chart = await buildChart(active, {
          source,
          kind: kind as ChartKind,
          x,
          ...(y === undefined ? {} : { y }),
          ...(value === undefined ? {} : { value }),
          ...(aggregate === undefined ? {} : { aggregate }),
          ...(color === undefined ? {} : { color }),
          ...(stack === undefined ? {} : { stack }),
          ...(facet === undefined ? {} : { facet }),
          ...(title === undefined ? {} : { title }),
        })
        const rendered = await renderChartSvg(chart.vegaLite, chartDir, chart.title)
        return ok(
          `Rendered a ${chart.kind} chart "${chart.title}" (${chart.rowCount} data points) to ${rendered.svgPath}`,
          {
            kind: chart.kind,
            title: chart.title,
            rowCount: chart.rowCount,
            svgPath: rendered.svgPath,
            vegaLite: chart.vegaLite,
          },
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'data_attach_db',
    {
      title: 'Attach a database',
      description:
        'Attach a PostgreSQL, MySQL, or SQLite database READ-ONLY and list its tables. ' +
        'Pass a postgres:// or mysql:// connection string, or a path to a .db/.sqlite file. ' +
        'Query tables afterwards as alias.table (Postgres: alias.schema.table) with data_query. ' +
        'The first use of each connector downloads a DuckDB extension.',
      inputSchema: {
        target: z
          .string()
          .min(1)
          .describe('Connection string (postgres://user:pass@host:port/db, mysql://...) or SQLite file path.'),
        alias: z.string().optional().describe('Name to reference the database by. Defaults to the connector kind.'),
        kind: z
          .enum(['postgres', 'mysql', 'sqlite'])
          .optional()
          .describe('Force the connector; inferred from the target when omitted.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ target, alias, kind }) => {
      try {
        const active = await getEngine()
        const handle = await attachDatabase(active, target, {
          ...(alias === undefined ? {} : { alias }),
          ...(kind === undefined ? {} : { kind: kind as DatabaseKind }),
        })
        const tables = handle.tables.map((table) => ({
          schema: table.schema,
          name: table.name,
          estimatedRows: table.estimatedRows,
        }))
        return ok(
          `Attached ${handle.kind} database as "${handle.alias}" (read-only). Tables:\n` +
            tables
              .map((table) => `- ${table.schema === null ? '' : `${table.schema}.`}${table.name} (~${table.estimatedRows} rows)`)
              .join('\n'),
          { alias: handle.alias, kind: handle.kind, origin: handle.redactedOrigin, tables },
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'data_report',
    {
      title: 'Export an HTML report',
      description:
        'Build a self-contained HTML analysis report (profile tables, data-quality findings, and ' +
        'charts embedded as SVG) and write it to a file. Covers every attached file dataset by ' +
        'default. The file opens offline and prints to PDF from any browser.',
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe('Absolute path for the .html file to write.'),
        title: z.string().optional().describe('Report title. Derived from the sources when omitted.'),
        sources: z
          .array(z.string())
          .optional()
          .describe('Dataset aliases to include. Every attached file source when omitted.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ path, title, sources }) => {
      try {
        const active = await getEngine()
        const report = await buildHtmlReport(active, {
          ...(title === undefined ? {} : { title }),
          ...(sources === undefined ? {} : { sources }),
        })
        const target = resolvePath(path)
        await mkdir(resolvePath(target, '..'), { recursive: true })
        await writeFile(target, report.html, 'utf-8')
        return ok(
          `Wrote "${report.title}" (${report.chartCount} chart(s), sources: ${report.sources.join(', ')}) to ${target}`,
          { path: target, title: report.title, sources: [...report.sources], chartCount: report.chartCount },
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  server.registerTool(
    'data_sources',
    {
      title: 'List attached datasets',
      description: 'List the datasets currently attached in this session, with their columns.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const active = await getEngine()
        const sources = active.sources().map((handle) => ({
          alias: handle.alias,
          origin: handle.origin,
          rowCount: handle.rowCount,
          columns: handle.columns.map((column) => ({ ...column })),
        }))
        return ok(
          sources.length === 0
            ? 'No datasets are attached yet. Use data_attach to add one.'
            : sources
                .map((item) => `${item.alias} — ${item.rowCount} rows, ${item.columns.length} columns (${item.origin})`)
                .join('\n'),
          { sources },
        )
      } catch (error) {
        return fail(error)
      }
    },
  )

  return server
}
