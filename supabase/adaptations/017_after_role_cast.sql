-- Applied right AFTER 20260901000017_anonymous_public_demo.sql when
-- rebuilding a database from the migration files (staging, tests).
--
-- 017 as written cannot insert a profile: its CASE expression is text, not
-- user_role, so creating ANY auth user fails with
--   column "role" is of type user_role but expression is of type text
-- Production evidently runs a working version, so this is 017's function
-- with only the ::user_role cast added. Compare with the live definition
-- using supabase/staging/schema-fingerprint.sql before relying on it.
-- Superseded by 20260901000022_close_anonymous_access.sql.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, full_name, role)
  values (
    new.id,
    coalesce(new.email, 'anonymous-' || new.id::text),
    new.raw_user_meta_data ->> 'full_name',
    (case when new.is_anonymous then 'editor' else 'viewer' end)::user_role
  );
  return new;
end;
$$;
