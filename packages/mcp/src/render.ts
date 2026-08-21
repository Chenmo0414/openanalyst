/**
 * File-emitting wrapper over `@tukey/report`'s pure SVG renderer: the
 * MCP transport has no inline-image surface worth relying on, so charts land
 * on disk and tools return the path.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chartToSvg, DEFAULT_SVG_WIDTH } from '@tukey/report'
import type { ChartEngine, JsonValue } from '@tukey/core'

export interface RenderedChart {
  readonly svgPath: string
  readonly svg: string
}

/**
 * Render one self-contained Vega-Lite spec to an SVG file.
 *
 * @param spec - the spec produced by `@tukey/core` buildChart, data inlined.
 * @param outDir - directory the SVG is written into (created when missing).
 * @param baseName - filename stem; sanitized, `.svg` appended.
 * @param engine - which renderer reads the spec.
 */
export async function renderChartSvg(
  spec: JsonValue,
  outDir: string,
  baseName: string,
  engine: ChartEngine = 'vega-lite',
): Promise<RenderedChart> {
  const svg = await chartToSvg(spec, DEFAULT_SVG_WIDTH, engine)

  const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80) || 'chart'
  const dir = resolve(outDir)
  await mkdir(dir, { recursive: true })

  // Timestamped so consecutive charts of the same title never overwrite each
  // other mid-conversation.
  const path = join(dir, `${safeName}-${Date.now().toString(36)}.svg`)
  await writeFile(path, svg, 'utf-8')

  return { svgPath: path, svg }
}
