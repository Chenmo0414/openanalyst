/**
 * ECharts option builders for the chart kinds Vega-Lite has no grammar for.
 *
 * This module constructs plain JSON — it does not import echarts. Same split
 * as the Vega-Lite side: the core decides what the chart IS, a renderer
 * decides how it becomes pixels. That keeps `@tukey/core` free of any
 * rendering dependency and lets the option travel through a session event as a
 * whole-value checkpoint.
 *
 * The four kinds here are the honest gap in Vega-Lite: flow (sankey),
 * hierarchy (sunburst, treemap), and a single-value KPI (gauge). Everything
 * exploratory — distributions, trends, correlations, comparisons — stays on
 * Vega-Lite, where the grammar is shorter and the browser half renders it live.
 */

import type { JsonValue } from './types.js'
import { CATEGORICAL, SEQUENTIAL } from './theme.js'

const FONT =
  'Inter, "SF Pro Text", "Segoe UI", system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'

const INK = '#0b0b0b'
const INK_SECONDARY = '#52514e'

/** Title + text styling shared by every ECharts option, mirroring CHART_CONFIG. */
function baseOption(title: string): Record<string, JsonValue> {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT, color: INK_SECONDARY },
    title: {
      text: title,
      left: 0,
      top: 4,
      textStyle: { fontFamily: FONT, fontSize: 14, fontWeight: 600, color: INK },
    },
    color: [...CATEGORICAL],
    tooltip: { trigger: 'item' },
  }
}

/** One edge of a flow diagram. */
export interface FlowLink {
  readonly source: string
  readonly target: string
  readonly value: number
}

/** Build a sankey option from already-aggregated links. */
export function sankeyOption(title: string, links: readonly FlowLink[]): JsonValue {
  // Node set is the union of endpoints; ECharts requires it declared.
  const names = new Set<string>()
  for (const link of links) {
    names.add(link.source)
    names.add(link.target)
  }
  return {
    ...baseOption(title),
    series: [
      {
        type: 'sankey',
        top: 40,
        emphasis: { focus: 'adjacency' },
        data: [...names].map((name) => ({ name })),
        links: links.map((link) => ({ ...link })),
        lineStyle: { color: 'gradient', opacity: 0.4 },
        label: { fontFamily: FONT, color: INK_SECONDARY },
      },
    ],
  }
}

/** One node of a hierarchy, as ECharts expects it. */
export interface HierarchyNode {
  readonly name: string
  readonly value: number
  readonly children?: readonly HierarchyNode[]
}

function toPlain(node: HierarchyNode): JsonValue {
  return {
    name: node.name,
    value: node.value,
    ...(node.children === undefined ? {} : { children: node.children.map(toPlain) }),
  }
}

export function sunburstOption(title: string, roots: readonly HierarchyNode[]): JsonValue {
  return {
    ...baseOption(title),
    series: [
      {
        type: 'sunburst',
        top: 40,
        radius: [0, '90%'],
        data: roots.map(toPlain),
        label: { fontFamily: FONT, minAngle: 8 },
        itemStyle: { borderColor: '#ffffff', borderWidth: 1 },
      },
    ],
  }
}

export function treemapOption(title: string, roots: readonly HierarchyNode[]): JsonValue {
  return {
    ...baseOption(title),
    series: [
      {
        type: 'treemap',
        top: 40,
        roam: false,
        breadcrumb: { show: false },
        data: roots.map(toPlain),
        label: { fontFamily: FONT, color: '#ffffff' },
        itemStyle: { borderColor: '#ffffff', borderWidth: 2, gapWidth: 2 },
      },
    ],
  }
}

/**
 * Build a gauge for one measured value against a range.
 *
 * The band colours come from the sequential ramp rather than a red/amber/green
 * status palette: a KPI reading is magnitude, not a health verdict, and status
 * colours are reserved for actual states.
 */
export function gaugeOption(
  title: string,
  value: number,
  min: number,
  max: number,
  label: string,
): JsonValue {
  return {
    ...baseOption(title),
    tooltip: { show: false },
    series: [
      {
        type: 'gauge',
        min,
        max,
        center: ['50%', '58%'],
        radius: '78%',
        progress: { show: true, width: 14, itemStyle: { color: SEQUENTIAL[7] } },
        axisLine: { lineStyle: { width: 14, color: [[1, '#ecebe7']] } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { color: '#d6d4cd', width: 1 } },
        axisLabel: { fontFamily: FONT, color: INK_SECONDARY, fontSize: 10, distance: 14 },
        pointer: { show: false },
        detail: {
          valueAnimation: false,
          fontFamily: FONT,
          fontSize: 28,
          fontWeight: 650,
          color: INK,
          offsetCenter: [0, '10%'],
          formatter: '{value}',
        },
        title: { fontFamily: FONT, fontSize: 12, color: INK_SECONDARY, offsetCenter: [0, '48%'] },
        data: [{ value, name: label }],
      },
    ],
  }
}
