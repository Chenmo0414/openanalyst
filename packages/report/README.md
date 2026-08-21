# @openanalyst/report

Chart rendering and self-contained HTML reports for
[OpenAnalyst](https://github.com/Chenmo0414/openanalyst).

Two things, both dependency-light and server-side:

- **`chartToSvg(spec)`** — a Vega-Lite spec to an SVG string in pure JS. No
  headless browser, no native canvas, so it runs anywhere Node runs. The spec
  is deep-cloned first, because vega's `parse()` mutates the inlined data rows.
- **`buildHtmlReport(engine, options)`** — one self-contained HTML file:
  profile tables, data-quality findings, and every chart embedded as inline
  SVG. Zero external requests, so it opens offline, attaches to an email, and
  prints to PDF from any browser.

```ts
import { AnalystEngine } from '@openanalyst/core'
import { buildHtmlReport, chartToSvg } from '@openanalyst/report'

const engine = await AnalystEngine.create()
await engine.attach('sales.csv')
const { html, chartCount } = await buildHtmlReport(engine, { title: 'Q3 review' })
```

Split from `@openanalyst/core` so hosts that render charts themselves (the
DeepSeek Harness browser half draws them with Vega in the page) never carry the
server-side vega dependency.

Full docs: https://github.com/Chenmo0414/openanalyst
