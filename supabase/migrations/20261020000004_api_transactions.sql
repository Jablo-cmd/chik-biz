-- ----- Sales & payments -----

-- p_lines = [{product_id, batch_id?, quantity, unit_price, discount}]
-- p_payment = {amount, method, reference} | null
-- Re-submitting the same p_sale_id returns it unchanged (no second stock deduction).
create function public.create_sale(
  p_business uuid, p_sale_id uuid, p_date date, p_customer uuid, p_walk_in_name text,
  p_lines jsonb, p_payment jsonb, p_notes text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  b public.businesses; l jsonb; prod public.products; bt public.poultry_batches;
  n int := 0; v_total bigint := 0; v_gross bigint; v_qty numeric; v_disc bigint; v_price bigint;
  v_number text; v_pay bigint; v_batch uuid; v_date date;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.sales where id = p_sale_id) then
    if exists (select 1 from public.sales where id = p_sale_id and business_id = p_business) then return p_sale_id; end if;
    raise exception 'Sale id conflict.';
  end if;
  select * into b from public.businesses where id = p_business;
  v_date := app_private.check_date(p_business, p_date, 'Sale date');
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item to the sale.'; end if;
  if jsonb_array_length(p_lines) > 100 then raise exception 'A sale can have at most 100 lines.'; end if;
  if p_customer is not null and not exists (select 1 from public.customers where id = p_customer and business_id = p_business and not archived) then
    raise exception 'Customer not found or archived.';
  end if;

  v_number := 'S-' || lpad(app_private.next_number(p_business, 'sale')::text, 5, '0');
  insert into public.sales (id, business_id, number, sale_date, customer_id, walk_in_name, notes, created_by)
  values (p_sale_id, p_business, v_number, v_date, p_customer,
          case when p_customer is null then app_private.opt_text(p_walk_in_name, 'Walk-in name', 80) else '' end,
          app_private.opt_text(p_notes, 'Notes', 500), auth.uid());

  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    -- Lock the product row so concurrent sales cannot oversell.
    select * into prod from public.products where id = (l->>'product_id')::uuid and business_id = p_business for update;
    if not found then raise exception 'Line %: product not found.', n; end if;
    if prod.archived then raise exception 'Line %: "%" is archived.', n, prod.name; end if;
    v_qty := app_private.check_qty(p_business, prod.unit, (l->>'quantity')::numeric, format('Line %s quantity', n));
    v_price := app_private.check_money((l->>'unit_price')::bigint, format('Line %s unit price', n));
    v_disc := app_private.check_money(coalesce((l->>'discount')::bigint, 0), format('Line %s discount', n));
    v_gross := round(v_qty * v_price);
    if v_disc > v_gross then raise exception 'Line %: discount cannot exceed the line value.', n; end if;
    if v_disc > floor(v_gross * b.max_discount_percent / 100) then
      raise exception '%', format('Line %s: discount exceeds the permitted maximum of %s%%.', n, trim_scale(b.max_discount_percent));
    end if;
    v_batch := nullif(l->>'batch_id', '')::uuid;
    if v_batch is not null then
      select * into bt from public.poultry_batches where id = v_batch and business_id = p_business for update;
      if not found or bt.product_id <> prod.id then raise exception 'Line %: batch does not match the product.', n; end if;
      if bt.status <> 'active' then raise exception 'Line %: batch % is closed.', n, bt.reference; end if;
    end if;
    insert into public.sale_lines (business_id, sale_id, line_no, product_id, batch_id, description, unit, quantity, unit_price, discount)
    values (p_business, p_sale_id, n, prod.id, v_batch, prod.name, prod.unit, v_qty, v_price, v_disc);
    v_total := v_total + v_gross - v_disc;

    if prod.track_stock then
      -- Earlier lines of this sale have already been written to the ledger, so
      -- repeated products are checked against the remaining quantity.
      if v_qty > app_private.stock_on_hand(p_business, prod.id) then
        raise exception 'Insufficient stock for "%": % % available.', prod.name, trim_scale(app_private.stock_on_hand(p_business, prod.id)), prod.unit;
      end if;
      if v_batch is not null and v_qty > app_private.batch_qty(p_business, v_batch) then
        raise exception 'Batch % has only % available.', bt.reference, trim_scale(app_private.batch_qty(p_business, v_batch));
      end if;
      insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, sale_id, created_by)
      values (p_business, prod.id, v_batch, -v_qty, 'sale', v_date, 'Sale ' || v_number, p_sale_id, auth.uid());
    end if;
  end loop;

  v_pay := coalesce((p_payment->>'amount')::bigint, 0);
  perform app_private.check_money(v_pay, 'Amount paid');
  if v_pay > v_total then raise exception 'Amount paid cannot exceed the sale total. Record change given separately.'; end if;
  if p_customer is null and v_pay < v_total then raise exception 'Walk-in sales must be paid in full. Select a customer to sell on credit.'; end if;
  if v_pay > 0 then
    insert into public.payments (id, business_id, direction, payment_date, amount, method, sale_id, reference, created_by)
    values (gen_random_uuid(), p_business, 'in', v_date, v_pay, app_private.check_method(p_business, p_payment->>'method'), p_sale_id,
            app_private.opt_text(p_payment->>'reference', 'Payment reference', 80), auth.uid());
  end if;

  perform app_private.audit(p_business, 'sale.create', format('Sale %s recorded (%s line%s)', v_number, n, case when n = 1 then '' else 's' end));
  return p_sale_id;
