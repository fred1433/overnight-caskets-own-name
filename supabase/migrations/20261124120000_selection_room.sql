-- Selection room, milestone one: one database, many funeral homes.
-- Every row a funeral home owns carries org_id, and row level security lets a signed-in
-- person reach only the rows of the homes they belong to. The catalog is shared and read-only.

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- Funeral homes and their staff ---------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand jsonb not null default '{}'::jsonb,            -- accent colour, monogram, typeface, logo
  -- Until the partner price list is loaded, cost is an illustrative share of the public price.
  wholesale_basis_pct numeric(5,2) not null default 100 check (wholesale_basis_pct > 0 and wholesale_basis_pct <= 100),
  created_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,                               -- auth.users.id on Supabase
  label text not null default '',
  role text not null check (role in ('owner', 'director', 'arranger')),
  can_see_cost boolean not null default false,
  can_edit_pricing boolean not null default false,
  can_order boolean not null default false,
  primary key (org_id, user_id)
);

-- Shared catalog, written only by the sync (service role) -------------------------------

create table public.catalog_items (
  id bigint primary key,                               -- Shopify product id
  item_type text not null,                             -- casket, lid_panel, urn, pet_casket, other: new types need no migration
  handle text not null unique,
  title text not null,
  attributes jsonb not null default '{}'::jsonb,       -- construction, finish, interior... as read from the product page
  image_url text,
  collections text[] not null default '{}',
  read_at timestamptz not null
);

create table public.catalog_variants (
  id bigint primary key,                               -- Shopify variant id, the one a cart link carries
  item_id bigint not null references public.catalog_items(id) on delete cascade,
  title text not null,
  order_type text,                                     -- 'Buy Now' or 'Pre-Need' when the product offers both
  public_price_cents integer not null check (public_price_cents >= 0),
  available boolean not null,
  read_at timestamptz not null
);
create index on public.catalog_variants (item_id);

-- What each home sets --------------------------------------------------------------------

create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  position integer not null,                           -- first matching rule wins
  label text not null,
  item_type text not null default 'casket',
  collection_handle text,                              -- null: every item of item_type not caught by an earlier rule
  markup_kind text not null check (markup_kind in ('percent', 'amount')),
  markup_value numeric(10,2) not null check (markup_value >= 0),
  rounding text not null check (rounding in ('cent', 'whole', 'ninety_five')),
  floor_cents integer not null default 0 check (floor_cents >= 0),
  unique (org_id, position)
);

create table public.selection_rooms (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  source_collection text,
  position integer not null default 0,
  unique (id, org_id)
);

create table public.selection_room_items (
  room_id uuid not null,
  org_id uuid not null,
  item_id bigint not null references public.catalog_items(id) on delete cascade,
  position integer not null default 0,
  primary key (room_id, item_id),
  foreign key (room_id, org_id) references public.selection_rooms(id, org_id) on delete cascade
);

-- The steps of a family session. A new step is a row, not a release.
create table public.session_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  label text not null,
  item_type text not null,
  required boolean not null default false,
  position integer not null,
  unique (org_id, key)
);

-- Arrangements ---------------------------------------------------------------------------

create table public.arrangements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  family_label text not null,
  order_type text not null default 'Buy Now' check (order_type in ('Buy Now', 'Pre-Need')),
  status text not null default 'saved' check (status in ('saved', 'ordered')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, org_id)
);

-- No foreign key to the catalog on purpose: a product that leaves the catalog must not
-- break or delete an arrangement already made. The line keeps its title and price.
create table public.arrangement_lines (
  id uuid primary key default gen_random_uuid(),
  arrangement_id uuid not null,
  org_id uuid not null,
  step_key text not null,
  item_id bigint not null,
  variant_id bigint not null,
  title_at_save text not null,
  retail_cents integer not null,                       -- set by the database from the home's rules, never by the client
  position integer not null default 0,
  foreign key (arrangement_id, org_id) references public.arrangements(id, org_id) on delete cascade
);

