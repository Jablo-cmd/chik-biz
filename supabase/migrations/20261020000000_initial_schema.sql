-- Chik-Biz — proposed initial schema for a future Supabase backend.
--
-- STATUS: proposal for review. This migration has NOT been applied to any
-- Supabase project. It has only been executed against a local, disposable
-- PostgreSQL 16 instance with a stubbed `auth` schema (see supabase/README.md).
--
-- Design:
--   * Multi-tenant: every business record carries business_id.
--   * Tenant isolation is enforced by row-level security based on
--     auth.uid() membership in business_members — never on a client-supplied
--     business id alone.
--   * Money is stored as integer cents (bigint).
--   * Stock on hand is derived from the append-only stock_movements ledger.
--   * Financial and stock-changing operations go through SECURITY DEFINER
--     functions (create_sale, record_sale_payment, confirm_purchase,
--     adjust_stock) that check membership, validate business rules, lock rows
--     and are idempotent on a client-generated id.
--   * Direct INSERT/UPDATE/DELETE on ledger tables is not granted.

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  logo_path text,                                   -- Supabase Storage path
  currency char(3) not null default 'ZAR',
  locale text not null default 'en-ZA',
  product_categories text[] not null default array['Live birds','Dressed chicken','Eggs','Other products'],
  expense_categories text[] not null default array['Feed','Medication & vaccines','Transport','Labour','Utilities','Packaging','Other operating costs'],
  payment_methods text[] not null default array['Cash','Card','EFT','Mobile payment','Other'],
  default_low_stock_threshold numeric(12,3) not null default 10 check (default_low_stock_threshold >= 0),
  max_discount_percent numeric(5,2) not null default 15 check (max_discount_percent between 0 and 100),
  batch_tracking_enabled boolean not null default true,
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

-- Membership helpers. SECURITY DEFINER so policies can consult
-- business_members without recursive RLS evaluation.
create function public.is_member(p_business uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business and m.user_id = (select auth.uid())
  );
$$;

create function public.has_role(p_business uuid, p_roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.business_members m
    where m.business_id = p_business and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;

-- ---------------------------------------------------------------------------
-- Catalogue, customers, suppliers
-- ---------------------------------------------------------------------------

create table public.products (
  id uuid primary key default gen_random_uuid(),
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
  foreign key (business_id, unit) references public.units(business_id, name) on update cascade
);
create unique index products_active_name on public.products (business_id, lower(name)) where not archived;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
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
  id uuid primary key default gen_random_uuid(),
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
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  reference text not null,
  name text not null,
  poultry_type text not null,
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

-- ---------------------------------------------------------------------------
-- Transactions
-- ---------------------------------------------------------------------------

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
  created_by uuid references auth.users(id),
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
  product_id uuid not null,
  description text not null,
  unit text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  unit_cost bigint not null check (unit_cost >= 0),
  foreign key (business_id, purchase_id) references public.purchases(business_id, id) on delete cascade,
  foreign key (business_id, product_id) references public.products(business_id, id)
);

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
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check ((direction = 'in' and sale_id is not null and purchase_id is null)
      or (direction = 'out' and purchase_id is not null and sale_id is null)),
  foreign key (business_id, sale_id) references public.sales(business_id, id),
  foreign key (business_id, purchase_id) references public.purchases(business_id, id)
);

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
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, supplier_id) references public.suppliers(business_id, id)
);

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
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (business_id, product_id) references public.products(business_id, id),
  foreign key (business_id, batch_id) references public.poultry_batches(business_id, id),
  foreign key (business_id, sale_id) references public.sales(business_id, id),
  foreign key (business_id, purchase_id) references public.purchases(business_id, id)
);
create index on public.stock_movements (business_id, product_id);
create index on public.stock_movements (business_id, batch_id) where batch_id is not null;

create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid references auth.users(id),
  action text not null,
  summary text not null,
  created_at timestamptz not null default now()
);

create table public.counters (
  business_id uuid not null references public.businesses(id) on delete cascade,
  kind text not null check (kind in ('sale','purchase','batch')),
  value int not null default 0,
  primary key (business_id, kind)
);

-- ---------------------------------------------------------------------------
-- Derived views (security_invoker so RLS of the caller applies)
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

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.businesses enable row level security;
alter table public.business_members enable row level security;
alter table public.units enable row level security;
alter table public.products enable row level security;
alter table public.customers enable row level security;
alter table public.suppliers enable row level security;
alter table public.poultry_batches enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.purchases enable row level security;
alter table public.purchase_lines enable row level security;
alter table public.payments enable row level security;
alter table public.expenses enable row level security;
alter table public.stock_movements enable row level security;
alter table public.audit_log enable row level security;
alter table public.counters enable row level security;

