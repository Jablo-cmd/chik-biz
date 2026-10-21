-- ---------------------------------------------------------------------------
-- Public API functions
-- ---------------------------------------------------------------------------

-- Onboarding: creates a business owned by the caller, with default units.
create function public.create_business(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'You are not signed in.' using errcode = '42501'; end if;
  if (select count(*) from public.business_members where user_id = auth.uid() and role = 'owner') >= 3 then
    raise exception 'You already own the maximum number of businesses for this prototype.';
  end if;
  insert into public.businesses (name, created_by) values (app_private.req_text(p_name, 'Business name', 80), auth.uid()) returning id into v_id;
  insert into public.business_members (business_id, user_id, role) values (v_id, auth.uid(), 'owner');
  insert into public.units (business_id, name, allow_decimal) values
    (v_id, 'birds', false), (v_id, 'eggs', false), (v_id, 'trays', false), (v_id, 'kg', true), (v_id, 'packs', false);
  perform app_private.audit(v_id, 'business.create', 'Business created');
  return v_id;
end $$;

create function public.update_settings(p_business uuid, p_settings jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_pc text[]; v_ec text[]; v_pm text[]; v_units jsonb; u jsonb; p record;
  v_unit_names text[] := '{}';
begin
  perform app_private.require_member(p_business, array['owner','manager']::public.member_role[]);
  select array_agg(btrim(x)) into v_pc from jsonb_array_elements_text(p_settings->'product_categories') x;
  select array_agg(btrim(x)) into v_ec from jsonb_array_elements_text(p_settings->'expense_categories') x;
  select array_agg(btrim(x)) into v_pm from jsonb_array_elements_text(p_settings->'payment_methods') x;
  v_units := p_settings->'units';
  if coalesce(array_length(v_pc, 1), 0) = 0 then raise exception 'Keep at least one product category.'; end if;
  if coalesce(array_length(v_ec, 1), 0) = 0 then raise exception 'Keep at least one expense category.'; end if;
  if coalesce(array_length(v_pm, 1), 0) = 0 then raise exception 'Keep at least one payment method.'; end if;
  if jsonb_typeof(v_units) <> 'array' or jsonb_array_length(v_units) = 0 then raise exception 'Keep at least one unit.'; end if;
  if (select count(distinct lower(x)) from unnest(v_pc) x) <> array_length(v_pc, 1) or '' = any (v_pc) then raise exception 'Duplicate or empty product category names.'; end if;
  if (select count(distinct lower(x)) from unnest(v_ec) x) <> array_length(v_ec, 1) or '' = any (v_ec) then raise exception 'Duplicate or empty expense category names.'; end if;
  if (select count(distinct lower(x)) from unnest(v_pm) x) <> array_length(v_pm, 1) or '' = any (v_pm) then raise exception 'Duplicate or empty payment method names.'; end if;
  if (select count(distinct lower(btrim(x->>'name'))) from jsonb_array_elements(v_units) x) <> jsonb_array_length(v_units) then raise exception 'Duplicate unit names.'; end if;
  if coalesce(p_settings->>'currency', '') !~ '^[A-Z]{3}$' then raise exception 'Currency must be a 3-letter ISO code, e.g. ZAR.'; end if;

  for p in select name, category from public.products where business_id = p_business and not archived loop
    if not (p.category = any (v_pc)) then raise exception 'Category "%" is used by "%". Re-categorise or archive it first.', p.category, p.name; end if;
  end loop;

  for u in select * from jsonb_array_elements(v_units) loop
    v_unit_names := v_unit_names || app_private.req_text(u->>'name', 'Unit name', 20);
    if not coalesce((u->>'allow_decimal')::boolean, false) then
      perform 1 from public.products pr where pr.business_id = p_business and pr.unit = btrim(u->>'name')
        and app_private.stock_on_hand(p_business, pr.id) <> trunc(app_private.stock_on_hand(p_business, pr.id));
      if found then raise exception 'A product has a fractional stock quantity, so "%" must allow decimals.', btrim(u->>'name'); end if;
    end if;
    insert into public.units (business_id, name, allow_decimal) values (p_business, btrim(u->>'name'), coalesce((u->>'allow_decimal')::boolean, false))
    on conflict (business_id, name) do update set allow_decimal = excluded.allow_decimal;
  end loop;
  for p in select distinct pr.unit, pr.name from public.products pr where pr.business_id = p_business and not (pr.unit = any (v_unit_names)) loop
    raise exception 'Unit "%" is used by "%". It cannot be removed.', p.unit, p.name;
  end loop;
  delete from public.units where business_id = p_business and not (name = any (v_unit_names));

  update public.businesses set
    name = app_private.req_text(p_settings->>'business_name', 'Business name', 80),
    address = app_private.opt_text(p_settings->>'address', 'Address', 500),
    phone = app_private.opt_text(p_settings->>'phone', 'Phone', 40),
    email = app_private.opt_text(p_settings->>'email', 'Email', 120),
    logo_data_url = nullif(p_settings->>'logo_data_url', ''),
    currency = p_settings->>'currency',
    locale = coalesce(nullif(p_settings->>'locale', ''), locale),
    product_categories = v_pc,
    expense_categories = v_ec,
    payment_methods = v_pm,
    default_low_stock_threshold = (p_settings->>'default_low_stock_threshold')::numeric,
    max_discount_percent = (p_settings->>'max_discount_percent')::numeric,
    batch_tracking_enabled = coalesce((p_settings->>'batch_tracking_enabled')::boolean, true)
  where id = p_business;
  perform app_private.audit(p_business, 'settings.update', 'Business settings updated');
end $$;

-- ----- Products & stock -----

create function public.create_product(
  p_business uuid, p_id uuid, p_name text, p_category text, p_unit text, p_selling_price bigint,
  p_cost_price bigint, p_low_stock_threshold numeric, p_track_stock boolean, p_opening numeric, p_date date
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.products where id = p_id) then
    if exists (select 1 from public.products where id = p_id and business_id = p_business) then return p_id; end if;
    raise exception 'Product id conflict.';
  end if;
  v_name := app_private.req_text(p_name, 'Product name', 80);
  if exists (select 1 from public.products where business_id = p_business and not archived and lower(name) = lower(v_name)) then
    raise exception 'A product called "%" already exists.', v_name;
  end if;
  if not exists (select 1 from public.businesses where id = p_business and p_category = any (product_categories)) then raise exception 'Choose a valid category.'; end if;
  if not exists (select 1 from public.units where business_id = p_business and name = p_unit) then raise exception 'Choose a valid unit.'; end if;
  if p_low_stock_threshold is not null and p_low_stock_threshold < 0 then raise exception 'Low-stock threshold must be zero or more.'; end if;
  insert into public.products (id, business_id, name, category, unit, selling_price, cost_price, low_stock_threshold, track_stock)
  values (p_id, p_business, v_name, p_category, p_unit, app_private.check_money(p_selling_price, 'Selling price'),
          case when p_cost_price is null then null else app_private.check_money(p_cost_price, 'Cost price') end,
          p_low_stock_threshold, coalesce(p_track_stock, true));
  if coalesce(p_opening, 0) <> 0 then
    if not coalesce(p_track_stock, true) then raise exception 'Opening stock only applies to products with stock tracking.'; end if;
    insert into public.stock_movements (business_id, product_id, quantity, reason, movement_date, note, created_by)
    values (p_business, p_id, app_private.check_qty(p_business, p_unit, p_opening, 'Opening stock'), 'opening',
            app_private.check_date(p_business, p_date), 'Opening stock', auth.uid());
  end if;
  perform app_private.audit(p_business, 'product.create', format('Product "%s" created', v_name));
  return p_id;
end $$;

create function public.update_product(
  p_business uuid, p_id uuid, p_name text, p_category text, p_unit text, p_selling_price bigint,
  p_cost_price bigint, p_low_stock_threshold numeric, p_track_stock boolean
) returns void language plpgsql security definer set search_path = '' as $$
declare e public.products; v_name text;
begin
  perform app_private.require_member(p_business);
  select * into e from public.products where id = p_id and business_id = p_business for update;
  if not found then raise exception 'Product not found.'; end if;
  v_name := app_private.req_text(p_name, 'Product name', 80);
  if exists (select 1 from public.products where business_id = p_business and id <> p_id and not archived and lower(name) = lower(v_name)) then
    raise exception 'A product called "%" already exists.', v_name;
  end if;
  if p_category <> e.category and not exists (select 1 from public.businesses where id = p_business and p_category = any (product_categories)) then
    raise exception 'Choose a valid category.';
  end if;
  if not exists (select 1 from public.units where business_id = p_business and name = p_unit) then raise exception 'Choose a valid unit.'; end if;
  if p_unit <> e.unit and exists (select 1 from public.stock_movements where product_id = p_id) then
    raise exception 'The unit cannot be changed once stock has been recorded — quantities are not convertible between units. Create a new product instead.';
  end if;
  if not p_track_stock and e.track_stock and app_private.stock_on_hand(p_business, p_id) <> 0 then
    raise exception 'Stock tracking cannot be switched off while stock is on hand.';
  end if;
  if not p_track_stock and exists (select 1 from public.poultry_batches where product_id = p_id) then
    raise exception 'This product is used by a poultry batch and must track stock.';
  end if;
  if p_low_stock_threshold is not null and p_low_stock_threshold < 0 then raise exception 'Low-stock threshold must be zero or more.'; end if;
  update public.products set name = v_name, category = p_category, unit = p_unit,
    selling_price = app_private.check_money(p_selling_price, 'Selling price'),
    cost_price = case when p_cost_price is null then null else app_private.check_money(p_cost_price, 'Cost price') end,
    low_stock_threshold = p_low_stock_threshold, track_stock = p_track_stock
  where id = p_id;
  perform app_private.audit(p_business, 'product.update', format('Product "%s" updated', v_name));
end $$;

create function public.set_product_archived(p_business uuid, p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.products;
begin
  perform app_private.require_member(p_business);
  select * into e from public.products where id = p_id and business_id = p_business for update;
  if not found then raise exception 'Product not found.'; end if;
  if not p_archived and exists (select 1 from public.products where business_id = p_business and id <> p_id and not archived and lower(name) = lower(e.name)) then
    raise exception 'An active product called "%" already exists.', e.name;
  end if;
  if p_archived and exists (select 1 from public.poultry_batches where product_id = p_id and status = 'active') then
    raise exception 'Close the active poultry batches for this product before archiving it.';
  end if;
  update public.products set archived = p_archived where id = p_id;
  perform app_private.audit(p_business, case when p_archived then 'product.archive' else 'product.restore' end,
    format('Product "%s" %s', e.name, case when p_archived then 'archived' else 'restored' end));
end $$;

create function public.adjust_stock(
  p_business uuid, p_product uuid, p_batch uuid, p_direction text, p_quantity numeric, p_reason text, p_date date, p_note text
) returns void language plpgsql security definer set search_path = '' as $$
declare prod public.products; b public.poultry_batches; v_qty numeric; v_note text;
begin
  perform app_private.require_member(p_business);
  select * into prod from public.products where id = p_product and business_id = p_business for update;
  if not found then raise exception 'Product not found.'; end if;
  if prod.archived then raise exception '"%" is archived.', prod.name; end if;
  if not prod.track_stock then raise exception '"%" does not track stock.', prod.name; end if;
  if p_direction = 'in' and p_reason not in ('restock','production','count_correction','other')
     or p_direction = 'out' and p_reason not in ('damage','loss','death','theft','own_use','count_correction','other')
     or p_direction not in ('in','out') then
    raise exception 'Choose a valid reason for this adjustment.';
  end if;
  v_qty := app_private.check_qty(p_business, prod.unit, p_quantity);
  v_note := app_private.opt_text(p_note, 'Note', 300);
  if p_reason in ('other','count_correction') and v_note = '' then raise exception 'Add a note explaining this adjustment.'; end if;
  if p_batch is not null then
    select * into b from public.poultry_batches where id = p_batch and business_id = p_business for update;
    if not found or b.product_id <> prod.id then raise exception 'Batch does not belong to this product.'; end if;
    if b.status <> 'active' then raise exception 'Batch % is closed.', b.reference; end if;
  end if;
  if p_reason = 'death' and p_batch is null and prod.unit <> 'birds' then raise exception 'Deaths can only be recorded for live birds.'; end if;
  if p_direction = 'out' then
    if v_qty > app_private.stock_on_hand(p_business, prod.id) then
      raise exception 'Insufficient stock: only % % of "%" on hand.', trim_scale(app_private.stock_on_hand(p_business, prod.id)), prod.unit, prod.name;
    end if;
    if p_batch is not null and v_qty > app_private.batch_qty(p_business, p_batch) then
      raise exception 'Batch % only has % %.', b.reference, trim_scale(app_private.batch_qty(p_business, p_batch)), prod.unit;
    end if;
  end if;
  insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, created_by)
  values (p_business, prod.id, p_batch, case when p_direction = 'in' then v_qty else -v_qty end, p_reason,
          app_private.check_date(p_business, p_date), v_note, auth.uid());
  perform app_private.audit(p_business, 'stock.adjust',
    format('%s%s %s %s (%s)%s', case when p_direction = 'in' then '+' else '−' end, trim_scale(v_qty), prod.unit, prod.name, p_reason,
           case when p_batch is null then '' else ' · ' || b.reference end));
end $$;

-- ----- Poultry batches -----

create function public.create_batch(
  p_business uuid, p_id uuid, p_name text, p_poultry_type text, p_product uuid, p_start_date date,
  p_initial_quantity numeric, p_starting_cost bigint, p_notes text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare prod public.products; v_qty numeric; v_ref text; v_date date;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.poultry_batches where id = p_id) then
    if exists (select 1 from public.poultry_batches where id = p_id and business_id = p_business) then return p_id; end if;
    raise exception 'Batch id conflict.';
  end if;
  if not (select batch_tracking_enabled from public.businesses where id = p_business) then raise exception 'Batch tracking is switched off in Settings.'; end if;
  select * into prod from public.products where id = p_product and business_id = p_business for update;
  if not found or prod.archived then raise exception 'Product not found.'; end if;
  if not prod.track_stock then raise exception 'The batch product must track stock.'; end if;
  if (select allow_decimal from public.units where business_id = p_business and name = prod.unit) then
    raise exception 'Batches must use a product counted in whole units (e.g. birds).';
  end if;
  v_qty := app_private.check_qty(p_business, prod.unit, p_initial_quantity, 'Initial quantity');
  v_date := app_private.check_date(p_business, p_start_date, 'Start date');
  v_ref := 'B-' || lpad(app_private.next_number(p_business, 'batch')::text, 3, '0');
  insert into public.poultry_batches (id, business_id, reference, name, poultry_type, product_id, start_date, initial_quantity, starting_cost, notes)
  values (p_id, p_business, v_ref, app_private.req_text(p_name, 'Batch name', 80), app_private.req_text(p_poultry_type, 'Poultry type', 60),
          prod.id, v_date, v_qty, app_private.check_money(p_starting_cost, 'Starting cost'), app_private.opt_text(p_notes, 'Notes', 500));
  insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, created_by)
  values (p_business, prod.id, p_id, v_qty, 'batch_intake', v_date, 'Batch ' || v_ref || ' intake', auth.uid());
  perform app_private.audit(p_business, 'batch.create', format('Batch %s "%s" started with %s %s', v_ref, btrim(p_name), trim_scale(v_qty), prod.unit));
  return p_id;
end $$;

create function public.update_batch(p_business uuid, p_id uuid, p_name text, p_poultry_type text, p_starting_cost bigint, p_notes text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ref text;
begin
  perform app_private.require_member(p_business);
  update public.poultry_batches set name = app_private.req_text(p_name, 'Batch name', 80),
    poultry_type = app_private.req_text(p_poultry_type, 'Poultry type', 60),
    starting_cost = app_private.check_money(p_starting_cost, 'Starting cost'),
    notes = app_private.opt_text(p_notes, 'Notes', 500)
  where id = p_id and business_id = p_business returning reference into v_ref;
  if v_ref is null then raise exception 'Batch not found.'; end if;
  perform app_private.audit(p_business, 'batch.update', 'Batch ' || v_ref || ' updated');
end $$;

create function public.set_batch_status(p_business uuid, p_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare b public.poultry_batches;
begin
  perform app_private.require_member(p_business);
  if p_status not in ('active','closed') then raise exception 'Invalid status.'; end if;
  select * into b from public.poultry_batches where id = p_id and business_id = p_business for update;
  if not found then raise exception 'Batch not found.'; end if;
  if p_status = 'active' and (select archived from public.products where id = b.product_id) then
    raise exception 'Restore the batch product before reopening this batch.';
  end if;
  update public.poultry_batches set status = p_status where id = p_id;
  perform app_private.audit(p_business, case when p_status = 'closed' then 'batch.close' else 'batch.reopen' end,
    'Batch ' || b.reference || case when p_status = 'closed' then ' closed' else ' reopened' end);
end $$;

-- ----- Customers & suppliers -----

create function public.save_customer(
  p_business uuid, p_id uuid, p_name text, p_business_name text, p_phone text, p_email text, p_address text, p_notes text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_existing boolean;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.customers where id = p_id and business_id <> p_business) then raise exception 'Customer id conflict.'; end if;
  v_existing := exists (select 1 from public.customers where id = p_id);
  perform app_private.check_contact(btrim(p_phone), btrim(p_email));
  insert into public.customers (id, business_id, name, business_name, phone, email, address, notes)
  values (p_id, p_business, app_private.req_text(p_name, 'Customer name', 80), app_private.opt_text(p_business_name, 'Business name', 80),
          app_private.opt_text(p_phone, 'Phone', 40), app_private.opt_text(p_email, 'Email', 120),
          app_private.opt_text(p_address, 'Address', 500), app_private.opt_text(p_notes, 'Notes', 500))
  on conflict (id) do update set name = excluded.name, business_name = excluded.business_name, phone = excluded.phone,
    email = excluded.email, address = excluded.address, notes = excluded.notes;
  perform app_private.audit(p_business, case when v_existing then 'customer.update' else 'customer.create' end,
    format('Customer "%s" %s', btrim(p_name), case when v_existing then 'updated' else 'added' end));
  return p_id;
end $$;

create function public.set_customer_archived(p_business uuid, p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform app_private.require_member(p_business);
  update public.customers set archived = p_archived where id = p_id and business_id = p_business returning name into v_name;
  if v_name is null then raise exception 'Customer not found.'; end if;
  perform app_private.audit(p_business, case when p_archived then 'customer.archive' else 'customer.restore' end,
    format('Customer "%s" %s', v_name, case when p_archived then 'archived' else 'restored' end));
end $$;

create function public.save_supplier(
  p_business uuid, p_id uuid, p_name text, p_contact_person text, p_phone text, p_email text, p_notes text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_existing boolean;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.suppliers where id = p_id and business_id <> p_business) then raise exception 'Supplier id conflict.'; end if;
  v_existing := exists (select 1 from public.suppliers where id = p_id);
  perform app_private.check_contact(btrim(p_phone), btrim(p_email));
  insert into public.suppliers (id, business_id, name, contact_person, phone, email, notes)
  values (p_id, p_business, app_private.req_text(p_name, 'Supplier name', 80), app_private.opt_text(p_contact_person, 'Contact person', 80),
          app_private.opt_text(p_phone, 'Phone', 40), app_private.opt_text(p_email, 'Email', 120), app_private.opt_text(p_notes, 'Notes', 500))
  on conflict (id) do update set name = excluded.name, contact_person = excluded.contact_person, phone = excluded.phone,
    email = excluded.email, notes = excluded.notes;
  perform app_private.audit(p_business, case when v_existing then 'supplier.update' else 'supplier.create' end,
    format('Supplier "%s" %s', btrim(p_name), case when v_existing then 'updated' else 'added' end));
  return p_id;
end $$;

create function public.set_supplier_archived(p_business uuid, p_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_name text;
begin
  perform app_private.require_member(p_business);
  update public.suppliers set archived = p_archived where id = p_id and business_id = p_business returning name into v_name;
  if v_name is null then raise exception 'Supplier not found.'; end if;
  perform app_private.audit(p_business, case when p_archived then 'supplier.archive' else 'supplier.restore' end,
    format('Supplier "%s" %s', v_name, case when p_archived then 'archived' else 'restored' end));
end $$;
