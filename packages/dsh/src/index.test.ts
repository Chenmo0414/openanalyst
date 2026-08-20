/**
 * Integration test for the host half.
 *
 * `apply` runs against a stand-in Context that only collects registrations,
 * then each tool's `execute` is driven directly. That exercises the real
 * `defineTool` schema compilation and the real DuckDB engine — the parts a
 * mock would otherwise hide — without needing a running harness.
 */

import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from './index.ts'

const SALES_CSV = fileURLToPath(new URL('../../core/fixtures/sales.csv', import.meta.url))

interface AppendedEvent {
  readonly type: string
  readonly data: unknown
}

interface Harness {
  readonly tools: Map<string, ToolDefinition>
  readonly appended: AppendedEvent[]
  readonly teardown: () => void
}

function mountPlugin(): Harness {
  const tools = new Map<string, ToolDefinition>()
  const appended: AppendedEvent[] = []
  const teardowns: (() => void)[] = []

  const ctx = {
    tools: {
      register(definition: ToolDefinition) {
        tools.set(definition.name, definition)
      },
    },
    effect(execute: () => () => void) {
      teardowns.push(execute())
    },
  } as unknown as Context

  apply(ctx)

  return {
    tools,
    appended,
    teardown: () => {
      for (const dispose of teardowns) dispose()
    },
  }
}

/** A minimal ToolRunContext. `agent` is present only when a session is wanted. */
function runContext(appended?: AppendedEvent[]): ToolRunContext {
  const controller = new AbortController()
  const agent =
    appended === undefined
      ? undefined
      : {
          session: {
            append(type: string, data: unknown) {
              appended.push({ type, data })
            },
          },
        }
  return { signal: controller.signal, agent } as unknown as ToolRunContext
}

let harness: Harness

beforeEach(() => {
  harness = mountPlugin()
})

afterEach(() => {
  harness.teardown()
})

async function call(name: string, args: unknown, appended?: AppendedEvent[]): Promise<unknown> {
  const tool = harness.tools.get(name)
  if (tool === undefined) throw new Error(`tool ${name} was not registered`)
  return tool.execute(args, runContext(appended))
}

describe('plugin registration', () => {
  it('registers the five data tools', () => {
    expect([...harness.tools.keys()].sort()).toEqual([
      'data_attach',
      'data_chart',
      'data_profile',
      'data_query',
      'data_sources',
    ])
  })

  it('gives every tool a model-facing description', () => {
    for (const tool of harness.tools.values()) {
      expect(tool.description, tool.name).toBeTruthy()
    }
  })
})

describe('the attach -> profile -> query -> chart chain', () => {
  it('attaches a CSV and reports its columns', async () => {
    const result = (await call('data_attach', { path: SALES_CSV })) as {
      alias: string
      rowCount: number
      columns: { name: string }[]
    }
    expect(result.alias).toBe('sales')
    expect(result.rowCount).toBe(10)
    expect(result.columns).toHaveLength(7)
  })

  it('profiles the attached dataset and suggests charts', async () => {
    await call('data_attach', { path: SALES_CSV })
    const profile = (await call('data_profile', { source: 'sales' })) as {
      rowCount: number
      columns: { name: string; mean: number | null }[]
      issues: { column: string | null }[]
      suggestedCharts: { kind: string; x: string }[]
    }

    expect(profile.rowCount).toBe(10)
    expect(profile.columns.find((column) => column.name === 'region')?.mean).toBeNull()
    expect(profile.issues.some((issue) => issue.column === 'units')).toBe(true)
    expect(profile.suggestedCharts.length).toBeGreaterThan(0)
    expect(profile.suggestedCharts[0]?.kind).toBe('line')
  })

  it('answers a query and stays JSON-serialisable', async () => {
    await call('data_attach', { path: SALES_CSV })
    const result = (await call('data_query', {
      sql: 'SELECT region, sum(revenue) AS total FROM sales GROUP BY region ORDER BY total DESC',
    })) as { rows: Record<string, unknown>[]; truncated: boolean }

    expect(result.rows[0]).toEqual({ region: 'North', total: 12755.24 })
    expect(result.truncated).toBe(false)
    expect(() => JSON.stringify(result)).not.toThrow()
  })

  it('refuses a mutating query', async () => {
    await call('data_attach', { path: SALES_CSV })
    await expect(call('data_query', { sql: 'DROP VIEW sales' })).rejects.toThrow(
      /read-only statements/,
    )
  })

  it('lists attached sources', async () => {
    await call('data_attach', { path: SALES_CSV })
    const sources = (await call('data_sources', {})) as { alias: string; columnCount: number }[]
    expect(sources).toHaveLength(1)
    expect(sources[0]?.alias).toBe('sales')
    expect(sources[0]?.columnCount).toBe(7)
  })
})

describe('data_chart', () => {
  it('emits one openanalyst/chart event carrying a complete Vega-Lite spec', async () => {
    await call('data_attach', { path: SALES_CSV })
    const appended: AppendedEvent[] = []

    const result = (await call(
      'data_chart',
      { source: 'sales', kind: 'bar', x: 'region', y: 'revenue', aggregate: 'sum' },
      appended,
    )) as { displayed: boolean; rowCount: number; title: string }

    expect(result.displayed).toBe(true)
    expect(result.rowCount).toBe(4)

    expect(appended).toHaveLength(1)
    const event = appended[0]
    expect(event?.type).toBe('openanalyst/chart')

    const data = event?.data as {
      title: string
      kind: string
      source: string
      rowCount: number
      vegaLite: Record<string, unknown>
    }
    expect(data.kind).toBe('bar')
    expect(data.source).toBe('sales')
    expect(data.title).toBe(result.title)

    // The payload must be a whole-value checkpoint: everything needed to
    // redraw the chart on replay, with no reference to live state.
    expect(data.vegaLite['$schema']).toContain('vega-lite')
    expect(data.vegaLite['mark']).toEqual({ type: 'bar', tooltip: true })
    const inlined = data.vegaLite['data'] as { values: unknown[] }
    expect(inlined.values).toHaveLength(4)
  })

  it('survives a JSON round trip, so a replayed log rebuilds the same chart', async () => {
    await call('data_attach', { path: SALES_CSV })
    const appended: AppendedEvent[] = []
    await call(
      'data_chart',
      { source: 'sales', kind: 'line', x: 'order_date', y: 'revenue' },
      appended,
    )

    const payload = appended[0]?.data
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload)
  })

  it('still returns the canonical value when there is no agent to display it', async () => {
    await call('data_attach', { path: SALES_CSV })
    const result = (await call('data_chart', {
      source: 'sales',
      kind: 'histogram',
      x: 'revenue',
    })) as { displayed: boolean; rowCount: number }

    expect(result.displayed).toBe(false)
    expect(result.rowCount).toBe(10)
  })

  it('rejects an unknown column instead of guessing', async () => {
    await call('data_attach', { path: SALES_CSV })
    await expect(
      call('data_chart', { source: 'sales', kind: 'bar', x: 'nope', y: 'revenue' }),
    ).rejects.toThrow(/is not in "sales"/)
  })
})
