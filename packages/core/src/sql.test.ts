import { describe, expect, it } from 'vitest'
import { assertReadOnlyStatement, SqlPolicyError, toAlias } from './sql.js'

describe('assertReadOnlyStatement', () => {
  it('accepts read-only leading keywords', () => {
    for (const sql of [
      'SELECT 1',
      '  select * from t  ',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      "FROM t SELECT *",
      'DESCRIBE t',
      'SUMMARIZE SELECT * FROM t',
      'EXPLAIN SELECT 1',
      'PIVOT t ON a USING sum(b)',
      'VALUES (1), (2)',
      'SHOW TABLES',
    ]) {
      expect(() => assertReadOnlyStatement(sql), sql).not.toThrow()
    }
  })

  it('rejects mutating statements', () => {
    for (const sql of [
      'DROP TABLE t',
      'DELETE FROM t',
      'UPDATE t SET a = 1',
      'INSERT INTO t VALUES (1)',
      'CREATE TABLE t (a INT)',
      'ATTACH \'evil.db\'',
      'COPY t TO \'out.csv\'',
      'INSTALL httpfs',
    ]) {
      expect(() => assertReadOnlyStatement(sql), sql).toThrow(SqlPolicyError)
    }
  })

  it('rejects a mutating statement smuggled after a semicolon', () => {
    expect(() => assertReadOnlyStatement('SELECT 1; DROP TABLE t')).toThrow(SqlPolicyError)
    expect(() => assertReadOnlyStatement('SELECT 1;\n\n COPY t TO \'x\'')).toThrow(SqlPolicyError)
  })

  it('allows a bare trailing semicolon', () => {
    expect(assertReadOnlyStatement('SELECT 1;')).toBe('SELECT 1')
    expect(assertReadOnlyStatement('SELECT 1 ;  \n ')).toBe('SELECT 1')
  })

  it('does not treat a semicolon inside a string literal as a separator', () => {
    const sql = "SELECT 'a; DROP TABLE t' AS s"
    expect(assertReadOnlyStatement(sql)).toBe(sql)
  })

  it('does not treat a semicolon inside an identifier as a separator', () => {
    const sql = 'SELECT "weird;name" FROM t'
    expect(assertReadOnlyStatement(sql)).toBe(sql)
  })

  it('handles doubled quotes inside literals', () => {
    const sql = "SELECT 'it''s fine; really' AS s"
    expect(assertReadOnlyStatement(sql)).toBe(sql)
  })

  it('sees through a leading line comment', () => {
    expect(() => assertReadOnlyStatement('-- harmless\nDROP TABLE t')).toThrow(SqlPolicyError)
    expect(() => assertReadOnlyStatement('-- harmless\nSELECT 1')).not.toThrow()
  })

  it('sees through a leading block comment', () => {
    expect(() => assertReadOnlyStatement('/* SELECT */ DROP TABLE t')).toThrow(SqlPolicyError)
    expect(() => assertReadOnlyStatement('/* DROP */ SELECT 1')).not.toThrow()
  })

  it('rejects an empty statement', () => {
    expect(() => assertReadOnlyStatement('   ')).toThrow(SqlPolicyError)
    expect(() => assertReadOnlyStatement('-- only a comment')).toThrow(SqlPolicyError)
  })
})

describe('toAlias', () => {
  it('derives an identifier from a path', () => {
    expect(toAlias('D:\\data\\Q3 Sales.csv')).toBe('q3_sales')
    expect(toAlias('/tmp/report-2026.parquet')).toBe('report_2026')
    expect(toAlias('sales')).toBe('sales')
  })

  it('prefixes names that start with a digit', () => {
    expect(toAlias('2026-orders.csv')).toBe('t_2026_orders')
  })

  it('falls back when nothing usable survives', () => {
    expect(toAlias('***.csv')).toBe('dataset')
    expect(toAlias('')).toBe('dataset')
  })

  it('keeps non-latin names', () => {
    expect(toAlias('销售数据.csv')).toBe('销售数据')
  })
})
