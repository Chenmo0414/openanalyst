/**
 * Live connector tests against real PostgreSQL and MySQL servers.
 *
 * Skipped automatically when the servers are unreachable, so `pnpm test` stays
 * green on machines without the Docker fixtures. Bring them up with:
 *
 *   docker run -d --name oa-pg    -e POSTGRES_PASSWORD=oa_test -e POSTGRES_DB=salesdb -p 15432:5432 postgres:17-alpine
 *   docker run -d --name oa-mysql -e MYSQL_ROOT_PASSWORD=oa_test -e MYSQL_DATABASE=salesdb -p 13306:3306 mysql:9
 *
 * and seed each with an `orders` table (see docs/VERIFICATION.md).
 */

import { connect } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnalystEngine } from './engine.js'
import { attachDatabase } from './database.js'

const PG_URL = process.env['OA_TEST_PG'] ?? 'postgres://postgres:oa_test@127.0.0.1:15432/salesdb'
const MYSQL_URL = process.env['OA_TEST_MYSQL'] ?? 'mysql://root:oa_test@127.0.0.1:13306/salesdb'

function reachable(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (up: boolean): void => {
      socket.destroy()
      resolve(up)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    setTimeout(() => done(false), timeoutMs)
  })
}

let pgUp = false
let mysqlUp = false
let engine: AnalystEngine

beforeAll(async () => {
  ;[pgUp, mysqlUp] = await Promise.all([reachable('127.0.0.1', 15432), reachable('127.0.0.1', 13306)])
  engine = await AnalystEngine.create()
}, 30_000)

afterAll(async () => {
  await engine.close()
})

describe('postgres connector', () => {
  it('attaches read-only, lists tables, and answers aggregates', { timeout: 120_000 }, async (ctx) => {
    if (!pgUp) return ctx.skip()

    const handle = await attachDatabase(engine, PG_URL, { alias: 'pg' })
    expect(handle.kind).toBe('postgres')
    expect(handle.redactedOrigin).not.toContain('oa_test')
    expect(handle.tables.some((table) => table.name === 'orders')).toBe(true)

    const result = await engine.query(
      'SELECT region, sum(amount)::DOUBLE AS total FROM pg.public.orders GROUP BY region ORDER BY total DESC',
    )
    expect(result.rows[0]).toEqual({ region: 'East', total: 4440 })
    expect(result.rows).toHaveLength(4)
  })

  it('cannot write through the attachment', { timeout: 60_000 }, async (ctx) => {
    if (!pgUp) return ctx.skip()
    await expect(
      engine.query("INSERT INTO pg.public.orders VALUES (9,'X','Y',1,'2026-01-01')"),
    ).rejects.toThrow(/read-only/)
  })
})

describe('mysql connector', () => {
  it('attaches read-only, lists tables, and answers aggregates', { timeout: 120_000 }, async (ctx) => {
    if (!mysqlUp) return ctx.skip()

    const handle = await attachDatabase(engine, MYSQL_URL, { alias: 'my' })
    expect(handle.kind).toBe('mysql')
    expect(handle.redactedOrigin).not.toContain('oa_test')
    expect(handle.tables.some((table) => table.name === 'orders')).toBe(true)

    const result = await engine.query(
      'SELECT region, sum(amount)::DOUBLE AS total FROM my.salesdb.orders GROUP BY region ORDER BY total DESC',
    )
    expect(result.rows[0]).toEqual({ region: 'East', total: 4440 })
    expect(result.rows).toHaveLength(4)
  })
})
