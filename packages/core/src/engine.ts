/**
 * The DuckDB-backed analysis engine.
 *
 * Deliberately knows nothing about DeepSeek Harness, MCP, or any agent host:
 * it takes paths and SQL, and returns lossless JSON. Every adapter shares this
 * one implementation, which is what lets the same capability ship to dsh,
 * Claude Code, Codex and Cursor without a second engine.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api'
import { toJsonRow } from './json.js'
import { assertReadOnlyStatement, quoteIdentifier, quoteLiteral, toAlias } from './sql.js'
import type { JsonValue, QueryColumn, QueryResult, SourceHandle } from './types.js'

/** Default cap on rows returned to a caller, so a wide scan cannot flood a model context. */
export const DEFAULT_MAX_ROWS = 500

export interface EngineOptions {
  /** DuckDB memory limit, e.g. `'2GB'`. Left to DuckDB's default when omitted. */
  readonly memoryLimit?: string
  /** Database file. Defaults to an in-memory database. */
  readonly database?: string
}

export interface QueryOptions {
  readonly maxRows?: number
  readonly signal?: AbortSignal
}

export interface AttachOptions {
  /** Explicit alias. Derived from the filename when omitted. */
  readonly alias?: string
  readonly signal?: AbortSignal
}

export class AnalystError extends Error {
  override readonly name = 'AnalystError'
}

type SourceFormat = 'csv' | 'parquet' | 'json' | 'xlsx'

function detectFormat(path: string): SourceFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith('.parquet') || lower.endsWith('.pq')) return 'parquet'
  if (lower.endsWith('.json') || lower.endsWith('.ndjson') || lower.endsWith('.jsonl')) return 'json'
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 'xlsx'
  return 'csv'
}

/**
 * Build the DuckDB table function that reads one file.
 *
 * CSV uses `sample_size=-1` so type inference reads the whole file: a column
 * that is integer for its first 20k rows and then holds `N/A` must be typed
 * VARCHAR, not silently error at scan time.
 */
function readerExpression(path: string, format: SourceFormat): string {
  const literal = quoteLiteral(path.replace(/\\/g, '/'))
  switch (format) {
    case 'parquet':
      return `read_parquet(${literal})`
    case 'json':
      return `read_json_auto(${literal})`
    case 'xlsx':
      return `read_xlsx(${literal})`
    case 'csv':
      return `read_csv(${literal}, auto_detect = true, sample_size = -1)`
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AnalystError('The operation was cancelled.')
}

/** Render one JSON value as a SQL literal for a `VALUES` tuple. */
function sqlLiteral(value: JsonValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'string') return quoteLiteral(value)
  // Nested arrays and objects are kept as JSON text; DuckDB's json functions
  // can still reach into them, and the column stays one honest type.
  return quoteLiteral(JSON.stringify(value))
}

export class AnalystEngine {
  readonly #connection: DuckDBConnection
  readonly #sources = new Map<string, SourceHandle>()
  #closed = false

  private constructor(connection: DuckDBConnection) {
    this.#connection = connection
  }

  static async create(options: EngineOptions = {}): Promise<AnalystEngine> {
    const instance = await DuckDBInstance.create(options.database ?? ':memory:')
    const connection = await instance.connect()
    if (options.memoryLimit !== undefined) {
      await connection.run(`SET memory_limit = ${quoteLiteral(options.memoryLimit)}`)
    }
    return new AnalystEngine(connection)
  }

  #assertOpen(): void {
    if (this.#closed) throw new AnalystError('The engine is closed.')
  }

