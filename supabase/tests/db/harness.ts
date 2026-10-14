/**
 * Database test harness for the SQL layer (RLS policies + SECURITY DEFINER
 * functions) — the part of the app the frontend unit tests can't reach.
 *
 * Two backends, same tests:
 *  - default: a disposable in-process PostgreSQL 17 (PGlite) with a
 *    Supabase stand-in (supabase-stub.sql) and every migration applied
 *    from scratch. Nothing outside this process is touched.
 *  - STAGING_DB_URL set: a real Supabase staging database that already has
 *    the migrations applied. Every test runs inside a transaction that is
 *    ROLLED BACK, so the staging data is left exactly as it was. Never
 *    point this at production.
 *
 * A "request" is simulated the way PostgREST does it: set the JWT claims
 * transaction-locally, then SET LOCAL ROLE authenticated.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations')
export const ROLLBACK_DIR = join(__dirname, '..', '..', 'rollback')

export interface Db {
  exec(sql: string): Promise<void>
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
  close(): Promise<void>
}

export const isStaging = !!process.env.STAGING_DB_URL

export async function openDb(): Promise<Db> {
  if (isStaging) {
    const { default: pg } = await import('pg')
    const { Client } = pg
    // Started via scripts/staging/run-db-tests.mjs, which has already
    // refused to run against production. Same TLS rules as lib.mjs.
    const url = process.env.STAGING_DB_URL!
    const caPath = process.env.STAGING_DB_SSL_CA
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url)
    const client = new Client({
      connectionString: url.replace(/[?&]sslmode=[^&]*/, ''),
      ssl: local
        ? false
        : caPath
          ? { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
          : { rejectUnauthorized: false },
    })
    await client.connect()
    return {
      exec: async (sql) => {
        await client.query(sql)
      },
      query: async (sql, params) => {
        const r = await client.query(sql, params as unknown[])
        return { rows: r.rows, rowCount: r.rowCount ?? 0 }
      },
      close: () => client.end(),
    }
  }

  const { PGlite } = await import('@electric-sql/pglite')
  const db = await PGlite.create()
  return {
    exec: async (sql) => {
      await db.exec(sql)
    },
    query: async <T>(sql: string, params?: unknown[]) => {
      const r = await db.query<T>(sql, params as unknown[])
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }
    },
    close: () => db.close(),
  }
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/** Applies one migration file in its own transaction, as the Supabase CLI does. */
export async function applyMigration(db: Db, file: string, prelude = ''): Promise<void> {
  let sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
  // PGlite doesn't bundle pgcrypto; gen_random_uuid() is core since PG13,
  // which is all the schema uses it for.
  sql = sql.replace(/create extension if not exists "pgcrypto";/i, '')
  await db.exec('begin')
  try {
    if (prelude) await db.exec(prelude)
    await db.exec(sql)
    await db.exec('commit')
  } catch (err) {
    await db.exec('rollback')
    throw err
  }
}

/** SQL from supabase/adaptations/ (known migration-file failures). */
export function readAdaptation(file: string): string {
  return readFileSync(join(__dirname, '..', '..', 'adaptations', file), 'utf8')
}

export async function applyRollback(db: Db, file: string): Promise<void> {
  const sql = readFileSync(join(ROLLBACK_DIR, file), 'utf8')
  await db.exec('begin')
  try {
    await db.exec(sql)
    await db.exec('commit')
  } catch (err) {
    await db.exec('rollback')
    throw err
  }
}

export async function loadSupabaseStub(db: Db): Promise<void> {
  await db.exec(readFileSync(join(__dirname, 'supabase-stub.sql'), 'utf8'))
}

/** Runs fn inside a transaction that is always rolled back. */
export async function inRolledBackTx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('begin')
  try {
    return await fn()
  } finally {
    await db.exec('rollback')
  }
}

/** Runs fn inside a transaction that is committed (PGlite baseline setup only). */
export async function inCommittedTx<T>(db: Db, fn: () => Promise<T>): Promise<T> {
  await db.exec('begin')
  try {
    const result = await fn()
    await db.exec('commit')
    return result
  } catch (err) {
    await db.exec('rollback')
    throw err
  }
}

export interface TestUser {
  id: string
  email: string | null
  anonymous: boolean
}

/** Switch the current transaction to act as an authenticated API request. */
export async function actAs(db: Db, user: TestUser, opts: { omitAnonymousClaim?: boolean } = {}) {
  const claims: Record<string, unknown> = { sub: user.id, role: 'authenticated', aal: 'aal1' }
  if (!opts.omitAnonymousClaim) claims.is_anonymous = user.anonymous
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
  await db.exec('set local role authenticated')
}

/** Back to the direct-connection (superuser, no JWT) context. */
export async function actAsDatabase(db: Db) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claims', '', true)`)
}

/**
 * Runs sql in a savepoint and reports the error message, or null if it
 * succeeded — so an expected failure doesn't abort the surrounding test
 * transaction. The role/claims in effect are kept either way.
 */
export async function errorOf(db: Db, sql: string, params?: unknown[]): Promise<string | null> {
  await db.exec('savepoint probe')
  try {
    await db.query(sql, params)
    await db.exec('release savepoint probe')
    return null
  } catch (err) {
    await db.exec('rollback to savepoint probe')
    return err instanceof Error ? err.message : String(err)
  }
}

/** Like errorOf, but returns rows on success. */
export async function tryQuery<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  params?: unknown[],
): Promise<{ rows: T[]; rowCount: number } | { error: string }> {
  await db.exec('savepoint probe')
  try {
    const r = await db.query<T>(sql, params)
    await db.exec('release savepoint probe')
    return r
  } catch (err) {
    await db.exec('rollback to savepoint probe')
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** Order-independent fingerprint of a table's full contents. */
export async function tableHash(db: Db, table: string): Promise<string> {
  const { rows } = await db.query<{ h: string }>(
    `select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${table} t`,
  )
  return rows[0].h
}
