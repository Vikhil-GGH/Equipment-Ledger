-- Profiles: one row per auth.users row, carries the app-level role.
-- Never trust a client-supplied role; this table is the single source of
-- truth and is only ever mutated by an admin (via RLS below) or the
-- handle_new_user trigger.
create table profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  role user_role not null default 'viewer',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table profiles is
  'App-level identity + role for each Supabase Auth user. New signups default to viewer (least privilege); promote via admin panel or, for the very first admin, a one-time manual SQL update (see README).';

-- Auto-create a profile row (defaulting to 'viewer') whenever a new
-- auth.users row is created, so every authenticated user has a role.
create function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- Generic updated_at bumper, reused by every table below.
create function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at();
