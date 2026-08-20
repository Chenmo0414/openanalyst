/**
 * SQL safety helpers.
 *
 * The agent writes the SQL, so the engine treats every statement as untrusted.
 * Two rules are enforced before anything reaches DuckDB: exactly one statement,
 * and that statement's leading keyword is on a read-only allowlist. An
 * allowlist is used rather than a denylist of `DROP`/`DELETE`/... because a
 * denylist silently admits whatever the next DuckDB release adds.
 */

/** Leading keywords that cannot mutate the database or the filesystem. */
const READ_ONLY_LEAD = new Set([
  'select',
  'with',
  'from', // DuckDB FROM-first syntax: `FROM tbl SELECT *`
  'describe',
  'summarize',
  'explain',
  'pivot',
  'unpivot',
  'values',
  'table',
  'show',
])

export class SqlPolicyError extends Error {
  override readonly name = 'SqlPolicyError'
}

/**
 * Blank out comments and quoted spans so statement splitting and keyword
 * detection cannot be fooled by a semicolon or keyword living inside a string
 * literal, an identifier, or a comment. Lengths are preserved so offsets in
 * the returned string still line up with the input.
 */
function blankNoise(sql: string): string {
  const out = sql.split('')
  let index = 0

  const blankUntil = (isEnd: (position: number) => boolean, skip: number): void => {
    while (index < out.length && !isEnd(index)) {
      out[index] = ' '
      index += 1
    }
    for (let step = 0; step < skip && index < out.length; step += 1) {
      out[index] = ' '
      index += 1
    }
  }

  while (index < out.length) {
    const char = sql[index]
    const next = sql[index + 1]

    if (char === '-' && next === '-') {
      blankUntil((position) => sql[position] === '\n', 0)
      continue
    }
    if (char === '/' && next === '*') {
      out[index] = ' '
      out[index + 1] = ' '
      index += 2
      blankUntil((position) => sql[position] === '*' && sql[position + 1] === '/', 2)
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const quote = char
      out[index] = ' '
      index += 1
      // Doubled quotes ('' or "") are an escaped quote, not a terminator.
      while (index < out.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            out[index] = ' '
            out[index + 1] = ' '
            index += 2
            continue
          }
          out[index] = ' '
          index += 1
          break
        }
        out[index] = ' '
        index += 1
      }
      continue
    }
    index += 1
  }

  return out.join('')
}

/**
 * Validate that `sql` is a single read-only statement.
 *
 * @returns the trimmed statement, with any trailing semicolon removed.
 * @throws SqlPolicyError when the statement is empty, compound, or mutating.
 */
export function assertReadOnlyStatement(sql: string): string {
  const masked = blankNoise(sql)

  // Everything after the first semicolon must be blank, otherwise this is a
  // compound statement and the tail was never policy-checked.
  const semicolon = masked.indexOf(';')
  if (semicolon !== -1 && masked.slice(semicolon + 1).trim() !== '') {
    throw new SqlPolicyError(
      'Only one SQL statement is allowed. Remove the extra statement after the semicolon.',
    )
  }

  const end = semicolon === -1 ? sql.length : semicolon
  const statement = sql.slice(0, end).trim()
  if (statement === '') throw new SqlPolicyError('The SQL statement is empty.')

  const lead = masked.slice(0, end).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ''
  if (!READ_ONLY_LEAD.has(lead)) {
    throw new SqlPolicyError(
      `Only read-only statements are allowed here; this one starts with "${lead.toUpperCase() || '?'}". ` +
        `Use one of: ${[...READ_ONLY_LEAD].map((word) => word.toUpperCase()).join(', ')}.`,
    )
  }

  return statement
}

/** Quote a string for use as a SQL single-quoted literal. */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** Quote an identifier for use as a double-quoted SQL identifier. */
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Derive a safe view alias from a file path or user-supplied name.
 * Falls back to `dataset` when nothing usable survives.
 */
export function toAlias(input: string): string {
  const base = input
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.[^.]+$/, '')
    ?? ''

  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()

  if (cleaned === '') return 'dataset'
  return /^\d/.test(cleaned) ? `t_${cleaned}` : cleaned
}
