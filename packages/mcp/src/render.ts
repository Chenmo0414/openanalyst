/**
 * File-emitting wrapper over `@openanalyst/report`'s pure SVG renderer: the
 * MCP transport has no inline-image surface worth relying on, so charts land
 * on disk and tools return the path.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { chartToSvg } from '@openanalyst/report'
import type { JsonValue } from '@openanalyst/core'

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
  const svg = await chartToSvg(spec)

  const safeName = baseName.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80) || 'chart'
  const dir = resolve(outDir)
  await mkdir(dir, { recursive: true })

  // Timestamped so consecutive charts of the same title never overwrite each
  // other mid-conversation.
  const path = join(dir, `${safeName}-${Date.now().toString(36)}.svg`)
  await writeFile(path, svg, 'utf-8')

  return { svgPath: path, svg }
}