-- Cost and public price at save time, readable only by people allowed to see cost.
create table public.arrangement_line_costs (
  line_id uuid primary key references public.arrangement_lines(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  cost_cents integer not null,
  public_price_cents integer not null
);

-- Who may do what ------------------------------------------------------------------------

create or replace function app.is_member(o uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.org_id = o and m.user_id = auth.uid())
$$;

create or replace function app.can(o uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = o and m.user_id = auth.uid()
      and case perm
            when 'see_cost' then m.can_see_cost
            when 'edit_pricing' then m.can_edit_pricing
            when 'order' then m.can_order
            when 'invite' then m.role = 'owner'
            else false
          end)
$$;

-- Prices, in whole cents, identical to site/pricing.js ------------------------------------

create or replace function app.apply_rule(cost_cents bigint, markup_kind text, markup_value numeric,
                                          rounding text, floor_cents bigint) returns bigint
language sql immutable as $$
  with a as (
    select case markup_kind
             when 'percent' then (cost_cents * (10000 + round(markup_value * 100)::bigint) + 5000) / 10000
             else cost_cents + round(markup_value * 100)::bigint
           end as x
  ), r as (
    select case rounding
             when 'whole' then x + (100 - x % 100) % 100
             when 'ninety_five' then x + ((95 - x % 100) + 100) % 100
             else x
           end as y
    from a
  )
  select greatest(y, floor_cents) from r
$$;

create or replace function app.cost_cents(public_cents bigint, basis_pct numeric) returns bigint
language sql immutable as $$
  select (public_cents * round(basis_pct * 100)::bigint + 5000) / 10000
$$;

create or replace function app.price_for(o uuid, variant bigint)
returns table (cost_cents bigint, retail_cents bigint, public_price_cents bigint, rule_id uuid)
language sql stable security definer set search_path = public as $$
  with v as (
    select cv.public_price_cents, ci.item_type, ci.collections,
           app.cost_cents(cv.public_price_cents, org.wholesale_basis_pct) as cost
    from public.catalog_variants cv
    join public.catalog_items ci on ci.id = cv.item_id
    join public.organizations org on org.id = o
    where cv.id = variant
  ), rule as (
    select r.* from public.pricing_rules r, v
    where r.org_id = o and r.item_type = v.item_type
      and (r.collection_handle is null or r.collection_handle = any (v.collections))
    order by r.position
    limit 1
  )
  select v.cost,
         coalesce(app.apply_rule(v.cost, rule.markup_kind, rule.markup_value, rule.rounding, rule.floor_cents), v.public_price_cents),
         v.public_price_cents::bigint,
         rule.id
  from v left join rule on true
$$;

-- The database prices each line from the home's own rules and freezes cost at save time.
create or replace function app.price_line() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select * into p from app.price_for(new.org_id, new.variant_id);
  if p.retail_cents is null then
    raise exception 'variant % is not in the catalog', new.variant_id;
  end if;
  new.retail_cents := p.retail_cents;
  return new;
end $$;

create or replace function app.freeze_cost() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select * into p from app.price_for(new.org_id, new.variant_id);
  insert into public.arrangement_line_costs (line_id, org_id, cost_cents, public_price_cents)
  values (new.id, new.org_id, p.cost_cents, p.public_price_cents);
  return new;
end $$;

create trigger price_line before insert on public.arrangement_lines
  for each row execute function app.price_line();
create trigger freeze_cost after insert on public.arrangement_lines
  for each row execute function app.freeze_cost();

grant execute on function app.is_member(uuid), app.can(uuid, text), app.apply_rule(bigint, text, numeric, text, bigint),
  app.cost_cents(bigint, numeric), app.price_for(uuid, bigint) to authenticated, service_role;

-- Row level security ---------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.catalog_items enable row level security;
alter table public.catalog_variants enable row level security;
alter table public.pricing_rules enable row level security;
alter table public.selection_rooms enable row level security;
alter table public.selection_room_items enable row level security;
alter table public.session_steps enable row level security;
alter table public.arrangements enable row level security;
alter table public.arrangement_lines enable row level security;
alter table public.arrangement_line_costs enable row level security;

create policy "members read their home" on public.organizations
  for select to authenticated using (app.is_member(id));
create policy "owner updates the brand" on public.organizations
  for update to authenticated using (app.can(id, 'invite')) with check (app.can(id, 'invite'));

create policy "members read their team" on public.memberships
  for select to authenticated using (app.is_member(org_id));
create policy "owner invites" on public.memberships
  for insert to authenticated with check (app.can(org_id, 'invite'));
create policy "owner sets access" on public.memberships
  for update to authenticated using (app.can(org_id, 'invite')) with check (app.can(org_id, 'invite'));

create policy "catalog is readable" on public.catalog_items for select to authenticated using (true);
create policy "catalog is readable" on public.catalog_variants for select to authenticated using (true);

create policy "members read rules" on public.pricing_rules
  for select to authenticated using (app.is_member(org_id));
create policy "pricing staff write rules" on public.pricing_rules
  for all to authenticated using (app.can(org_id, 'edit_pricing')) with check (app.can(org_id, 'edit_pricing'));

create policy "members read rooms" on public.selection_rooms
  for select to authenticated using (app.is_member(org_id));
create policy "pricing staff write rooms" on public.selection_rooms
  for all to authenticated using (app.can(org_id, 'edit_pricing')) with check (app.can(org_id, 'edit_pricing'));
create policy "members read room items" on public.selection_room_items
  for select to authenticated using (app.is_member(org_id));
create policy "pricing staff write room items" on public.selection_room_items
  for all to authenticated using (app.can(org_id, 'edit_pricing')) with check (app.can(org_id, 'edit_pricing'));

create policy "members read steps" on public.session_steps
  for select to authenticated using (app.is_member(org_id));

create policy "members read arrangements" on public.arrangements
  for select to authenticated using (app.is_member(org_id));
create policy "members save arrangements" on public.arrangements
  for insert to authenticated with check (app.is_member(org_id));
create policy "members update arrangements" on public.arrangements
  for update to authenticated using (app.is_member(org_id)) with check (app.is_member(org_id));

create policy "members read lines" on public.arrangement_lines
  for select to authenticated using (app.is_member(org_id));
create policy "members write lines" on public.arrangement_lines
  for insert to authenticated with check (app.is_member(org_id));

create policy "cost readers" on public.arrangement_line_costs
  for select to authenticated using (app.can(org_id, 'see_cost'));

grant select on public.organizations, public.memberships, public.catalog_items, public.catalog_variants,
  public.pricing_rules, public.selection_rooms, public.selection_room_items, public.session_steps,
  public.arrangements, public.arrangement_lines, public.arrangement_line_costs to authenticated;
grant update (name, brand, wholesale_basis_pct) on public.organizations to authenticated;
grant insert, update on public.memberships to authenticated;
grant insert, update, delete on public.pricing_rules, public.selection_rooms, public.selection_room_items to authenticated;
grant insert, update on public.arrangements to authenticated;
grant insert on public.arrangement_lines to authenticated;
grant all on all tables in schema public to service_role;
