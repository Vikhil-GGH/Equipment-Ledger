/**
 * Reads EVERY row of a table through the API, page by page.
 *
 * The API returns at most 1,000 rows per request (PostgREST max_rows), and
 * silently stops there — so a plain select('*') on a bigger table quietly
 * loses rows. Here the server's exact row count is asked for with every
 * page, and paging continues until that many rows have arrived (not until
 * a page "looks short", which a server-side cap would fake). It throws —
 * never returns a partial list — when:
 *   - a request fails (network, permissions, timeout),
 *   - a page comes back empty before the count is reached,
 *   - the table's row count changes while it is being read,
 *   - the same row arrives twice, or the total doesn't match the count.
 */
export const PAGE_SIZE = 1000

interface PageResult {
  data: unknown[] | null
  error: { message: string; code?: string } | null
  count: number | null
}

/** The few query-builder calls used here, so tests can supply a fake. */
export interface PagedQuery {
  order(column: string, options: { ascending: boolean }): {
    range(from: number, to: number): PromiseLike<PageResult>
  }
  /** Only needed when a `filter` option uses them. */
  ilike?(column: string, pattern: string): PagedQuery
  eq?(column: string, value: string): PagedQuery
  or?(filters: string): PagedQuery
}

export interface PagedSource {
  from(table: string): {
    select(columns: string, options: { count: 'exact' }): PagedQuery
  }
}

export class IncompleteReadError extends Error {
  constructor(table: string, detail: string) {
    super(`Could not read all of ${table}: ${detail}`)
    this.name = 'IncompleteReadError'
  }
}

export async function fetchAllRows<T extends { id: string }>(
  client: PagedSource,
  table: string,
  {
    columns = '*',
    pageSize = PAGE_SIZE,
    filter,
  }: {
    columns?: string
    pageSize?: number
    /** Narrows every page the same way (e.g. the list's search), so the count is of matching rows. */
    filter?: (q: PagedQuery) => PagedQuery
  } = {},
): Promise<{ rows: T[]; count: number }> {
  const rows: T[] = []
  let expected: number | null = null
  for (;;) {
    const query = client.from(table).select(columns, { count: 'exact' })
    const { data, error, count } = await (filter ? filter(query) : query)
      .order('id', { ascending: true })
      .range(rows.length, rows.length + pageSize - 1)
    if (error) throw Object.assign(new IncompleteReadError(table, error.message), { code: error.code })
    if (count === null || count === undefined) throw new IncompleteReadError(table, 'the server did not report a row count')
    if (expected === null) expected = count
    else if (count !== expected) {
      throw new IncompleteReadError(table, `it changed while being read (${expected} → ${count} rows) — try again`)
    }
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (rows.length >= expected) break
    if (page.length === 0) throw new IncompleteReadError(table, `stopped after ${rows.length} of ${expected} rows`)
  }
  if (rows.length !== expected) {
    throw new IncompleteReadError(table, `received ${rows.length} rows, expected ${expected}`)
  }
  const ids = new Set(rows.map((r) => r.id))
  if (ids.size !== rows.length) {
    throw new IncompleteReadError(table, `${rows.length - ids.size} rows arrived twice (it changed while being read) — try again`)
  }
  return { rows, count: expected }
}
