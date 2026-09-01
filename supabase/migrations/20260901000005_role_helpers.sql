-- Role-check helpers used throughout RLS policies and lifecycle functions.
-- Centralized here so the permission boundaries documented in README.md
-- have exactly one implementation to keep in sync.
create function my_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid();
$$;

create function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select role from profiles where id = auth.uid()) = 'admin', false);
$$;

-- Admin or Editor: the two roles allowed to mutate ledger data.
create function is_editor_or_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role from profiles where id = auth.uid()) in ('admin', 'editor'),
    false
  );
$$;

-- Any authenticated role that can at least read the ledger (all four roles).
create function is_known_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from profiles where id = auth.uid());
$$;
