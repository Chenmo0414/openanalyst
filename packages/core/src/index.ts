/**
 * @tukey/core — dataset profiling, read-only SQL, and Vega-Lite charts
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

export { buildChart, suggestCharts, ChartError, MAX_POINTS, engineFor } from './chart.js'
export {
  sankeyOption,
  sunburstOption,
  treemapOption,
  gaugeOption,
} from './echarts.js'
export type { FlowLink, HierarchyNode } from './echarts.js'
export { CHART_CONFIG, CATEGORICAL, SERIES_1 } from './theme.js'
export type { Aggregate, ChartRequest } from './chart.js'

export { attachDatabase, inferDatabaseKind, redactSecrets } from './database.js'
export type { AttachDatabaseOptions, DatabaseHandle, DatabaseKind, DatabaseTable } from './database.js'

export { assertReadOnlyStatement, SqlPolicyError, toAlias } from './sql.js'
export { toJsonValue, toJsonRow, asNumber } from './json.js'

export type {
  ChartEngine,
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