end $$;

create function public.record_sale_payment(
  p_business uuid, p_payment_id uuid, p_sale_id uuid, p_amount bigint, p_method text, p_date date, p_reference text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.sales; v_balance bigint; v_date date;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.payments where id = p_payment_id) then
    if exists (select 1 from public.payments where id = p_payment_id and business_id = p_business) then return p_payment_id; end if;
    raise exception 'Payment id conflict.';
  end if;
  select * into s from public.sales where id = p_sale_id and business_id = p_business for update;
  if not found then raise exception 'Sale not found.'; end if;
  if s.status = 'voided' then raise exception 'Cannot take payment for a voided sale.'; end if;
  perform app_private.check_money(p_amount, 'Payment amount', false);
  select total - paid into v_balance from public.sale_balances where sale_id = p_sale_id;
  if v_balance <= 0 then raise exception 'This sale is already paid in full.'; end if;
  if p_amount > v_balance then raise exception 'Payment exceeds the outstanding balance on this sale.'; end if;
  v_date := app_private.check_date(p_business, p_date, 'Payment date');
  if v_date < s.sale_date then raise exception 'Payment date cannot be before the sale date.'; end if;
  insert into public.payments (id, business_id, direction, payment_date, amount, method, sale_id, reference, created_by)
  values (p_payment_id, p_business, 'in', v_date, p_amount, app_private.check_method(p_business, p_method), p_sale_id,
          app_private.opt_text(p_reference, 'Reference', 80), auth.uid());
  perform app_private.audit(p_business, 'payment.receive', 'Payment received for ' || s.number);
  return p_payment_id;
end $$;

