-- Chik-Biz — initial schema.
--
-- Design:
--   * Multi-tenant: every business record carries business_id.
--   * Tenant isolation is enforced by row-level security based on
--     auth.uid() membership in business_members — never on a client-supplied
--     business id alone.
--   * API roles (anon, authenticated) can only SELECT, and only their own
--     business's rows. Every write goes through a SECURITY DEFINER function in
--     the public schema that checks membership, validates business rules,
--     locks the rows it depends on, writes an audit entry and — for financial
--     documents — is idempotent on a client-generated id.
--   * Money is stored as integer cents (bigint).
--   * Stock on hand is derived from the append-only stock_movements ledger.
--   * Internal helpers live in the app_private schema, which is not exposed.

create schema app_private;
revoke all on schema app_private from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  address text not null default '' check (length(address) <= 500),
  phone text not null default '' check (length(phone) <= 40),
  email text not null default '' check (length(email) <= 120),
  logo_data_url text check (length(logo_data_url) <= 420000),
  currency char(3) not null default 'ZAR' check (currency ~ '^[A-Z]{3}$'),
  locale text not null default 'en-ZA',
  timezone text not null default 'Africa/Johannesburg',
  product_categories text[] not null default array['Live birds','Dressed chicken','Eggs','Other products'],
  expense_categories text[] not null default array['Feed','Medication & vaccines','Transport','Labour','Utilities','Packaging','Other operating costs'],
  payment_methods text[] not null default array['Cash','Card','EFT','Mobile payment','Other'],
  default_low_stock_threshold numeric(12,3) not null default 10 check (default_low_stock_threshold >= 0),
  max_discount_percent numeric(5,2) not null default 15 check (max_discount_percent between 0 and 100),
  batch_tracking_enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create type public.member_role as enum ('owner', 'manager', 'staff');

create table public.business_members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'staff',
  created_at timestamptz not null default now(),
  primary key (business_id, user_id)
);
create index on public.business_members (user_id);

create table public.units (
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(name) between 1 and 20),
  allow_decimal boolean not null default false,
  primary key (business_id, name)
);

create table public.products (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  category text not null,
  unit text not null,
  selling_price bigint not null check (selling_price >= 0),
  cost_price bigint check (cost_price >= 0),
  low_stock_threshold numeric(12,3) check (low_stock_threshold >= 0),
  track_stock boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  foreign key (business_id, unit) references public.units(business_id, name)
);
create unique index products_active_name on public.products (business_id, lower(name)) where not archived;

create table public.customers (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  business_name text not null default '',
  phone text not null default '',
  email text not null default '',
  address text not null default '',
  notes text not null default '',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.suppliers (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  contact_person text not null default '',
  phone text not null default '',
  email text not null default '',
  notes text not null default '',
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);

create table public.poultry_batches (
  id uuid primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  reference text not null,
  name text not null check (length(name) between 1 and 80),
  poultry_type text not null check (length(poultry_type) between 1 and 60),
  product_id uuid not null,
  start_date date not null,
  initial_quantity numeric(12,3) not null check (initial_quantity > 0),
  starting_cost bigint not null default 0 check (starting_cost >= 0),
  status text not null default 'active' check (status in ('active','closed')),
  notes text not null default '',
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, reference),
  foreign key (business_id, product_id) references public.products(business_id, id)
);

create table public.sales (
  id uuid primary key,                               -- client-generated idempotency key
  business_id uuid not null references public.businesses(id) on delete cascade,
  number text not null,
  sale_date date not null,
  customer_id uuid,
  walk_in_name text not null default '',
  status text not null default 'completed' check (status in ('completed','voided')),
  notes text not null default '',
  void_reason text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, number),
  foreign key (business_id, customer_id) references public.customers(business_id, id)
);

create table public.sale_lines (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  sale_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  batch_id uuid,
  description text not null,
  unit text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_price bigint not null check (unit_price >= 0),
  discount bigint not null default 0 check (discount >= 0),
  unique (sale_id, line_no),
  foreign key (business_id, sale_id) references public.sales(business_id, id) on delete cascade,
  foreign key (business_id, product_id) references public.products(business_id, id),
  foreign key (business_id, batch_id) references public.poultry_batches(business_id, id)
);
create index on public.sale_lines (business_id, sale_id);

create table public.purchases (
  id uuid primary key,                               -- client-generated idempotency key
  business_id uuid not null references public.businesses(id) on delete cascade,
  number text not null,
  supplier_id uuid not null,
  purchase_date date not null,
  status text not null default 'draft' check (status in ('draft','confirmed','cancelled')),
  reference text not null default '',
  notes text not null default '',
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, number),
  foreign key (business_id, supplier_id) references public.suppliers(business_id, id)
);

create table public.purchase_lines (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  purchase_id uuid not null,
  line_no int not null,
  product_id uuid not null,
  description text not null,
  unit text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  unique (purchase_id, line_no),
  foreign key (business_id, purchase_id) references public.purchases(business_id, id) on delete cascade,
  foreign key (business_id, product_id) references public.products(business_id, id)
);
create index on public.purchase_lines (business_id, purchase_id);

