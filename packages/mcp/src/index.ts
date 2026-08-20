#!/usr/bin/env node
/**
 * stdio bootstrap for the OpenAnalyst MCP server.
 *
 * stdio rather than HTTP because the datasets are local files: the server must
 * run where the data lives, one process per client session, no port, no auth
 * surface. Register with e.g.
 *
 *   claude mcp add openanalyst -- npx -y openanalyst-mcp-server
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from './server.js'

const server = createServer()
const transport = new StdioServerTransport()

// stdout carries the protocol; anything human-facing goes to stderr.
await server.connect(transport)
console.error('[openanalyst-mcp] ready (stdio)')
