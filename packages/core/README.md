# @tukey/core

Host-agnostic data-analysis engine over DuckDB: attach CSV/Parquet/JSON/XLSX,
one-pass profiling with exact distinct counts, read-only SQL (allowlist
policy), and self-contained Vega-Lite chart specs as lossless JSON.

This is the engine behind the [Tukey](https://github.com/Chenmo0414/tukey)
DeepSeek Harness plugin and MCP server. Use it directly to build your own
adapter:

```ts
import { AnalystEngine, profileDataset, buildChart } from '@tukey/core'

const engine = await AnalystEngine.create()
const { alias } = await engine.attach('sales.csv')
const profile = await profileDataset(engine, alias)
const result = await engine.query(`SELECT region, sum(revenue) FROM ${alias} GROUP BY 1`)
const chart = await buildChart(engine, { source: alias, kind: 'bar', x: 'region', y: 'revenue' })
```

Full docs: https://github.com/Chenmo0414/tukey