create table public.payments (
  id uuid primary key,                               -- client-generated idempotency key
  business_id uuid not null references public.businesses(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  payment_date date not null,
  amount bigint not null check (amount > 0),
  method text not null,
  sale_id uuid,
  purchase_id uuid,
  reference text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((direction = 'in' and sale_id is not null and purchase_id is null)
      or (direction = 'out' and purchase_id is not null and sale_id is null)),
  foreign key (business_id, sale_id) references public.sales(business_id, id),
  foreign key (business_id, purchase_id) references public.purchases(business_id, id)
);
create index on public.payments (business_id, sale_id);
create index on public.payments (business_id, purchase_id);

create table public.expenses (
  id uuid primary key,                               -- client-generated idempotency key
  business_id uuid not null references public.businesses(id) on delete cascade,
  expense_date date not null,
  category text not null,
  description text not null check (length(description) between 1 and 160),
  amount bigint not null check (amount > 0),
  method text not null,
  supplier_id uuid,
  reference text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (business_id, supplier_id) references public.suppliers(business_id, id)
);
create index on public.expenses (business_id, expense_date);

-- Append-only stock ledger. Stock on hand = sum(quantity).
create table public.stock_movements (
  id bigint generated always as identity primary key,
  business_id uuid not null,
  product_id uuid not null,
  batch_id uuid,
  quantity numeric(12,3) not null check (quantity <> 0),
  reason text not null check (reason in ('opening','purchase','sale','sale_void','restock','batch_intake','production','damage','loss','death','theft','own_use','count_correction','other')),
  movement_date date not null,
  note text not null default '',
  sale_id uuid,
  purchase_id uuid,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (business_id, product_id) references public.products(business_id, id),
  foreign key (business_id, batch_id) references public.poultry_batches(business_id, id),
  foreign key (business_id, sale_id) references public.sales(business_id, id),
  foreign key (business_id, purchase_id) references public.purchases(business_id, id)
);
create index on public.stock_movements (business_id, product_id);
create index on public.stock_movements (business_id, batch_id) where batch_id is not null;
create index on public.stock_movements (sale_id) where sale_id is not null;
create index on public.stock_movements (purchase_id) where purchase_id is not null;

create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  summary text not null,
  created_at timestamptz not null default now()
);
create index on public.audit_log (business_id, created_at desc);

create table public.counters (
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('sale','purchase','batch')),
  value int not null default 0,
  primary key (business_id, kind)
);

-- Foreign-key indexes for the composite keys used above.
create index on public.sales (business_id, customer_id);
create index on public.purchases (business_id, supplier_id);
create index on public.expenses (business_id, supplier_id);
create index on public.poultry_batches (business_id, product_id);
create index on public.sale_lines (business_id, product_id);
create index on public.sale_lines (business_id, batch_id);
create index on public.purchase_lines (business_id, product_id);
create index on public.businesses (created_by);
create index on public.sales (created_by);
create index on public.payments (created_by);
create index on public.expenses (created_by);
create index on public.stock_movements (created_by);
create index on public.audit_log (user_id);
create index on public.products (business_id, unit);

-- ---------------------------------------------------------------------------
-- Row-level security: members may read their own business's rows. No write
-- policies exist; writes happen only inside the functions below.
-- ---------------------------------------------------------------------------

create function public.is_member(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business and m.user_id = (select auth.uid())
  );
$$;

do $$
declare t text;
begin
  foreach t in array array['businesses','business_members','units','products','customers','suppliers','poultry_batches',
                           'sales','sale_lines','purchases','purchase_lines','payments','expenses','stock_movements',
                           'audit_log','counters'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    if t = 'businesses' then
      execute 'create policy "members read" on public.businesses for select to authenticated using ((select public.is_member(id)))';
    else
      execute format('create policy "members read" on public.%I for select to authenticated using ((select public.is_member(business_id)))', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Derived views (security_invoker so the caller's RLS applies)
-- ---------------------------------------------------------------------------

create view public.product_stock with (security_invoker = true) as
  select p.business_id, p.id as product_id, coalesce(sum(m.quantity), 0)::numeric(12,3) as on_hand
  from public.products p
  left join public.stock_movements m on m.product_id = p.id and m.business_id = p.business_id
  group by p.business_id, p.id;

create view public.sale_balances with (security_invoker = true) as
  select s.business_id, s.id as sale_id, s.customer_id, s.status,
         coalesce((select sum(round(l.quantity * l.unit_price) - l.discount) from public.sale_lines l where l.sale_id = s.id), 0)::bigint as total,
         coalesce((select sum(p.amount) from public.payments p where p.sale_id = s.id and p.direction = 'in'), 0)::bigint as paid
  from public.sales s;

revoke all on public.product_stock, public.sale_balances from anon;
grant select on public.product_stock, public.sale_balances to authenticated;
revoke execute on function public.is_member(uuid) from public, anon;
grant execute on function public.is_member(uuid) to authenticated;
