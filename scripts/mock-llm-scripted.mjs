/**
 * Scripted OpenAI-compatible mock LLM for live verification of the dsh plugin.
 *
 * Why not `@deepseek-ai/dsh-llm-mock-server`: its `tool_call_success` behavior
 * emits ONE globally-configured tool name, but verifying the chart node needs a
 * conversation where consecutive model turns call DIFFERENT tools
 * (data_attach -> data_chart -> closing text). This server answers each
 * `/chat/completions` request with the next entry of a fixed script instead.
 * The SSE chunk shapes are transcribed from that package's implementation.
 *
 * Usage:  node scripts/mock-llm-scripted.mjs [port]
 * Then:   DEEPSEEK_BASE_URL=http://127.0.0.1:<port>/v1 DEEPSEEK_API_KEY=mock \
 *         dsh --profile web ... (with session-title-llm disabled — the title
 *         call would otherwise consume a script entry).
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 8471)
const CSV = 'D:/Code/openanalyst/examples/sales-2026.csv'

/** One script entry per expected model request, in arrival order. */
const SCRIPT = [
  {
    kind: 'tool',
    name: 'data_attach',
    args: { path: CSV },
  },
  {
    kind: 'tool',
    name: 'data_profile',
    args: { source: 'sales_2026' },
  },
  {
    kind: 'tool',
    name: 'data_chart',
    args: { source: 'sales_2026', kind: 'heatmap', x: 'region', y: 'product', value: 'revenue', aggregate: 'sum' },
  },
  {
    kind: 'tool',
    name: 'data_chart',
    args: { source: 'sales_2026', kind: 'boxplot', x: 'region', y: 'revenue' },
  },
  {
    kind: 'tool',
    name: 'data_chart',
    args: { source: 'sales_2026', kind: 'bar', x: 'region', y: 'revenue', color: 'product', stack: 'grouped' },
  },
  {
    kind: 'text',
    text:
      'Attached sales-2026.csv (482 rows), profiled it, and rendered three charts: a ' +
      'region-by-product revenue heatmap, revenue distributions per region (boxplot), and ' +
      'grouped revenue bars. The profile flagged 2 duplicate rows and 13 revenue outliers.',
  },
]

let cursor = 0

function sse(res, payload) {
  res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

function toolCallChunks(name, argsJson) {
  const midpoint = Math.max(1, Math.floor(argsJson.length / 2))
  return [
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: `mock-call-${cursor}`,
            type: 'function',
            function: { name, arguments: argsJson.slice(0, midpoint) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: argsJson.slice(midpoint) } }] },
        finish_reason: null,
      }],
    },
  ]
}

function terminalChunk(reason) {
  return {
    choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }],
    usage: { prompt_tokens: 3, completion_tokens: 2 },
  }
}

const server = createServer((req, res) => {
  const url = req.url ?? ''
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(url.split('?')[0])) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${url}` } }))
    return
  }

  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const entry = SCRIPT[Math.min(cursor, SCRIPT.length - 1)]
    const step = cursor
    cursor += 1

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })

    if (entry.kind === 'tool') {
      const argsJson = JSON.stringify(entry.args)
      for (const chunk of toolCallChunks(entry.name, argsJson)) sse(res, chunk)
      sse(res, terminalChunk('tool_calls'))
      console.log(`[mock] #${step} -> tool_call ${entry.name} ${argsJson}`)
    } else {
      sse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: entry.text }, finish_reason: null }] })
      sse(res, terminalChunk('stop'))
      console.log(`[mock] #${step} -> text (${entry.text.length} chars)`)
    }
    sse(res, '[DONE]')
    res.end()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] scripted LLM listening on http://127.0.0.1:${PORT}/v1 (${SCRIPT.length} entries)`)
})
