/**
 * @openanalyst/core — dataset profiling, read-only SQL, and Vega-Lite charts
 * over DuckDB.
 *
 * Host-agnostic by construction: nothing here imports a DeepSeek Harness, MCP,
 * or CLI type. Adapters wrap these functions; the analysis logic has exactly
 * one implementation.
 */

export { AnalystEngine, AnalystError, DEFAULT_MAX_ROWS } from './engine.js'
export type { AttachOptions, EngineOptions, QueryOptions } from './engine.js'

export { profileDataset, classifyType } from './profile.js'
export type { ProfileOptions } from './profile.js'

export { buildChart, suggestCharts, ChartError, MAX_POINTS } from './chart.js'
export type { Aggregate, ChartRequest } from './chart.js'

export { assertReadOnlyStatement, SqlPolicyError, toAlias } from './sql.js'
export { toJsonValue, toJsonRow, asNumber } from './json.js'

export type {
  ChartKind,
  ChartSpec,
  ColumnKind,
  ColumnProfile,
  DataIssue,
  DatasetProfile,
  IssueKind,
  JsonValue,
  QueryColumn,
  QueryResult,
  SourceHandle,
} from './types.js'
