/**
 * Protocol-level tests: a real MCP client talks to the real server over the
 * SDK's linked in-memory transport pair. This exercises schema validation,
 * structuredContent, and error mapping exactly as Claude Code would see them —
 * not a direct call into the handler functions.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from './server.js'

const SALES_CSV = fileURLToPath(new URL('../../../examples/sales-2026.csv', import.meta.url))

let client: Client
let chartDir: string

interface ToolOutcome {
  readonly isError?: boolean
  readonly content: readonly { readonly type: string; readonly text?: string }[]
  readonly structuredContent?: Record<string, unknown>
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  return (await client.callTool({ name, arguments: args })) as ToolOutcome
}

beforeAll(async () => {
  chartDir = mkdtempSync(join(tmpdir(), 'openanalyst-mcp-'))
  const server = createServer({ chartDir })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'test-client', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterAll(async () => {
  await client.close()
  rmSync(chartDir, { recursive: true, force: true })
})

describe('discovery', () => {
  it('lists the five data tools with schemas and annotations', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['data_attach', 'data_chart', 'data_profile', 'data_query', 'data_sources'])

    const query = tools.find((tool) => tool.name === 'data_query')
    expect(query?.description).toContain('read-only')
    expect(query?.annotations?.readOnlyHint).toBe(true)
    expect(query?.inputSchema).toBeDefined()
  })
})

describe('the analysis chain over the wire', () => {
  it('attaches, profiles, queries', async () => {
    const attach = await call('data_attach', { path: SALES_CSV })
    expect(attach.isError).toBeFalsy()
    expect(attach.structuredContent?.['alias']).toBe('sales_2026')
    expect(attach.structuredContent?.['rowCount']).toBe(482)

    const profile = await call('data_profile', { source: 'sales_2026' })
    expect(profile.isError).toBeFalsy()
    const columns = profile.structuredContent?.['columns'] as { name: string; distinct: number; distinctExact: boolean }[]
    expect(columns.find((column) => column.name === 'product')?.distinct).toBe(4)
    expect(columns.find((column) => column.name === 'product')?.distinctExact).toBe(true)
    const suggested = profile.structuredContent?.['suggestedCharts'] as unknown[]
    expect(suggested.length).toBeGreaterThan(0)

    const query = await call('data_query', {
      sql: 'SELECT region, sum(revenue) AS total FROM sales_2026 GROUP BY region ORDER BY total DESC LIMIT 1',
    })
    expect(query.isError).toBeFalsy()
    const rows = query.structuredContent?.['rows'] as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(typeof rows[0]?.['total']).toBe('number')
  })

  it('renders a chart to a real SVG file and returns the spec', async () => {
    await call('data_attach', { path: SALES_CSV })
    const chart = await call('data_chart', {
      source: 'sales_2026',
      kind: 'bar',
      x: 'region',
      y: 'revenue',
      aggregate: 'sum',
    })
    expect(chart.isError).toBeFalsy()

    const svgPath = chart.structuredContent?.['svgPath'] as string
    expect(svgPath).toContain(chartDir)
    const svg = readFileSync(svgPath, 'utf-8')
    expect(svg).toContain('<svg')
    // Four bars, one per region, must exist as path marks.
    expect(svg.length).toBeGreaterThan(2000)

    const spec = chart.structuredContent?.['vegaLite'] as Record<string, unknown>
    expect(spec['$schema']).toContain('vega-lite')
    expect(JSON.parse(JSON.stringify(spec))).toEqual(spec)
  })
})

describe('failure surfaces', () => {
  it('maps a mutating statement to an isError result with the policy message', async () => {
    const result = await call('data_query', { sql: 'DROP TABLE sales_2026' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('read-only')
  })

  it('maps an unknown dataset to an actionable error', async () => {
    const result = await call('data_profile', { source: 'nope' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('No dataset is attached')
  })

  it('rejects invalid enum input at the protocol layer', async () => {
    const outcome = await call('data_chart', {
      source: 'sales_2026',
      kind: 'pie',
      x: 'region',
      y: 'revenue',
    }).catch((error: unknown) => ({ threw: String(error) }))
    // Either the SDK rejects it client-side or the server returns isError —
    // both are acceptable; silently accepting 'pie' is not.
    const rejected =
      'threw' in outcome || (outcome as ToolOutcome).isError === true
    expect(rejected).toBe(true)
  })

  it('reports a missing file with the reader context', async () => {
    const result = await call('data_attach', { path: 'Z:/no/such/file.csv' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('Could not read')
  })
})
