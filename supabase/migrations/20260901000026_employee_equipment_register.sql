-- =========================================================================
-- Employee equipment register.
--
-- Adds a stable employee identity and a register of every item issued to
-- an employee — serialized devices (laptops, monitors, other equipment)
-- and Bulk Stock quantities (chargers, headsets…) — with how and when each
-- came back. Additive only: no existing row, column, history entry or
-- quantity is changed or removed.
--
--   * employees: one row per person. Existing free-text names are kept
--     everywhere; checklists gain a nullable employee_id. Names are matched
--     only on an exact normalized form (trimmed, spaces collapsed, case
--     ignored) and are never merged automatically —
--     employee_possible_duplicates lists likely duplicates for review.
--   * equipment_issues: one row per issued item. A serialized device can
--     have at most one open row. Bulk rows carry a quantity.
--   * Sync: a trigger on the four device tables opens/closes register rows
--     whenever a device's assignee changes, through ANY path (device page
--     actions, swap, transfer, onboarding, import, SQL editor, the
--     Inventory <-> Active Laptops moves, which keep the id). The existing
--     lifecycle functions are not rewritten.
--   * issue_equipment / return_equipment do issue/return as one
--     transaction, calling the existing perform_lifecycle_action /
--     perform_bulk_action so every state-machine and stock rule still
--     applies. Bulk quantities change only through perform_bulk_action.
--   * Backfill: one open row per device that is assigned today (dated from
--     its history). Bulk Stock gets NO rows — its totals don't say who has
--     what, so nothing is invented.
--   * C2 fix: onboarding_checklists.assigned_asset_id no longer references
--     active_laptops_np (that FK made a laptop issued at onboarding
--     impossible to collect). The column is kept.
--   * restore_backup / commit_asset_import updated (see bottom).
--
-- Rollback: supabase/rollback/20260901000026_down.sql
-- =========================================================================

