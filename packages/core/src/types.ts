/**
 * Domain types for Tukey core.
 *
 * Every value that crosses the package boundary is lossless JSON: no BigInt,
 * no DuckDB wrapper objects, no class instances. Adapters (dsh plugin, MCP
 * server, CLI) hand these straight to their host without another conversion,
 * and a dsh tool can declare them as its canonical `output.schema`.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** Coarse semantic bucket, derived from the SQL type. Drives chart selection. */
export type ColumnKind = 'numeric' | 'temporal' | 'categorical' | 'boolean' | 'other'

export interface ColumnProfile {
  readonly name: string
  /** DuckDB type as reported, e.g. `BIGINT`, `VARCHAR`, `DATE`. */
  readonly sqlType: string
  readonly kind: ColumnKind
  /** 0-100, rounded to two decimals. */
  readonly nullPercent: number
  /**
   * Number of distinct values.
   *
   * Exact for datasets up to {@link EXACT_DISTINCT_MAX_ROWS} rows. Above that
   * it falls back to DuckDB's HyperLogLog estimate, and `distinctExact` says
   * which you got — the estimate is wrong by one or two on small cardinalities
   * (a 4-value column can report 3), which an analyst must not mistake for a
   * fact about the data.
   */
  readonly distinct: number
  /** True when `distinct` is an exact count rather than an estimate. */
  readonly distinctExact: boolean
  readonly min: JsonValue
  readonly max: JsonValue
  /** Numeric columns only; null elsewhere. */
  readonly mean: number | null
  readonly stddev: number | null
  readonly q25: JsonValue
  readonly q50: JsonValue
  readonly q75: JsonValue
  /** IQR-rule outliers. Numeric columns only; null elsewhere. */
  readonly outlierCount: number | null
}

export type IssueKind =
  | 'high-null'
  | 'constant'
  | 'high-cardinality'
  | 'outliers'
  | 'duplicate-rows'

export interface DataIssue {
  readonly kind: IssueKind
  /** Null for table-level issues such as duplicate rows. */
  readonly column: string | null
  readonly detail: string
  readonly severity: 'info' | 'warn'
}

export interface DatasetProfile {
  /** The alias the dataset is queryable under. */
  readonly source: string
  readonly rowCount: number
  readonly columnCount: number
  readonly columns: readonly ColumnProfile[]
  /** Findings worth surfacing before analysis starts. Ordered by severity. */
  readonly issues: readonly DataIssue[]
}

export interface QueryColumn {
  readonly name: string
  readonly sqlType: string
}

export interface QueryResult {
  readonly columns: readonly QueryColumn[]
  readonly rows: readonly { readonly [key: string]: JsonValue }[]
  /** Rows actually returned (after any truncation). */
  readonly rowCount: number
  /** True when `maxRows` clipped the result. */
  readonly truncated: boolean
}

export type ChartKind = 'bar' | 'line' | 'scatter' | 'histogram' | 'area' | 'heatmap' | 'boxplot'

export interface ChartSpec {
  readonly kind: ChartKind
  readonly title: string
  /**
   * A complete Vega-Lite v5 specification with the data inlined.
   *
   * This is deliberately one self-contained JSON value: a dsh conversation
   * node persists it as a whole-value checkpoint, so replaying the session log
   * rebuilds the identical chart as a pure function of the event — no clock,
   * no random, no live state. See docs/ARCHITECTURE.md.
   */
  readonly vegaLite: JsonValue
  readonly rowCount: number
}

/** A dataset registered with the engine and queryable by alias. */
export interface SourceHandle {
  readonly alias: string
  /** Absolute path, connection string, or `<inline>` for literal SQL. */
  readonly origin: string
  readonly rowCount: number
  readonly columns: readonly QueryColumn[]
}
