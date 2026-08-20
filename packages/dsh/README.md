# openanalyst — DeepSeek Harness plugin

Turn DeepSeek Harness into a data analyst: attach CSV/Parquet/JSON/XLSX, get an
automatic profile, run read-only SQL, and see Vega-Lite charts rendered live
inside the conversation (as conversation nodes, not text).

## Install

```bash
dsh plugin --profile web add openanalyst
```

Tools: `data_attach` · `data_profile` · `data_query` · `data_chart` ·
`data_sources`. All of them are also callable from Code Mode programs as
`await tools.data_*(args)`.

Screenshots, architecture, and the live-verification record:
https://github.com/Chenmo0414/openanalyst