-- ------------------------------------------------------------- employees
create function normalize_person_name(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(lower(regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g')), '');
$$;

create table employees (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (btrim(full_name) <> ''),
  name_key text generated always as (normalize_person_name(full_name)) stored,
  email text,
  created_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
-- Deliberately NOT unique: two different people can share a name.
create index employees_name_key_idx on employees (name_key);

comment on table employees is
  'One row per person who has been onboarded, offboarded or issued equipment. Never merged automatically — see employee_possible_duplicates.';

-- Likely duplicates, for manual review only (nothing acts on this).
create view employee_possible_duplicates
  with (security_invoker = true) as
select a.id as employee_id, a.full_name, b.id as other_employee_id, b.full_name as other_full_name,
  case
    when a.name_key = b.name_key then 'Same name — confirm these are different people'
    when regexp_replace(a.name_key, '[^a-z0-9]', '', 'g') = regexp_replace(b.name_key, '[^a-z0-9]', '', 'g')
      then 'Same letters, different punctuation or spacing'
    when (select string_agg(t, ' ' order by t) from unnest(string_to_array(a.name_key, ' ')) t)
       = (select string_agg(t, ' ' order by t) from unnest(string_to_array(b.name_key, ' ')) t)
      then 'Same words in a different order'
    else 'Same last name and first initial'
  end as reason
from employees a
join employees b on a.id < b.id
where a.name_key = b.name_key
   or regexp_replace(a.name_key, '[^a-z0-9]', '', 'g') = regexp_replace(b.name_key, '[^a-z0-9]', '', 'g')
   or (select string_agg(t, ' ' order by t) from unnest(string_to_array(a.name_key, ' ')) t)
    = (select string_agg(t, ' ' order by t) from unnest(string_to_array(b.name_key, ' ')) t)
   or (split_part(a.name_key, ' ', 1) <> '' and left(a.name_key, 1) = left(b.name_key, 1)
       and position(' ' in a.name_key) > 0 and position(' ' in b.name_key) > 0
       and regexp_replace(a.name_key, '^.* ', '') = regexp_replace(b.name_key, '^.* ', ''));

-- ------------------------------------------------- checklist additions
create type requirement_answer as enum ('yes', 'no', 'not_applicable');

alter table onboarding_checklists
  add column employee_id uuid references employees (id),
  add column requested_laptop text,
  -- No default: null = not answered yet. The administrator must choose.
  add column charger_required requirement_answer,
  add column headset_required requirement_answer;

alter table offboarding_checklists
  add column employee_id uuid references employees (id);

-- C2 fix (see header).
alter table onboarding_checklists drop constraint onboarding_checklists_assigned_asset_id_fkey;

-- ------------------------------------------------------------ register
create type equipment_issue_status as enum (
  'open',                -- with the employee (pending return once offboarding starts)
  'returned',
  'returned_damaged',
  'decommissioned',
  'retained_authorized', -- employee officially allowed to keep it
  'lost',
  'transferred',         -- reassigned to someone else
  'unassigned'           -- assignment removed outside a return (e.g. an import)
);

create table equipment_issues (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid references employees (id),
  -- The name exactly as recorded on the device / at issue time.
  assignee_name text not null,
  -- The name matched more than one employee and none was chosen explicitly.
  employee_ambiguous boolean not null default false,
  item_kind text not null check (item_kind in ('serialized', 'bulk')),
  -- serialized: the device (its id never changes, even when it moves table)
  asset_collection asset_collection,
  asset_id uuid,
  -- bulk
  bulk_item_id uuid references bulk_items (id),
  quantity integer not null default 1 check (quantity > 0),
  description text not null,
  serial text,
  issued_at timestamptz not null default now(),
  issued_by uuid references profiles (id),
  onboarding_id uuid references onboarding_checklists (id) on delete set null,
  status equipment_issue_status not null default 'open',
  closed_at timestamptz,
  closed_by uuid references profiles (id),
  close_note text,
  approved_by uuid references profiles (id),
  offboarding_id uuid references offboarding_checklists (id) on delete set null,
  source text not null default 'issue' check (source in ('issue', 'lifecycle', 'import', 'backfill', 'restore')),
  created_at timestamptz not null default now(),
  constraint equipment_issues_item check (
    (item_kind = 'serialized' and asset_id is not null and asset_collection is not null and bulk_item_id is null and quantity = 1)
    or (item_kind = 'bulk' and bulk_item_id is not null and asset_id is null and asset_collection is null)
  ),
  constraint equipment_issues_closed check ((status = 'open') = (closed_at is null)),
  constraint equipment_issues_reason check (status not in ('retained_authorized', 'lost') or btrim(coalesce(close_note, '')) <> '')
);

-- A device can be with at most one person at a time.
create unique index equipment_issues_one_open_per_asset on equipment_issues (asset_id) where status = 'open';
create index equipment_issues_employee_idx on equipment_issues (employee_id);
create index equipment_issues_bulk_idx on equipment_issues (bulk_item_id) where bulk_item_id is not null;

comment on table equipment_issues is
  'Every item issued to an employee and how it came back. Written only by the database (sync trigger, issue_equipment, return_equipment); read-only to users.';

-- ----------------------------------------------------------------- RLS
alter table employees enable row level security;
alter table equipment_issues enable row level security;
create policy employees_select_known on employees for select using (is_known_user());
create policy equipment_issues_select_known on equipment_issues for select using (is_known_user());
-- No insert/update/delete policies: writes go through the functions below.

-- Devices whose assignee doesn't match their open register row. Should
-- always be empty; the app warns if not.
create view equipment_register_mismatches
  with (security_invoker = true) as
with devices as (
  select 'serialized_assets'::asset_collection as collection, id, serial, assigned_to from serialized_assets
  union all select 'active_laptops_np', id, serial, assigned_to from active_laptops_np
  union all select 'monitors', id, serial, assigned_to from monitors
  union all select 'other_equipment', id, serial, assigned_to from other_equipment
)
select d.collection, d.id as asset_id, d.serial, d.assigned_to, i.assignee_name as register_assignee
from devices d
left join equipment_issues i on i.asset_id = d.id and i.status = 'open'
where normalize_person_name(d.assigned_to) is distinct from normalize_person_name(i.assignee_name);

-- ------------------------------------------------------ name -> employee
-- Exact normalized match only. Returns (employee_id, ambiguous):
--   one match -> that employee; none -> a new employee (if p_create);
--   several   -> (null, true) — never guessed.
create function resolve_employee(p_name text, p_create boolean, p_hint uuid default null)
returns table (employee_id uuid, ambiguous boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := normalize_person_name(p_name);
  v_ids uuid[];
begin
  if v_key is null then
    return query select null::uuid, false;
    return;
  end if;
  if p_hint is not null and exists (select 1 from employees e where e.id = p_hint and e.name_key = v_key) then
    return query select p_hint, false;
    return;
  end if;
  select array_agg(e.id) into v_ids from employees e where e.name_key = v_key;
  if coalesce(array_length(v_ids, 1), 0) = 1 then
    return query select v_ids[1], false;
  elsif coalesce(array_length(v_ids, 1), 0) > 1 then
    return query select null::uuid, true;
  elsif p_create then
    return query insert into employees (full_name, created_by) values (btrim(p_name), auth.uid()) returning id, false;
  else
    return query select null::uuid, false;
  end if;
end;
$$;

-- ------------------------------------------------------------ the sync
-- Transaction-local settings the issue/return functions use to tell the
-- trigger what is happening (all optional):
--   equipment.context       'issue' | 'import' | 'restore'
--   equipment.employee_id   the employee chosen explicitly
--   equipment.onboarding_id / equipment.offboarding_id
--   equipment.close_status  the return outcome
--   equipment.close_note    the reason / approval note
--   equipment.sync_disabled 'on' while restore_backup reloads everything
create function equipment_setting(p_name text)
returns text
language sql
stable
as $$
  select nullif(current_setting(p_name, true), '');
$$;

create function sync_equipment_register()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := nullif(btrim(new.assigned_to), '');
  v_open equipment_issues;
  v_status equipment_issue_status;
  v_employee uuid;
  v_ambiguous boolean;
  v_context text := equipment_setting('equipment.context');
begin
  if equipment_setting('equipment.sync_disabled') = 'on' then
    return null;
  end if;

  select * into v_open from equipment_issues where asset_id = new.id and status = 'open' for update;

  if v_open.id is not null then
    if v_name is not null and normalize_person_name(v_name) = normalize_person_name(v_open.assignee_name) then
      -- Same person (e.g. the device moved between Inventory and Active
      -- Laptops, or was marked damaged while assigned): keep the row open.
      if v_open.asset_collection::text <> tg_table_name then
        update equipment_issues set asset_collection = tg_table_name::asset_collection where id = v_open.id;
      end if;
      return null;
    end if;

    v_status := coalesce(
      equipment_setting('equipment.close_status')::equipment_issue_status,
      case
        when v_name is not null then 'transferred'
        when v_context = 'import' then 'unassigned'
        when new.status = 'damaged' then 'returned_damaged'
        when new.status = 'decommissioned' then 'decommissioned'
        when new.status::text = 'lost' then 'lost'
        else 'returned'
      end::equipment_issue_status
    );
    update equipment_issues
      set status = v_status,
          closed_at = now(),
          closed_by = auth.uid(),
          close_note = coalesce(equipment_setting('equipment.close_note'), close_note),
          approved_by = case when v_status = 'retained_authorized' then auth.uid() else approved_by end,
          offboarding_id = coalesce(equipment_setting('equipment.offboarding_id')::uuid, offboarding_id)
      where id = v_open.id;
  end if;

  if v_name is not null then
    select r.employee_id, r.ambiguous into v_employee, v_ambiguous
      from resolve_employee(v_name, true, equipment_setting('equipment.employee_id')::uuid) r;
    insert into equipment_issues
      (employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection, asset_id,
       description, serial, issued_by, onboarding_id, source)
    values
      (v_employee, v_name, v_ambiguous, 'serialized', tg_table_name::asset_collection, new.id,
       new.name, new.serial, auth.uid(), equipment_setting('equipment.onboarding_id')::uuid,
       case when v_context in ('issue', 'import') then v_context else 'lifecycle' end);
  end if;
  return null;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['serialized_assets', 'active_laptops_np', 'monitors', 'other_equipment'] loop
    execute format(
      'create trigger %I after insert on %I for each row execute function sync_equipment_register()',
      v_table || '_sync_register_insert', v_table);
    execute format(
      'create trigger %I after update of assigned_to on %I for each row when (old.assigned_to is distinct from new.assigned_to) execute function sync_equipment_register()',
      v_table || '_sync_register_update', v_table);
  end loop;
end $$;

-- --------------------------------------------------------- employees API
create function create_employee(p_full_name text, p_email text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to add employees';
  end if;
  if btrim(coalesce(p_full_name, '')) = '' then
    raise exception 'A name is required';
  end if;
  insert into employees (full_name, email, created_by)
  values (btrim(p_full_name), nullif(btrim(p_email), ''), auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- ------------------------------------------------------------ issuing
-- Issue one item to an employee as one transaction. Serialized: the
-- normal Provide (same rules, same Inventory -> Active Laptops move) — the
-- sync trigger records the register row. Bulk: the normal "issue" bulk
-- action (Available -> Provided) plus a register row. Returns the register
-- row id. Nothing here is triggered by answering "Charger/Headset
-- required" — issuing is always an explicit call.
create function issue_equipment(
  p_employee_id uuid,
  p_collection asset_collection default null,
  p_asset_id uuid default null,
  p_bulk_item_id uuid default null,
  p_quantity integer default 1,
  p_onboarding_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee employees;
  v_issue uuid;
  v_item bulk_items;
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to issue equipment';
  end if;
  select * into v_employee from employees where id = p_employee_id;
  if v_employee.id is null then
    raise exception 'Employee not found';
  end if;
  if (p_asset_id is null) = (p_bulk_item_id is null) then
    raise exception 'Issue exactly one item: a device or a Bulk Stock item';
  end if;
  if p_onboarding_id is not null and not exists (select 1 from onboarding_checklists where id = p_onboarding_id) then
    raise exception 'Onboarding record not found';
  end if;

  perform set_config('equipment.context', 'issue', true);
  perform set_config('equipment.employee_id', v_employee.id::text, true);
  perform set_config('equipment.onboarding_id', coalesce(p_onboarding_id::text, ''), true);

  if p_asset_id is not null then
    if p_collection is null then
      raise exception 'p_collection is required for a device';
    end if;
    perform perform_lifecycle_action(p_collection, p_asset_id, 'provide', v_employee.full_name, p_note);
    select id into v_issue from equipment_issues where asset_id = p_asset_id and status = 'open';
    if v_issue is null then
      raise exception 'Register out of sync after issuing device %', p_asset_id;
    end if;
    -- A laptop issued during onboarding completes "Equipment assigned".
    if p_onboarding_id is not null and p_collection in ('serialized_assets', 'active_laptops_np') then
      update onboarding_checklists
        set equipment_assigned = true, assigned_asset_id = coalesce(assigned_asset_id, p_asset_id)
        where id = p_onboarding_id;
    end if;
  else
    if coalesce(p_quantity, 0) <= 0 then
      raise exception 'Quantity must be a positive number';
    end if;
    select * into v_item from bulk_items where id = p_bulk_item_id;
    if v_item.id is null then
      raise exception 'Bulk item not found';
    end if;
    perform perform_bulk_action(p_bulk_item_id, 'issue', p_quantity, null,
      coalesce(nullif(btrim(p_note), ''), 'Issued to ' || v_employee.full_name));
    insert into equipment_issues
      (employee_id, assignee_name, item_kind, bulk_item_id, quantity, description, issued_by, onboarding_id, source)
    values
      (v_employee.id, v_employee.full_name, 'bulk', p_bulk_item_id, p_quantity, v_item.name, auth.uid(), p_onboarding_id, 'issue')
    returning id into v_issue;
  end if;

  perform set_config('equipment.context', '', true);
  perform set_config('equipment.employee_id', '', true);
  perform set_config('equipment.onboarding_id', '', true);
  return v_issue;
end;
$$;

-- ------------------------------------------------------------ returning
-- Process one register row. Outcomes and their inventory effect:
--                     serialized device                     bulk (from Provided)
--   returned          Collect -> Available, unassigned       return -> Available
--   returned_damaged  Collect + Mark damaged -> Damaged      mark_damaged -> Damaged
--   decommissioned    Decommission -> Decommissioned         decommission -> Decommissioned
--   retained_authorized  stays Provided & assigned; history  decommission (written off:
--                        entry with approver + reason          not Available, not pending)
--   lost              -> Lost, unassigned; history + reason   decommission (written off)
-- retained_authorized and lost require a reason. Bulk rows may be returned
-- in part (p_quantity): the row is split, the rest stays open.
create function return_equipment(
  p_issue_id uuid,
  p_outcome equipment_issue_status,
  p_quantity integer default null,
  p_note text default null,
  p_offboarding_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_issue equipment_issues;
  v_collection asset_collection;
  v_status asset_status;
  v_history text;
  v_qty integer;
  v_closed uuid;
  v_note text := nullif(btrim(p_note), '');
begin
  if not is_editor_or_admin() then
    raise exception 'Not authorized to process returns';
  end if;
  if p_outcome not in ('returned', 'returned_damaged', 'decommissioned', 'retained_authorized', 'lost') then
    raise exception 'Not a return outcome: %', p_outcome;
  end if;
  if p_outcome in ('retained_authorized', 'lost') and v_note is null then
    raise exception 'A reason is required for %', p_outcome;
  end if;
  if p_offboarding_id is not null and not exists (select 1 from offboarding_checklists where id = p_offboarding_id) then
    raise exception 'Offboarding record not found';
  end if;

  select * into v_issue from equipment_issues where id = p_issue_id for update;
  if v_issue.id is null then
    raise exception 'Register entry not found';
  end if;
  if v_issue.status <> 'open' then
    raise exception 'This item has already been processed (%)', v_issue.status;
  end if;

  perform set_config('equipment.close_status', p_outcome::text, true);
  perform set_config('equipment.close_note', coalesce(v_note, ''), true);
  perform set_config('equipment.offboarding_id', coalesce(p_offboarding_id::text, ''), true);

  if v_issue.item_kind = 'serialized' then
    -- Where the device lives now (it keeps its id when it moves).
    select c, s into v_collection, v_status from (
      select 'serialized_assets'::asset_collection c, status s from serialized_assets where id = v_issue.asset_id
      union all select 'active_laptops_np', status from active_laptops_np where id = v_issue.asset_id
      union all select 'monitors', status from monitors where id = v_issue.asset_id
      union all select 'other_equipment', status from other_equipment where id = v_issue.asset_id
    ) d;
    if v_collection is null then
      raise exception 'Device no longer exists';
    end if;
    v_history := case v_collection when 'serialized_assets' then 'serialized_asset_history' else v_collection::text || '_history' end;

    if p_outcome = 'retained_authorized' then
      -- The employee keeps the device: inventory unchanged (still Provided
      -- to them), the approval is recorded on the register and the device.
      update equipment_issues
        set status = 'retained_authorized', closed_at = now(), closed_by = auth.uid(), approved_by = auth.uid(),
            close_note = v_note, offboarding_id = coalesce(p_offboarding_id, offboarding_id)
        where id = v_issue.id;
      execute format('insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)', v_history)
        using v_issue.asset_id, 'retention_approved', format('Retention by %s approved: %s', v_issue.assignee_name, v_note), auth.uid();
    elsif p_outcome = 'lost' then
      if v_status not in ('provided', 'damaged') then
        raise exception 'Only an assigned device can be marked lost (currently %)', v_status;
      end if;
      execute format('update %I set status = ''lost'', assigned_to = null where id = $1', v_collection) using v_issue.asset_id;
      execute format('insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)', v_history)
        using v_issue.asset_id, 'mark_lost', format('Lost (was with %s): %s', v_issue.assignee_name, v_note), auth.uid();
    elsif v_status = 'damaged' then
      -- Marked damaged while still assigned (audit H6): unassign it here,
      -- it stays Damaged — returned or decommissioned alike end Damaged.
      perform set_config('equipment.close_status', 'returned_damaged', true);
      execute format('update %I set assigned_to = null where id = $1', v_collection) using v_issue.asset_id;
      execute format('insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)', v_history)
        using v_issue.asset_id, 'collect', coalesce(v_note, 'Returned while damaged'), auth.uid();
    elsif p_outcome = 'decommissioned' then
      perform perform_lifecycle_action(v_collection, v_issue.asset_id, 'decommission', null, v_note);
    else
      v_collection := perform_lifecycle_action(v_collection, v_issue.asset_id, 'collect', null, v_note);
      if p_outcome = 'returned_damaged' then
        perform perform_lifecycle_action(v_collection, v_issue.asset_id, 'mark_damaged', null, v_note);
      end if;
    end if;

    if exists (select 1 from equipment_issues where id = v_issue.id and status = 'open') then
      raise exception 'Register out of sync after returning device %', v_issue.asset_id;
    end if;
    v_closed := v_issue.id;
  else
    v_qty := coalesce(p_quantity, v_issue.quantity);
    if v_qty <= 0 or v_qty > v_issue.quantity then
      raise exception 'Quantity must be between 1 and % for this item', v_issue.quantity;
    end if;
    case p_outcome
      when 'returned' then
        perform perform_bulk_action(v_issue.bulk_item_id, 'return', v_qty, null,
          coalesce(v_note, 'Returned by ' || v_issue.assignee_name));
      when 'returned_damaged' then
        perform perform_bulk_action(v_issue.bulk_item_id, 'mark_damaged', v_qty, 'provided',
          coalesce(v_note, 'Returned damaged by ' || v_issue.assignee_name));
      when 'decommissioned' then
        perform perform_bulk_action(v_issue.bulk_item_id, 'decommission', v_qty, 'provided',
          coalesce(v_note, 'Decommissioned on return from ' || v_issue.assignee_name));
      when 'retained_authorized' then
        perform perform_bulk_action(v_issue.bulk_item_id, 'decommission', v_qty, 'provided',
          format('Written off — retained by %s (authorized): %s', v_issue.assignee_name, v_note));
      when 'lost' then
        perform perform_bulk_action(v_issue.bulk_item_id, 'decommission', v_qty, 'provided',
          format('Written off — lost by %s: %s', v_issue.assignee_name, v_note));
    end case;

    if v_qty < v_issue.quantity then
      -- Part of the quantity: split it off as its own closed row.
      update equipment_issues set quantity = quantity - v_qty where id = v_issue.id;
      insert into equipment_issues
        (employee_id, assignee_name, employee_ambiguous, item_kind, bulk_item_id, quantity, description,
         issued_at, issued_by, onboarding_id, status, closed_at, closed_by, close_note, approved_by, offboarding_id, source)
      values
        (v_issue.employee_id, v_issue.assignee_name, v_issue.employee_ambiguous, 'bulk', v_issue.bulk_item_id, v_qty,
         v_issue.description, v_issue.issued_at, v_issue.issued_by, v_issue.onboarding_id, p_outcome, now(), auth.uid(),
         v_note, case when p_outcome = 'retained_authorized' then auth.uid() end, p_offboarding_id, v_issue.source)
      returning id into v_closed;
    else
      update equipment_issues
        set status = p_outcome, closed_at = now(), closed_by = auth.uid(), close_note = v_note,
            approved_by = case when p_outcome = 'retained_authorized' then auth.uid() end,
            offboarding_id = coalesce(p_offboarding_id, offboarding_id)
        where id = v_issue.id;
      v_closed := v_issue.id;
    end if;
  end if;

  perform set_config('equipment.close_status', '', true);
  perform set_config('equipment.close_note', '', true);
  perform set_config('equipment.offboarding_id', '', true);
  return v_closed;
end;
$$;

-- ------------------------------------------------------------ backfill
-- Shared by this migration and by restoring a pre-026 backup: one employee
-- per normalized name in use, checklists linked by name, and one open row
-- per device assigned today. Never touches checklist timestamps, devices,
-- history or bulk quantities. Bulk Stock gets no rows.
create function rebuild_equipment_register_from_assignments()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into employees (full_name)
  select distinct on (key) name
  from (
    select normalize_person_name(n) as key, btrim(n) as name, count(*) over (partition by normalize_person_name(n), btrim(n)) as uses
    from (
      select employee_name as n from onboarding_checklists
      union all select employee_name from offboarding_checklists
      union all select assigned_to from serialized_assets
      union all select assigned_to from active_laptops_np
      union all select assigned_to from monitors
      union all select assigned_to from other_equipment
    ) names
    where normalize_person_name(n) is not null
  ) spelled
  where not exists (select 1 from employees e where e.name_key = spelled.key)
  order by key, uses desc, name;

  alter table onboarding_checklists disable trigger onboarding_checklists_set_updated_at;
  alter table offboarding_checklists disable trigger offboarding_checklists_set_updated_at;
  update onboarding_checklists c set employee_id = e.id
    from employees e
    where c.employee_id is null and e.name_key = normalize_person_name(c.employee_name)
      and (select count(*) from employees x where x.name_key = e.name_key) = 1;
  update offboarding_checklists c set employee_id = e.id
    from employees e
    where c.employee_id is null and e.name_key = normalize_person_name(c.employee_name)
      and (select count(*) from employees x where x.name_key = e.name_key) = 1;
  alter table onboarding_checklists enable trigger onboarding_checklists_set_updated_at;
  alter table offboarding_checklists enable trigger offboarding_checklists_set_updated_at;

  insert into equipment_issues
    (employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection, asset_id, description, serial,
     issued_at, onboarding_id, source)
  select
    case when emp.n = 1 then emp.id end,
    btrim(d.assigned_to),
    coalesce(emp.n, 0) > 1,
    'serialized', d.collection, d.id, d.name, d.serial,
    coalesce(h.last_issued, d.updated_at),
    (select o.id from onboarding_checklists o where o.assigned_asset_id = d.id order by o.created_at desc limit 1),
    'backfill'
  from (
    select 'serialized_assets'::asset_collection as collection, id, name, serial, assigned_to, updated_at from serialized_assets
    union all select 'active_laptops_np', id, name, serial, assigned_to, updated_at from active_laptops_np
    union all select 'monitors', id, name, serial, assigned_to, updated_at from monitors
    union all select 'other_equipment', id, name, serial, assigned_to, updated_at from other_equipment
  ) d
  left join lateral (
    select max(e.id::text)::uuid as id, count(*) as n from employees e where e.name_key = normalize_person_name(d.assigned_to)
  ) emp on true
  left join lateral (
    select max(x.date) as last_issued from (
      select date, asset_id, action from serialized_asset_history
      union all select date, asset_id, action from active_laptops_np_history
      union all select date, asset_id, action from monitors_history
      union all select date, asset_id, action from other_equipment_history
    ) x where x.asset_id = d.id and x.action in ('provide', 'transfer', 'swap')
  ) h on true
  where normalize_person_name(d.assigned_to) is not null
    and not exists (select 1 from equipment_issues i where i.asset_id = d.id and i.status = 'open');
end;
$$;

select rebuild_equipment_register_from_assignments();

-- Internal helpers are not callable through the API.
revoke execute on function sync_equipment_register() from public, anon, authenticated;
revoke execute on function rebuild_equipment_register_from_assignments() from public, anon, authenticated;
revoke execute on function resolve_employee(text, boolean, uuid) from public, anon, authenticated;
revoke execute on function equipment_setting(text) from public, anon, authenticated;


-- ------------------------------------------------------------- imports
-- Same as 20260901000019 except one line: imports mark their assignment
-- changes so the register records them as import changes (an import that
-- blanks an assignee closes the row as 'unassigned', not 'returned').
create or replace function commit_asset_import(
  p_collection asset_collection,
  p_filename text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text := p_collection::text;
  v_history_table text := case p_collection
    when 'serialized_assets' then 'serialized_asset_history'
    when 'active_laptops_np' then 'active_laptops_np_history'
    when 'monitors' then 'monitors_history'
    when 'other_equipment' then 'other_equipment_history'
  end;
  v_actor uuid := auth.uid();
  v_role user_role;
  v_row jsonb;
  v_id uuid;
  v_created int := 0;
  v_updated int := 0;
begin
  select role into v_role from profiles where id = v_actor;
  if v_role is null or v_role not in ('admin', 'editor') then
    raise exception 'Not authorized to import';
  end if;

  -- Tell the register's sync trigger that assignment changes come from an
  -- import (20260901000026).
  perform set_config('equipment.context', 'import', true);

  for v_row in select * from jsonb_array_elements(p_rows)
  loop
    execute format('select id from %I where serial = $1', v_table)
      into v_id
      using (v_row ->> 'serial');

    if v_id is null then
      execute format(
        'insert into %I (name, category, serial, status, assigned_to, location) values ($1,$2,$3,$4,$5,$6) returning id',
        v_table
      )
      into v_id
      using
        v_row ->> 'name',
        v_row ->> 'category',
        v_row ->> 'serial',
        coalesce(nullif(v_row ->> 'status', ''), 'available')::asset_status,
        nullif(v_row ->> 'assigned_to', ''),
        nullif(v_row ->> 'location', '');

      execute format(
        'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
        v_history_table
      ) using v_id, 'created', 'Imported from ' || p_filename, v_actor;

      v_created := v_created + 1;
    else
      execute format(
        'update %I set name = $1, category = $2, status = $3, assigned_to = $4, location = $5 where id = $6',
        v_table
      )
      using
        v_row ->> 'name',
        v_row ->> 'category',
        coalesce(nullif(v_row ->> 'status', ''), 'available')::asset_status,
        nullif(v_row ->> 'assigned_to', ''),
        nullif(v_row ->> 'location', ''),
        v_id;

      execute format(
        'insert into %I (asset_id, action, detail, actor_user_id) values ($1, $2, $3, $4)',
        v_history_table
      ) using v_id, 'imported', 'Updated via import from ' || p_filename, v_actor;

      v_updated := v_updated + 1;
    end if;
  end loop;

  insert into import_events
    (imported_by, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  values
    (v_actor, v_table, p_filename, v_created, v_updated, 0, jsonb_build_object('total', v_created + v_updated));

  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;

-- ------------------------------------------------------- backup/restore
-- As 20260901000024, plus employees, equipment_issues and the new
-- checklist columns. The sync trigger is switched off while everything is
-- reloaded (the register comes from the backup itself). A backup from
-- before 026 has no employees/equipment_issues: the register is then
-- rebuilt from the restored assignments, exactly like the 026 backfill.
create or replace function restore_backup(p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can restore a backup';
  end if;

  perform set_config('equipment.sync_disabled', 'on', true);

  -- Clear current data. The register goes first (it references devices'
  -- bulk items and checklists), then checklists (onboarding/offboarding
  -- reference employees), then everything else. History tables cascade
  -- from their parent asset/item tables.
  delete from equipment_issues;
  delete from onboarding_checklists;
  delete from offboarding_checklists;
  delete from employees;
  delete from import_events;
  delete from serialized_assets;
  delete from active_laptops_np;
  delete from monitors;
  delete from other_equipment;
  delete from bulk_items;

  -- ---------------------------------------------------------- employees
  insert into employees (id, full_name, email, created_by, created_at)
  select t.id, t.full_name, t.email, p.id, t.created_at
  from jsonb_to_recordset(coalesce(p_payload -> 'employees', '[]'::jsonb))
    as t(id uuid, full_name text, email text, created_by uuid, created_at timestamptz)
  left join profiles p on p.id = t.created_by;

  -- ------------------------------------------------------------- assets
  insert into serialized_assets (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'serialized_assets', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz);

  insert into active_laptops_np (id, name, category, serial, status, assigned_to, location, created_at, updated_at, moved_from_inventory)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at, coalesce(moved_from_inventory, false)
  from jsonb_to_recordset(coalesce(p_payload -> 'active_laptops_np', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz, moved_from_inventory boolean);

  insert into monitors (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'monitors', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz);

  insert into other_equipment (id, name, category, serial, status, assigned_to, location, created_at, updated_at)
  select id, name, category, serial, status, assigned_to, location, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'other_equipment', '[]'::jsonb))
    as t(id uuid, name text, category text, serial text, status asset_status,
         assigned_to text, location text, created_at timestamptz, updated_at timestamptz);

  insert into bulk_items (id, name, category, location, available, provided, retained, damaged, decommissioned, created_at, updated_at)
  select id, name, category, location, available, provided, retained, damaged, decommissioned, created_at, updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'bulk_items', '[]'::jsonb))
    as t(id uuid, name text, category text, location text, available int, provided int,
         retained int, damaged int, decommissioned int, created_at timestamptz, updated_at timestamptz);

  -- ------------------------------------------------------------ history
  insert into serialized_asset_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'serialized_asset_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into active_laptops_np_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'active_laptops_np_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into monitors_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'monitors_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into other_equipment_history (id, asset_id, date, action, detail, actor_user_id)
  select t.id, t.asset_id, t.date, t.action, t.detail, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'other_equipment_history', '[]'::jsonb))
    as t(id uuid, asset_id uuid, date timestamptz, action text, detail text, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  insert into bulk_item_history (id, item_id, date, action, detail, quantity, actor_user_id)
  select t.id, t.item_id, t.date, t.action, t.detail, t.quantity, p.id
  from jsonb_to_recordset(coalesce(p_payload -> 'bulk_item_history', '[]'::jsonb))
    as t(id uuid, item_id uuid, date timestamptz, action text, detail text, quantity int, actor_user_id uuid)
  left join profiles p on p.id = t.actor_user_id;

  -- --------------------------------------------------------- checklists
  -- assigned_asset_id is kept as stored (no foreign key since 026).
  -- employee_id is kept only if that employee was restored too.
  insert into onboarding_checklists
    (id, employee_name, identity_created, equipment_assigned, required_access_provided,
     onboarding_successful, assigned_asset_id, employee_id, requested_laptop, charger_required,
     headset_required, created_by, created_at, updated_at)
  select t.id, t.employee_name, t.identity_created, t.equipment_assigned, t.required_access_provided,
         t.onboarding_successful, t.assigned_asset_id, e.id, t.requested_laptop, t.charger_required,
         t.headset_required, p.id, t.created_at, t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'onboarding_checklists', '[]'::jsonb))
    as t(id uuid, employee_name text, identity_created boolean, equipment_assigned boolean,
         required_access_provided boolean, onboarding_successful boolean, assigned_asset_id uuid,
         employee_id uuid, requested_laptop text, charger_required requirement_answer,
         headset_required requirement_answer, created_by uuid, created_at timestamptz, updated_at timestamptz)
  left join employees e on e.id = t.employee_id
  left join profiles p on p.id = t.created_by;

  -- laptop_outcome / outcome_needs_review: see 20260901000024 (null in
  -- pre-024 backups; the sync trigger derives them from the legacy flags).
  insert into offboarding_checklists
    (id, employee_name, removed_access, laptop_received, laptop_retained, laptop_decommissioned,
     laptop_outcome, outcome_needs_review, employee_id, created_by, created_at, updated_at)
  select t.id, t.employee_name, t.removed_access, t.laptop_received, t.laptop_retained,
         t.laptop_decommissioned, t.laptop_outcome, coalesce(t.outcome_needs_review, false),
         e.id, p.id, t.created_at, t.updated_at
  from jsonb_to_recordset(coalesce(p_payload -> 'offboarding_checklists', '[]'::jsonb))
    as t(id uuid, employee_name text, removed_access boolean, laptop_received boolean,
         laptop_retained boolean, laptop_decommissioned boolean,
         laptop_outcome offboarding_laptop_outcome, outcome_needs_review boolean, employee_id uuid,
         created_by uuid, created_at timestamptz, updated_at timestamptz)
  left join employees e on e.id = t.employee_id
  left join profiles p on p.id = t.created_by;

  insert into import_events
    (id, imported_by, imported_at, target_collection, filename, rows_created, rows_updated, rows_errored, summary)
  select t.id, p.id, t.imported_at, t.target_collection, t.filename, t.rows_created, t.rows_updated, t.rows_errored, t.summary
  from jsonb_to_recordset(coalesce(p_payload -> 'import_events', '[]'::jsonb))
    as t(id uuid, imported_by uuid, imported_at timestamptz, target_collection text, filename text,
         rows_created int, rows_updated int, rows_errored int, summary jsonb)
  left join profiles p on p.id = t.imported_by;

  -- ----------------------------------------------------------- register
  insert into equipment_issues
    (id, employee_id, assignee_name, employee_ambiguous, item_kind, asset_collection, asset_id, bulk_item_id,
     quantity, description, serial, issued_at, issued_by, onboarding_id, status, closed_at, closed_by,
     close_note, approved_by, offboarding_id, source, created_at)
  select t.id, e.id, t.assignee_name, coalesce(t.employee_ambiguous, false), t.item_kind, t.asset_collection,
         t.asset_id, t.bulk_item_id, t.quantity, t.description, t.serial, t.issued_at, ib.id, o.id, t.status,
         t.closed_at, cb.id, t.close_note, ab.id, f.id, t.source, t.created_at
  from jsonb_to_recordset(coalesce(p_payload -> 'equipment_issues', '[]'::jsonb))
    as t(id uuid, employee_id uuid, assignee_name text, employee_ambiguous boolean, item_kind text,
         asset_collection asset_collection, asset_id uuid, bulk_item_id uuid, quantity int, description text,
         serial text, issued_at timestamptz, issued_by uuid, onboarding_id uuid, status equipment_issue_status,
         closed_at timestamptz, closed_by uuid, close_note text, approved_by uuid, offboarding_id uuid,
         source text, created_at timestamptz)
  left join employees e on e.id = t.employee_id
  left join profiles ib on ib.id = t.issued_by
  left join profiles cb on cb.id = t.closed_by
  left join profiles ab on ab.id = t.approved_by
  left join onboarding_checklists o on o.id = t.onboarding_id
  left join offboarding_checklists f on f.id = t.offboarding_id;

  if not (p_payload ? 'equipment_issues') then
    -- A backup from before 026: rebuild the register from assignments.
    perform rebuild_equipment_register_from_assignments();
  end if;

  perform set_config('equipment.sync_disabled', '', true);
end;
$$;