create policy "members read business" on public.businesses for select to authenticated using (public.is_member(id));
create policy "owners update business" on public.businesses for update to authenticated using (public.has_role(id, array['owner','manager']::public.member_role[])) with check (public.has_role(id, array['owner','manager']::public.member_role[]));

create policy "members read membership" on public.business_members for select to authenticated using (public.is_member(business_id));
create policy "owners manage membership" on public.business_members for all to authenticated using (public.has_role(business_id, array['owner']::public.member_role[])) with check (public.has_role(business_id, array['owner']::public.member_role[]));

-- Reference data: members read; managers/owners write.
do $$
declare t text;
begin
  foreach t in array array['units','products','customers','suppliers','poultry_batches'] loop
    execute format('create policy "members read" on public.%I for select to authenticated using (public.is_member(business_id))', t);
    execute format('create policy "members insert" on public.%I for insert to authenticated with check (public.is_member(business_id))', t);
    execute format('create policy "members update" on public.%I for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id))', t);
  end loop;
  -- Ledger / financial tables: read-only for members. Writes go through the functions below.
  foreach t in array array['sales','sale_lines','purchases','purchase_lines','payments','stock_movements','audit_log','counters'] loop
    execute format('create policy "members read" on public.%I for select to authenticated using (public.is_member(business_id))', t);
  end loop;
end $$;

-- Expenses are standalone records: members may create/edit; only owners/managers delete.
create policy "members read" on public.expenses for select to authenticated using (public.is_member(business_id));
create policy "members insert" on public.expenses for insert to authenticated with check (public.is_member(business_id) and created_by = (select auth.uid()));
create policy "members update" on public.expenses for update to authenticated using (public.is_member(business_id)) with check (public.is_member(business_id));
create policy "managers delete" on public.expenses for delete to authenticated using (public.has_role(business_id, array['owner','manager']::public.member_role[]));

-- Least privilege for the API roles.
revoke all on all tables in schema public from anon;
revoke insert, update, delete on public.sales, public.sale_lines, public.purchases, public.purchase_lines,
  public.payments, public.stock_movements, public.audit_log, public.counters from authenticated;

-- ---------------------------------------------------------------------------
-- Transactional business functions
-- ---------------------------------------------------------------------------

create function public.next_number(p_business uuid, p_kind text)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  insert into public.counters (business_id, kind, value) values (p_business, p_kind, 1)
  on conflict (business_id, kind) do update set value = public.counters.value + 1
  returning value into v;
  return v;
end $$;
revoke execute on function public.next_number(uuid, text) from public, anon, authenticated;