  /** Datasets currently registered, in attach order. */
  sources(): readonly SourceHandle[] {
    return [...this.#sources.values()]
  }

  source(alias: string): SourceHandle | undefined {
    return this.#sources.get(alias)
  }

  /**
   * Register a file as a queryable view.
   *
   * The view is created with `CREATE OR REPLACE`, so attaching the same alias
   * twice re-points it rather than failing — re-running a cell after editing
   * the underlying file is the common case, not an error.
   */
  async attach(path: string, options: AttachOptions = {}): Promise<SourceHandle> {
    this.#assertOpen()
    throwIfAborted(options.signal)

    const alias = options.alias === undefined ? toAlias(path) : toAlias(options.alias)
    const format = detectFormat(path)
    const reader = readerExpression(path, format)

    try {
      await this.#connection.run(
        `CREATE OR REPLACE VIEW ${quoteIdentifier(alias)} AS SELECT * FROM ${reader}`,
      )
    } catch (cause) {
      throw new AnalystError(
        `Could not read ${path} as ${format.toUpperCase()}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }

    const [countRow] = await this.#rows(
      `SELECT count(*) AS n FROM ${quoteIdentifier(alias)}`,
      options.signal,
    )
    const rowCount = typeof countRow?.['n'] === 'number' ? countRow['n'] : 0

    const handle: SourceHandle = {
      alias,
      origin: path,
      rowCount,
      columns: await this.#describe(alias, options.signal),
    }
    this.#sources.set(alias, handle)
    return handle
  }

  /**
   * Register an in-memory table from literal rows. Used by tests and by data
   * pasted straight into a conversation.
   *
   * Built as a `VALUES` list rather than through DuckDB's JSON readers,
   * because those take a path and would read a JSON document as a filename.
   */
  async attachRows(
    alias: string,
    rows: readonly { readonly [key: string]: JsonValue }[],
  ): Promise<SourceHandle> {
    this.#assertOpen()
    if (rows.length === 0) throw new AnalystError('Cannot attach an empty row set.')

    const safeAlias = toAlias(alias)

    // Column order follows first appearance across all rows, so a ragged row
    // set still produces one rectangular table.
    const names: string[] = []
    for (const row of rows) {
      for (const key of Object.keys(row)) if (!names.includes(key)) names.push(key)
    }
    if (names.length === 0) throw new AnalystError('The rows have no columns.')

    const tuples = rows
      .map((row) => `(${names.map((name) => sqlLiteral(row[name] ?? null)).join(', ')})`)
      .join(', ')
    const columnList = names.map(quoteIdentifier).join(', ')

    await this.#connection.run(
      `CREATE OR REPLACE VIEW ${quoteIdentifier(safeAlias)} AS ` +
        `SELECT * FROM (VALUES ${tuples}) AS _t(${columnList})`,
    )

    const handle: SourceHandle = {
      alias: safeAlias,
      origin: '<inline>',
      rowCount: rows.length,
      columns: await this.#describe(safeAlias, undefined),
    }
    this.#sources.set(safeAlias, handle)
    return handle
  }

  async #describe(alias: string, signal: AbortSignal | undefined): Promise<QueryColumn[]> {
    const rows = await this.#rows(`DESCRIBE ${quoteIdentifier(alias)}`, signal)
    return rows.map((row) => ({
      name: String(row['column_name'] ?? ''),
      sqlType: String(row['column_type'] ?? ''),
    }))
  }

  /** Run trusted internal SQL. Not exposed — callers go through `query`. */
  async #rows(
    sql: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly [key: string]: JsonValue }[]> {
    throwIfAborted(signal)
    const reader = await this.#connection.runAndReadAll(sql)
    throwIfAborted(signal)
    return reader.getRowObjects().map(toJsonRow)
  }

  /**
   * Execute one agent-authored read-only statement.
   *
   * @throws SqlPolicyError when the statement is compound or mutating.
   */
  async query(sql: string, options: QueryOptions = {}): Promise<QueryResult> {
    this.#assertOpen()
    const statement = assertReadOnlyStatement(sql)
    const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS
    throwIfAborted(options.signal)

    // Fetch one extra row to distinguish "exactly at the cap" from "clipped".
    const wrapped = `SELECT * FROM (${statement}) LIMIT ${maxRows + 1}`

    let reader
    try {
      reader = await this.#connection.runAndReadAll(wrapped)
    } catch (cause) {
      throw new AnalystError(
        `Query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      )
    }
    throwIfAborted(options.signal)

    const all = reader.getRowObjects().map(toJsonRow)
    const truncated = all.length > maxRows
    const rows = truncated ? all.slice(0, maxRows) : all
    const names = reader.columnNames()
    const types = reader.columnTypes().map((type) => String(type))

    return {
      columns: names.map((name, index) => ({ name, sqlType: types[index] ?? 'UNKNOWN' })),
      rows,
      rowCount: rows.length,
      truncated,
    }
  }

  /** Internal read-only access for profile/chart, bypassing the row cap. */
  async queryInternal(
    sql: string,
    signal?: AbortSignal,
  ): Promise<{ readonly [key: string]: JsonValue }[]> {
    this.#assertOpen()
    return this.#rows(sql, signal)
  }

  /**
   * Run trusted internal DDL/utility statements (INSTALL, LOAD, ATTACH, SET).
   *
   * Never reachable from agent-authored SQL: `query` keeps its read-only
   * allowlist, and this method is only called by library code such as
   * `attachDatabase` with statements it composed itself.
   */
  async execInternal(sql: string): Promise<void> {
    this.#assertOpen()
    await this.#connection.run(sql)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#connection.closeSync()
  }
}
