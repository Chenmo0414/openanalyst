/**
 * External database attachment: PostgreSQL, MySQL, and SQLite through DuckDB's
 * scanner extensions.
 *
 * A database differs from a file source in kind, not just in transport: it is
 * a container of many tables, so attaching one yields a {@link DatabaseHandle}
 * listing its tables rather than a single queryable view. Queries then address
 * tables as `alias.table` (or `alias.schema.table` for Postgres) through the
 * ordinary read-only `engine.query` path.
 *
 * Attachment is always `READ_ONLY`: the engine's whole security story is that
 * agent-authored SQL cannot mutate anything, and a writable remote ATTACH
 * would silently void it — DuckDB enforces read-only at the connector level.
 */

import type { AnalystEngine } from './engine.js'
import { AnalystError } from './engine.js'
import { asNumber } from './json.js'
import { quoteIdentifier, quoteLiteral, toAlias } from './sql.js'

export type DatabaseKind = 'postgres' | 'mysql' | 'sqlite'

export interface DatabaseTable {
  /** Schema within the attached database; null where the engine has none (MySQL maps its schema to the alias). */
  readonly schema: string | null
  readonly name: string
  /** Estimated rows as reported by the scanner; -1 when unknown. */
  readonly estimatedRows: number
}

export interface DatabaseHandle {
  readonly alias: string
  readonly kind: DatabaseKind
  /** Connection string with any password replaced by `***`. */
  readonly redactedOrigin: string
  readonly tables: readonly DatabaseTable[]
}

export interface AttachDatabaseOptions {
  readonly alias?: string
  /** Force the connector; inferred from the connection string when omitted. */
  readonly kind?: DatabaseKind
  readonly signal?: AbortSignal
}

/** Infer the connector from a connection string or file path. */
export function inferDatabaseKind(target: string): DatabaseKind {
  const lower = target.toLowerCase()
  if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return 'postgres'
  if (lower.startsWith('mysql://')) return 'mysql'
  if (/\.(db|db3|sqlite|sqlite3)$/.test(lower)) return 'sqlite'
  throw new AnalystError(
    `Cannot infer the database type of "${redactSecrets(target)}". ` +
      'Use a postgres:// or mysql:// URL, a .db/.sqlite file path, or pass the kind explicitly.',
  )
}

/** Strip the password from a connection string for logs and handles. */
export function redactSecrets(target: string): string {
  // scheme://user:password@host -> scheme://user:***@host
  return target.replace(/^(\w+:\/\/[^:/@]+):[^@]*@/, '$1:***@')
}

const EXTENSION_FOR: Record<DatabaseKind, string> = {
  postgres: 'postgres',
  mysql: 'mysql',
  sqlite: 'sqlite',
}

/**
 * DuckDB's MySQL connector rejects URL form in some versions; it always
 * accepts the key-value form. Postgres accepts both — normalized here so one
 * path is tested rather than two.
 */
function toConnectorString(target: string, kind: DatabaseKind): string {
  if (kind === 'sqlite') return target
  let url
  try {
    url = new URL(target)
  } catch {
    return target // already key-value form; DuckDB validates it
  }
  const parts: string[] = []
  if (url.hostname !== '') parts.push(`host=${url.hostname}`)
  if (url.port !== '') parts.push(`port=${url.port}`)
  const database = url.pathname.replace(/^\//, '')
  if (database !== '') parts.push(kind === 'postgres' ? `dbname=${database}` : `database=${database}`)
  if (url.username !== '') parts.push(`user=${decodeURIComponent(url.username)}`)
  if (url.password !== '') parts.push(`password=${decodeURIComponent(url.password)}`)
  return parts.join(' ')
}

/**
 * Attach an external database read-only and list its tables.
 *
 * Downloads and loads the scanner extension on first use (one-time network
 * fetch from DuckDB's extension repository).
 */
export async function attachDatabase(
  engine: AnalystEngine,
  target: string,
  options: AttachDatabaseOptions = {},
): Promise<DatabaseHandle> {
  const kind = options.kind ?? inferDatabaseKind(target)
  const alias = toAlias(options.alias ?? `${kind}_db`)
  const extension = EXTENSION_FOR[kind]

  try {
    await engine.execInternal(`INSTALL ${extension}; LOAD ${extension}`)
  } catch (cause) {
    throw new AnalystError(
      `Could not load DuckDB's ${extension} extension (a one-time download is required): ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }

  const connector = toConnectorString(target, kind)
  try {
    await engine.execInternal(
      `ATTACH IF NOT EXISTS ${quoteLiteral(connector)} AS ${quoteIdentifier(alias)} (TYPE ${extension}, READ_ONLY)`,
    )
  } catch (cause) {
    throw new AnalystError(
      `Could not attach ${kind} database as "${alias}": ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }

  const rows = await engine.queryInternal(
    `SELECT schema_name, table_name, estimated_size FROM duckdb_tables() ` +
      `WHERE database_name = ${quoteLiteral(alias)} ORDER BY schema_name, table_name`,
    options.signal,
  )

  const tables: DatabaseTable[] = rows.map((row) => ({
    schema: row['schema_name'] === null ? null : String(row['schema_name']),
    name: String(row['table_name'] ?? ''),
    estimatedRows: asNumber(row['estimated_size'] ?? null) ?? -1,
  }))

  return { alias, kind, redactedOrigin: redactSecrets(target), tables }
}
