/**
 * Vega-Lite spec -> SVG string, pure JS.
 *
 * No canvas binding, no headless browser, no native module: `vega`'s SVG
 * renderer runs anywhere Node runs, which keeps every consumer (`npx`-installed
 * MCP server included) a zero-toolchain install.
 */

import * as vega from 'vega'
import * as vegaLite from 'vega-lite'
import type { JsonValue } from '@openanalyst/core'

/** Default raster width: the core emits `width: 'container'`, which only
 * means something inside a browser layout. */
export const DEFAULT_SVG_WIDTH = 640

/**
 * Render one self-contained Vega-Lite spec to an SVG string.
 *
 * The spec is deep-copied before parsing: vega's `parse()` MUTATES the inlined
 * data rows (it stamps a `Symbol(vega_id)` on each), and callers hand this
 * same spec object onward in protocol payloads.
 */
export async function chartToSvg(spec: JsonValue, width = DEFAULT_SVG_WIDTH): Promise<string> {
  const cloned = structuredClone(spec as Record<string, JsonValue>)
  // A faceted spec sizes per panel and rejects autosize "fit"; leave its own
  // width/autosize untouched and only pin single-view specs to a raster width.
  const faceted =
    typeof cloned['encoding'] === 'object' &&
    cloned['encoding'] !== null &&
    'facet' in (cloned['encoding'] as Record<string, unknown>)
  const pinned = faceted
    ? cloned
    : { ...cloned, width, autosize: { type: 'fit', contains: 'padding' } }

  const compiled = vegaLite.compile(pinned as never).spec
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
  try {
    return await view.toSVG()
  } finally {
    view.finalize()
  }
}
