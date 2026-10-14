-- Minimal stand-in for the parts of a Supabase project the migrations and
-- security tests depend on. Loaded ONLY into the disposable in-process
-- database (PGlite) — a real Supabase project (local or staging) already
-- has all of this, and the real versions are what staging runs test.
--
-- Mirrors Supabase behaviour that matters here:
--  - anon / authenticated / service_role API roles; PostgREST runs each
--    request as one of them via SET ROLE.
--  - Default privileges grant those roles full table/function access in
--    public, so RLS policies are the only gate (exactly as on Supabase).
--  - auth.uid() / auth.jwt() read the request's JWT claims from the
--    request.jwt.claims setting, same definitions as Supabase's.
--  - auth.users is not readable by API roles.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);

create function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant execute on function auth.uid() to anon, authenticated, service_role;
grant execute on function auth.jwt() to anon, authenticated, service_role;