-- create_sale: lines = [{product_id, batch_id?, quantity, unit_price, discount}]
--              payment = {amount, method, reference} | null
-- Returns the sale id. Re-submitting the same p_sale_id returns it unchanged.
create function public.create_sale(
  p_business uuid, p_sale_id uuid, p_date date, p_customer uuid, p_walk_in_name text,
  p_lines jsonb, p_payment jsonb, p_notes text default ''
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  b public.businesses;
  l jsonb;
  prod public.products;
  n int := 0;
  v_total bigint := 0;
  v_gross bigint;
  v_qty numeric;
  v_available numeric;
  v_number text;
  v_pay bigint;
begin
  if not public.is_member(p_business) then raise exception 'not authorised' using errcode = '42501'; end if;
  if exists (select 1 from public.sales where id = p_sale_id) then
    if not exists (select 1 from public.sales where id = p_sale_id and business_id = p_business) then
      raise exception 'sale id conflict';
    end if;
    return p_sale_id;                                   -- idempotent repeat
  end if;
  select * into b from public.businesses where id = p_business;
  if p_date > current_date then raise exception 'Sale date cannot be in the future.'; end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'Add at least one item to the sale.'; end if;
  if p_customer is not null and not exists (select 1 from public.customers where id = p_customer and business_id = p_business and not archived) then
    raise exception 'Customer not found.';
  end if;

  v_number := 'S-' || lpad(public.next_number(p_business, 'sale')::text, 5, '0');
  insert into public.sales (id, business_id, number, sale_date, customer_id, walk_in_name, notes, created_by)
  values (p_sale_id, p_business, v_number, p_date, p_customer, case when p_customer is null then coalesce(p_walk_in_name, '') else '' end, coalesce(p_notes, ''), auth.uid());

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    -- Lock the product row so concurrent sales cannot oversell.
    select * into prod from public.products where id = (l->>'product_id')::uuid and business_id = p_business and not archived for update;
    if not found then raise exception 'Line %: product not found.', n; end if;
    v_qty := (l->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Line %: quantity must be greater than zero.', n; end if;
    if not (select allow_decimal from public.units where business_id = p_business and name = prod.unit) and v_qty <> trunc(v_qty) then
      raise exception 'Line %: quantity must be a whole number of %.', n, prod.unit;
    end if;
    v_gross := round(v_qty * (l->>'unit_price')::bigint);
    if coalesce((l->>'discount')::bigint, 0) > floor(v_gross * b.max_discount_percent / 100) then
      raise exception 'Line %: discount exceeds the permitted maximum.', n;
    end if;
    insert into public.sale_lines (business_id, sale_id, line_no, product_id, batch_id, description, unit, quantity, unit_price, discount)
    values (p_business, p_sale_id, n, prod.id, nullif(l->>'batch_id', '')::uuid, prod.name, prod.unit, v_qty, (l->>'unit_price')::bigint, coalesce((l->>'discount')::bigint, 0));
    v_total := v_total + v_gross - coalesce((l->>'discount')::bigint, 0);

    if prod.track_stock then
      select coalesce(sum(quantity), 0) into v_available from public.stock_movements where business_id = p_business and product_id = prod.id;
      if v_qty > v_available then raise exception 'Insufficient stock for "%": % available.', prod.name, v_available; end if;
      if l ? 'batch_id' and nullif(l->>'batch_id', '') is not null then
        perform 1 from public.poultry_batches where id = (l->>'batch_id')::uuid and business_id = p_business and product_id = prod.id and status = 'active' for update;
        if not found then raise exception 'Line %: batch is not active for this product.', n; end if;
        select coalesce(sum(quantity), 0) into v_available from public.stock_movements where business_id = p_business and batch_id = (l->>'batch_id')::uuid;
        if v_qty > v_available then raise exception 'Line %: batch only has % available.', n, v_available; end if;
      end if;
      insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, sale_id, created_by)
      values (p_business, prod.id, nullif(l->>'batch_id', '')::uuid, -v_qty, 'sale', p_date, 'Sale ' || v_number, p_sale_id, auth.uid());
    end if;
  end loop;

  v_pay := coalesce((p_payment->>'amount')::bigint, 0);
  if v_pay > v_total then raise exception 'Amount paid cannot exceed the sale total.'; end if;
  if p_customer is null and v_pay < v_total then raise exception 'Walk-in sales must be paid in full.'; end if;
  if v_pay > 0 then
    if not ((p_payment->>'method') = any (b.payment_methods)) then raise exception 'Choose a valid payment method.'; end if;
    insert into public.payments (id, business_id, direction, payment_date, amount, method, sale_id, reference, created_by)
    values (gen_random_uuid(), p_business, 'in', p_date, v_pay, p_payment->>'method', p_sale_id, coalesce(p_payment->>'reference', ''), auth.uid());
  end if;

  insert into public.audit_log (business_id, user_id, action, summary) values (p_business, auth.uid(), 'sale.create', 'Sale ' || v_number || ' recorded');
  return p_sale_id;
end $$;

create function public.record_sale_payment(
  p_business uuid, p_payment_id uuid, p_sale_id uuid, p_amount bigint, p_method text, p_date date, p_reference text default ''
) returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.sales; v_balance bigint;
begin
  if not public.is_member(p_business) then raise exception 'not authorised' using errcode = '42501'; end if;
  if exists (select 1 from public.payments where id = p_payment_id and business_id = p_business) then return p_payment_id; end if;
  select * into s from public.sales where id = p_sale_id and business_id = p_business for update;
  if not found then raise exception 'Sale not found.'; end if;
  if s.status = 'voided' then raise exception 'Cannot take payment for a voided sale.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Payment amount must be greater than zero.'; end if;
  if p_date > current_date or p_date < s.sale_date then raise exception 'Invalid payment date.'; end if;
  select total - paid into v_balance from public.sale_balances where sale_id = p_sale_id;
  if p_amount > v_balance then raise exception 'Payment exceeds the outstanding balance on this sale.'; end if;
  if not (p_method = any ((select payment_methods from public.businesses where id = p_business))) then raise exception 'Choose a valid payment method.'; end if;
  insert into public.payments (id, business_id, direction, payment_date, amount, method, sale_id, reference, created_by)
  values (p_payment_id, p_business, 'in', p_date, p_amount, p_method, p_sale_id, coalesce(p_reference, ''), auth.uid());
  insert into public.audit_log (business_id, user_id, action, summary) values (p_business, auth.uid(), 'payment.receive', 'Payment received for ' || s.number);
  return p_payment_id;
end $$;

create function public.void_sale(p_business uuid, p_sale_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales;
begin
  if not public.has_role(p_business, array['owner','manager']::public.member_role[]) then raise exception 'not authorised' using errcode = '42501'; end if;
  select * into s from public.sales where id = p_sale_id and business_id = p_business for update;
  if not found then raise exception 'Sale not found.'; end if;
  if s.status = 'voided' then raise exception 'This sale has already been voided.'; end if;
  if exists (select 1 from public.payments where sale_id = p_sale_id) then raise exception 'This sale has payments recorded.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Reason for voiding is required.'; end if;
  insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, sale_id, created_by)
  select business_id, product_id, batch_id, -quantity, 'sale_void', current_date, 'Sale ' || s.number || ' voided', sale_id, auth.uid()
  from public.stock_movements where sale_id = p_sale_id and reason = 'sale';
  update public.sales set status = 'voided', void_reason = trim(p_reason) where id = p_sale_id;
  insert into public.audit_log (business_id, user_id, action, summary) values (p_business, auth.uid(), 'sale.void', 'Sale ' || s.number || ' voided: ' || trim(p_reason));
end $$;

create function public.confirm_purchase(p_business uuid, p_purchase_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.purchases;
begin
  if not public.is_member(p_business) then raise exception 'not authorised' using errcode = '42501'; end if;
  -- Row lock + status check: a purchase is received into stock exactly once.
  select * into p from public.purchases where id = p_purchase_id and business_id = p_business for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if p.status <> 'draft' then raise exception 'Purchase % is %; it cannot be received again.', p.number, p.status; end if;
  insert into public.stock_movements (business_id, product_id, quantity, reason, movement_date, note, purchase_id, created_by)
  select business_id, product_id, quantity, 'purchase', p.purchase_date, 'Purchase ' || p.number, p.id, auth.uid()
  from public.purchase_lines where purchase_id = p.id;
  update public.purchases set status = 'confirmed', confirmed_at = now() where id = p.id;
  insert into public.audit_log (business_id, user_id, action, summary) values (p_business, auth.uid(), 'purchase.confirm', 'Purchase ' || p.number || ' received into stock');
end $$;

create function public.adjust_stock(
  p_business uuid, p_product uuid, p_batch uuid, p_quantity numeric, p_reason text, p_date date, p_note text default ''
) returns void language plpgsql security definer set search_path = '' as $$
declare prod public.products; v_available numeric;
begin
  if not public.is_member(p_business) then raise exception 'not authorised' using errcode = '42501'; end if;
  if p_reason not in ('restock','production','damage','loss','death','theft','own_use','count_correction','other') then raise exception 'Invalid reason.'; end if;
  if p_quantity is null or p_quantity = 0 then raise exception 'Quantity must not be zero.'; end if;
  if p_date > current_date then raise exception 'Date cannot be in the future.'; end if;
  if p_reason in ('other','count_correction') and coalesce(trim(p_note), '') = '' then raise exception 'Add a note explaining this adjustment.'; end if;
  select * into prod from public.products where id = p_product and business_id = p_business and not archived and track_stock for update;
  if not found then raise exception 'Product not found.'; end if;
  if p_quantity < 0 then
    select coalesce(sum(quantity), 0) into v_available from public.stock_movements where business_id = p_business and product_id = p_product;
    if -p_quantity > v_available then raise exception 'Insufficient stock: only % on hand.', v_available; end if;
    if p_batch is not null then
      select coalesce(sum(quantity), 0) into v_available from public.stock_movements where business_id = p_business and batch_id = p_batch;
      if -p_quantity > v_available then raise exception 'Batch only has % available.', v_available; end if;
    end if;
  end if;
  insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, created_by)
  values (p_business, p_product, p_batch, p_quantity, p_reason, p_date, coalesce(p_note, ''), auth.uid());
  insert into public.audit_log (business_id, user_id, action, summary) values (p_business, auth.uid(), 'stock.adjust', prod.name || ' ' || p_quantity || ' (' || p_reason || ')');
end $$;

revoke execute on function public.create_sale(uuid, uuid, date, uuid, text, jsonb, jsonb, text) from public, anon;
revoke execute on function public.record_sale_payment(uuid, uuid, uuid, bigint, text, date, text) from public, anon;
revoke execute on function public.void_sale(uuid, uuid, text) from public, anon;
revoke execute on function public.confirm_purchase(uuid, uuid) from public, anon;
revoke execute on function public.adjust_stock(uuid, uuid, uuid, numeric, text, date, text) from public, anon;
grant execute on function public.create_sale(uuid, uuid, date, uuid, text, jsonb, jsonb, text) to authenticated;
grant execute on function public.record_sale_payment(uuid, uuid, uuid, bigint, text, date, text) to authenticated;
grant execute on function public.void_sale(uuid, uuid, text) to authenticated;
grant execute on function public.confirm_purchase(uuid, uuid) to authenticated;
grant execute on function public.adjust_stock(uuid, uuid, uuid, numeric, text, date, text) to authenticated;
