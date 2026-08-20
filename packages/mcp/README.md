# openanalyst-mcp-server

MCP server that turns Claude Code, Codex, Cursor — any MCP client — into a
data analyst: attach CSV/Parquet/JSON/XLSX, auto-profile, run read-only SQL
(DuckDB dialect), and render Vega-Lite charts to SVG. Pure-JS chart rendering:
no headless browser, no native canvas.

## Install

```bash
claude mcp add openanalyst -- npx -y openanalyst-mcp-server
```

Tools: `data_attach` · `data_profile` · `data_query` · `data_chart` ·
`data_sources`. Charts land in `~/.openanalyst/charts/` and every result also
carries the full Vega-Lite spec in `structuredContent`.

Full docs: https://github.com/Chenmo0414/openanalyst
