import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AnalystEngine } from './engine.js'
import { attachDatabase, inferDatabaseKind, redactSecrets } from './database.js'
import { DuckDBInstance } from '@duckdb/node-api'

describe('inferDatabaseKind', () => {
  it('recognises connection strings and file suffixes', () => {
    expect(inferDatabaseKind('postgres://u:p@h:5432/db')).toBe('postgres')
    expect(inferDatabaseKind('postgresql://h/db')).toBe('postgres')
    expect(inferDatabaseKind('mysql://u:p@h/db')).toBe('mysql')
    expect(inferDatabaseKind('C:/data/app.sqlite')).toBe('sqlite')
    expect(inferDatabaseKind('./x.db')).toBe('sqlite')
  })

  it('refuses to guess otherwise', () => {
    expect(() => inferDatabaseKind('some-random-string')).toThrow(/Cannot infer/)
  })
})

describe('redactSecrets', () => {
  it('masks the password and keeps everything else', () => {
    expect(redactSecrets('postgres://alice:s3cret@db.host:5432/sales')).toBe(
      'postgres://alice:***@db.host:5432/sales',
    )
    expect(redactSecrets('C:/data/app.sqlite')).toBe('C:/data/app.sqlite')
  })
})

describe('attachDatabase over SQLite', () => {
  let dir: string
  let dbPath: string
  let engine: AnalystEngine

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'oa-sqlite-'))
    dbPath = join(dir, 'app.sqlite')
    // Author the fixture with DuckDB's own sqlite extension (no sqlite3 CLI
    // on this machine): write through a temporary writable ATTACH.
    const inst = await DuckDBInstance.create(':memory:')
    const con = await inst.connect()
    await con.run('INSTALL sqlite; LOAD sqlite')
    await con.run(`ATTACH '${dbPath.replace(/\\/g, '/')}' AS fixture (TYPE sqlite)`)
    // amount is cast to DOUBLE: SQLite has no DECIMAL, and the scanner maps a
    // TEXT-affinity column back as VARCHAR — a real quirk users hit too.
    await con.run(
      "CREATE TABLE fixture.orders AS SELECT id, region, amount::DOUBLE AS amount FROM (VALUES (1, 'East', 120.5), (2, 'West', 99.0), (3, 'East', 300.25)) AS t(id, region, amount)",
    )
    await con.run('DETACH fixture')
    con.closeSync()

    engine = await AnalystEngine.create()
  }, 120_000)

  afterAll(async () => {
    await engine.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('attaches read-only and lists the tables', async () => {
    const handle = await attachDatabase(engine, dbPath, { alias: 'app' })
    expect(handle.kind).toBe('sqlite')
    expect(handle.alias).toBe('app')
    expect(handle.tables.map((table) => table.name)).toContain('orders')
  })

  it('serves ordinary read-only queries against alias.table', async () => {
    await attachDatabase(engine, dbPath, { alias: 'app' })
    const result = await engine.query(
      'SELECT region, sum(amount) AS total FROM app.orders GROUP BY region ORDER BY total DESC',
    )
    expect(result.rows).toEqual([
      { region: 'East', total: 420.75 },
      { region: 'West', total: 99 },
    ])
  })

  it('rejects writes into the attached database through the policy', async () => {
    await attachDatabase(engine, dbPath, { alias: 'app' })
    await expect(engine.query("INSERT INTO app.orders VALUES (4, 'North', 1)")).rejects.toThrow(
      /read-only/,
    )
  })
})
