-- READ-ONLY schema fingerprint. Run it in the SQL editor of BOTH projects
-- (production and staging), export each result as CSV, and compare with:
--   npm run staging:compare -- prod.csv staging.csv
-- It returns one row per database object with an md5 of its definition —
-- no table contents, no employee data, nothing that changes the database.
set session characteristics as transaction read only;

select 'function' as kind,
       p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> ' || pg_get_function_result(p.oid) as name,
       md5(pg_get_functiondef(p.oid)) as fingerprint
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
union all
select 'policy', tablename || '.' || policyname, md5(concat_ws('|', cmd, roles::text, qual, with_check))
from pg_policies where schemaname = 'public'
union all
select 'column', table_name || '.' || column_name, md5(concat_ws('|', data_type, udt_name, is_nullable, column_default))
from information_schema.columns where table_schema = 'public'
union all
select 'trigger', event_object_table || '.' || trigger_name || '.' || event_manipulation, md5(action_statement)
from information_schema.triggers where trigger_schema = 'public'
union all
select 'trigger', 'auth.users.' || t.tgname, md5(pg_get_triggerdef(t.oid))
from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal
union all
select 'enum', t.typname, md5(string_agg(e.enumlabel, ',' order by e.enumsortorder))
from pg_type t join pg_enum e on e.enumtypid = t.oid join pg_namespace n on n.oid = t.typnamespace
where n.nspname = 'public' group by t.typname
union all
select 'constraint', c.conrelid::regclass::text || '.' || c.conname, md5(pg_get_constraintdef(c.oid))
from pg_constraint c where c.connamespace = 'public'::regnamespace
union all
select 'rls', c.relname, case when c.relrowsecurity then 'enabled' else 'DISABLED' end
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1, 2;
