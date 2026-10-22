// A complete, comparable description of a database's public schema, as sorted text lines: columns (type,
// nullability, default), RLS state, policies, triggers, functions (identity + normalised definition hash),
// enum values, indexes, constraints, views. Read-only catalog queries only. Used to
//   - capture production's schema inside the backup (so the rehearsal can verify the copy is faithful),
//   - build the "expected" signature from the migration files on a disposable database, and diff the two.
// Differences found are reported in plain words (only-in-production / only-in-expected), never hidden.

const SQL = `
  select 'col ' || c.table_name || '.' || c.column_name || ' ' || c.data_type || coalesce('(' || c.udt_name || ')', '') || ' null=' || c.is_nullable || ' default=' || coalesce(c.column_default, '') || ' gen=' || coalesce(c.generation_expression, '') as l
    from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
  union all select 'view ' || viewname || ' ' || md5(replace(definition, E'\\r', '')) from pg_views where schemaname = 'public'
  union all select 'rls ' || c.relname || ' enabled=' || c.relrowsecurity from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  union all select 'pol ' || tablename || '.' || policyname || ' ' || cmd || ' roles=' || roles::text || ' qual=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
  union all select 'trg ' || c.relname || '.' || t.tgname || ' ' || md5(replace(pg_get_triggerdef(t.oid), E'\\r', '')) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
  union all select 'fn ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') secdef=' || p.prosecdef || ' ' || md5(replace(pg_get_functiondef(p.oid), E'\\r', '')) from pg_proc p where p.pronamespace = 'public'::regnamespace
  union all select 'enum ' || t.typname || '.' || e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typnamespace = 'public'::regnamespace
  union all select 'idx ' || tablename || ' ' || indexdef from pg_indexes where schemaname = 'public'
  union all select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
  order by 1`

/** @param {(sql: string, params?: unknown[]) => Promise<object[]>} q */
export async function schemaSignature(q) {
  return (await q(SQL)).map((r) => r.l)
}

/** Plain-words differences between production's signature and the expected one. */
export function diffSignatures(production, expected) {
  const p = new Set(production)
  const e = new Set(expected)
  return { onlyInProduction: production.filter((l) => !e.has(l)), onlyInExpected: expected.filter((l) => !p.has(l)) }
}
