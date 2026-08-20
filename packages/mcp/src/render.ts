/**
 * Server-side chart rendering: Vega-Lite spec -> SVG file.
 *
 * Pure-JS on purpose. `vega`'s SVG renderer needs no canvas binding, no
 * headless browser, no native module — which is what keeps
 * `npx openanalyst-mcp` a zero-toolchain install on every platform. PNG would
 * need a native rasterizer (resvg/sharp); if it ever ships it must be optional.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as vega from 'vega'
import * as vegaLite from 'vega-lite'
import type { JsonValue } from '@openanalyst/core'

/** Fixed raster width: the core emits `width: 'container'`, which only means
 * something inside a browser layout. */
const RENDER_WIDTH = 640

export interface RenderedChart {
  readonly svgPath: string
  readonly svg: string
}

/**
 * Render one self-contained Vega-Lite spec to an SVG file.
 *
 * @param spec - the spec produced by `@openanalyst/core` buildChart, data inlined.
 * @param outDir - directory the SVG is written into (created when missing).
 * @param baseName - filename stem; sanitized, `.svg` appended.
 */
export async function renderChartSvg(
  spec: JsonValue,
  outDir: string,
  baseName: string,
): Promise<RenderedChart> {
  // Deep-copy first: vega's parse() MUTATES the inlined data rows (it stamps a
  // Symbol(vega_id) on each one). The caller returns this same spec object to
  // its client, so handing vega the original would leak renderer state into
  // the protocol payload.
  //
  // Container sizing has no meaning without a DOM: pin the width, keep the
  // spec's own height, and drop the browser-only autosize contract.
  const pinned = {
    ...structuredClone(spec as Record<string, JsonValue>),
    width: RENDER_WIDTH,
    autosize: { type: 'fit', contains: 'padding' },
  }

  const compiled = vegaLite.compile(pinned as never).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  const svg = await view.toSVG()
  view.finalize()

  const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80) || 'chart'
  const dir = resolve(outDir)
  await mkdir(dir, { recursive: true })

  // Timestamped so consecutive charts of the same title never overwrite each
  // other mid-conversation.
  const path = join(dir, `${safeName}-${Date.now().toString(36)}.svg`)
  await writeFile(path, svg, 'utf-8')

  return { svgPath: path, svg }
}