create function public.void_sale(p_business uuid, p_sale_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales; v_reason text;
begin
  perform app_private.require_member(p_business, array['owner','manager']::public.member_role[]);
  select * into s from public.sales where id = p_sale_id and business_id = p_business for update;
  if not found then raise exception 'Sale not found.'; end if;
  if s.status = 'voided' then raise exception 'This sale has already been voided.'; end if;
  if exists (select 1 from public.payments where sale_id = p_sale_id) then
    raise exception 'This sale has payments recorded. Payments must be refunded outside the system before voiding (not supported in this prototype).';
  end if;
  v_reason := app_private.req_text(p_reason, 'Reason for voiding', 200);
  insert into public.stock_movements (business_id, product_id, batch_id, quantity, reason, movement_date, note, sale_id, created_by)
  select business_id, product_id, batch_id, -quantity, 'sale_void', app_private.biz_today(p_business), 'Sale ' || s.number || ' voided', sale_id, auth.uid()
  from public.stock_movements where sale_id = p_sale_id and reason = 'sale';
  update public.sales set status = 'voided', void_reason = v_reason where id = p_sale_id;
  perform app_private.audit(p_business, 'sale.void', 'Sale ' || s.number || ' voided: ' || v_reason);
end $$;

-- ----- Expenses -----

create function public.save_expense(
  p_business uuid, p_id uuid, p_date date, p_category text, p_description text, p_amount bigint,
  p_method text, p_supplier uuid, p_reference text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare e public.expenses; v_desc text;
begin
  perform app_private.require_member(p_business);
  select * into e from public.expenses where id = p_id;
  if found and e.business_id <> p_business then raise exception 'Expense id conflict.'; end if;
  if (e.id is null or p_category <> e.category)
     and not exists (select 1 from public.businesses where id = p_business and p_category = any (expense_categories)) then
    raise exception 'Choose a valid expense category.';
  end if;
  if p_supplier is not null and not exists (select 1 from public.suppliers where id = p_supplier and business_id = p_business) then
    raise exception 'Supplier not found.';
  end if;
  v_desc := app_private.req_text(p_description, 'Description', 160);
  insert into public.expenses (id, business_id, expense_date, category, description, amount, method, supplier_id, reference, created_by)
  values (p_id, p_business, app_private.check_date(p_business, p_date), p_category, v_desc,
          app_private.check_money(p_amount, 'Amount', false), app_private.check_method(p_business, p_method), p_supplier,
          app_private.opt_text(p_reference, 'Reference', 80), auth.uid())
  on conflict (id) do update set expense_date = excluded.expense_date, category = excluded.category, description = excluded.description,
    amount = excluded.amount, method = excluded.method, supplier_id = excluded.supplier_id, reference = excluded.reference;
  perform app_private.audit(p_business, case when e.id is null then 'expense.create' else 'expense.update' end,
    format('Expense "%s" %s', v_desc, case when e.id is null then 'recorded' else 'updated' end));
  return p_id;
end $$;

create function public.delete_expense(p_business uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.expenses;
begin
  perform app_private.require_member(p_business, array['owner','manager']::public.member_role[]);
  delete from public.expenses where id = p_id and business_id = p_business returning * into e;
  if e.id is null then raise exception 'Expense not found.'; end if;
  perform app_private.audit(p_business, 'expense.delete',
    format('Expense "%s" (%s, %s) deleted', e.description, e.expense_date, to_char(e.amount / 100.0, 'FM999999990.00')));
end $$;

-- ----- Purchases -----

create function public.create_purchase(
  p_business uuid, p_id uuid, p_supplier uuid, p_date date, p_lines jsonb, p_reference text, p_notes text, p_receive boolean
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_number text;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.purchases where id = p_id) then
    if exists (select 1 from public.purchases where id = p_id and business_id = p_business) then return p_id; end if;
    raise exception 'Purchase id conflict.';
  end if;
  if not exists (select 1 from public.suppliers where id = p_supplier and business_id = p_business and not archived) then
    raise exception 'Choose an active supplier.';
  end if;
  v_number := 'P-' || lpad(app_private.next_number(p_business, 'purchase')::text, 5, '0');
  insert into public.purchases (id, business_id, number, supplier_id, purchase_date, reference, notes)
  values (p_id, p_business, v_number, p_supplier, app_private.check_date(p_business, p_date, 'Purchase date'),
          app_private.opt_text(p_reference, 'Reference', 80), app_private.opt_text(p_notes, 'Notes', 500));
  perform app_private.write_purchase_lines(p_business, p_id, p_lines);
  perform app_private.audit(p_business, 'purchase.create', 'Purchase ' || v_number || ' drafted');
  if coalesce(p_receive, false) then perform app_private.receive_purchase(p_business, p_id); end if;
  return p_id;
end $$;

create function public.update_purchase(
  p_business uuid, p_id uuid, p_supplier uuid, p_date date, p_lines jsonb, p_reference text, p_notes text
) returns void language plpgsql security definer set search_path = '' as $$
declare p public.purchases;
begin
  perform app_private.require_member(p_business);
  select * into p from public.purchases where id = p_id and business_id = p_business for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if p.status <> 'draft' then raise exception 'Only draft purchases can be edited.'; end if;
  if not exists (select 1 from public.suppliers where id = p_supplier and business_id = p_business) then raise exception 'Choose a supplier.'; end if;
  update public.purchases set supplier_id = p_supplier, purchase_date = app_private.check_date(p_business, p_date, 'Purchase date'),
    reference = app_private.opt_text(p_reference, 'Reference', 80), notes = app_private.opt_text(p_notes, 'Notes', 500)
  where id = p_id;
  delete from public.purchase_lines where purchase_id = p_id;
  perform app_private.write_purchase_lines(p_business, p_id, p_lines);
  perform app_private.audit(p_business, 'purchase.update', 'Purchase ' || p.number || ' updated');
end $$;

create function public.confirm_purchase(p_business uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform app_private.require_member(p_business);
  perform app_private.receive_purchase(p_business, p_id);
end $$;

create function public.cancel_purchase(p_business uuid, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.purchases;
begin
  perform app_private.require_member(p_business);
  select * into p from public.purchases where id = p_id and business_id = p_business for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if p.status <> 'draft' then raise exception 'Only draft purchases can be cancelled.'; end if;
  update public.purchases set status = 'cancelled' where id = p_id;
  perform app_private.audit(p_business, 'purchase.cancel', 'Purchase ' || p.number || ' cancelled');
end $$;

create function public.record_purchase_payment(
  p_business uuid, p_payment_id uuid, p_purchase_id uuid, p_amount bigint, p_method text, p_date date, p_reference text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare p public.purchases; v_balance bigint;
begin
  perform app_private.require_member(p_business);
  if exists (select 1 from public.payments where id = p_payment_id) then
    if exists (select 1 from public.payments where id = p_payment_id and business_id = p_business) then return p_payment_id; end if;
    raise exception 'Payment id conflict.';
  end if;
  select * into p from public.purchases where id = p_purchase_id and business_id = p_business for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if p.status <> 'confirmed' then raise exception 'Only received purchases can be paid.'; end if;
  perform app_private.check_money(p_amount, 'Payment amount', false);
  select coalesce((select sum(round(quantity * unit_cost)) from public.purchase_lines where purchase_id = p.id), 0)
       - coalesce((select sum(amount) from public.payments where purchase_id = p.id), 0)
    into v_balance;
  if v_balance <= 0 then raise exception 'This purchase is already paid in full.'; end if;
  if p_amount > v_balance then raise exception 'Payment exceeds the outstanding balance on this purchase.'; end if;
  insert into public.payments (id, business_id, direction, payment_date, amount, method, purchase_id, reference, created_by)
  values (p_payment_id, p_business, 'out', app_private.check_date(p_business, p_date, 'Payment date'), p_amount,
          app_private.check_method(p_business, p_method), p.id, app_private.opt_text(p_reference, 'Reference', 80), auth.uid());
  perform app_private.audit(p_business, 'payment.pay', 'Supplier payment for ' || p.number);
  return p_payment_id;
end $$;

-- ---------------------------------------------------------------------------
-- Function privileges: only signed-in users may call the API functions.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on all functions in schema app_private from public, anon, authenticated;
