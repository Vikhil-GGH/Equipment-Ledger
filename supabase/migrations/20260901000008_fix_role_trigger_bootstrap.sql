-- prevent_self_role_escalation originally blocked ANY role change whose
-- auth.uid() isn't an admin — including auth.uid() IS NULL, which is the
-- case for direct database connections (SQL editor, `supabase db query`,
-- migrations) rather than PostgREST-authenticated requests. That made it
-- impossible to bootstrap the very first admin via SQL. A raw DB connection
-- already requires DB credentials (a strictly more trusted context than an
-- app JWT), so it's correct to let it through; only PostgREST-authenticated,
-- non-admin callers should be blocked from changing role.
create or replace function prevent_self_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not is_admin() then
    raise exception 'Only an admin can change a user role';
  end if;
  return new;
end;
$$;
