-- Temporary public-demo mode: let anyone who opens the app link use it
-- without creating an account, via Supabase's built-in anonymous sign-in
-- (a real auth.users row, is_anonymous = true, with a real session/JWT).
-- This is deliberately implemented as "anonymous users get a role" rather
-- than by touching RLS policies or any RPC's role check, so it's a single
-- trigger to revert (back to unconditional 'viewer') once real sign-in is
-- ready and this flow should be retired.
--
-- Real (non-anonymous) signups are unaffected and still default to the
-- least-privilege 'viewer' role.
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
    case when new.is_anonymous then 'editor' else 'viewer' end
  );
  return new;
end;
$$;
