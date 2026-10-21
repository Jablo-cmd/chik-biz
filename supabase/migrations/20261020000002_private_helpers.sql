-- ---------------------------------------------------------------------------
-- Private helpers (not exposed through the API)
-- ---------------------------------------------------------------------------

create function app_private.require_member(p_business uuid, p_roles public.member_role[] default null)
returns void language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'You are not signed in.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.business_members m
    where m.business_id = p_business and m.user_id = auth.uid() and (p_roles is null or m.role = any (p_roles))
  ) then
    raise exception 'You do not have permission to do this for this business.' using errcode = '42501';
  end if;
end $$;

create function app_private.biz_today(p_business uuid)
returns date language sql stable set search_path = '' as $$
  select (now() at time zone b.timezone)::date from public.businesses b where b.id = p_business;
$$;

create function app_private.check_date(p_business uuid, p_date date, p_label text default 'Date')
returns date language plpgsql stable set search_path = '' as $$
begin
  if p_date is null then raise exception '% is not a valid date.', p_label; end if;
  if p_date > app_private.biz_today(p_business) then raise exception '% cannot be in the future.', p_label; end if;
  return p_date;
end $$;

create function app_private.req_text(p_value text, p_label text, p_max int)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_value, ''));
begin
  if v = '' then raise exception '% is required.', p_label; end if;
  if length(v) > p_max then raise exception '% must be % characters or fewer.', p_label, p_max; end if;
  return v;
end $$;

create function app_private.opt_text(p_value text, p_label text, p_max int)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(coalesce(p_value, ''));
begin
  if length(v) > p_max then raise exception '% must be % characters or fewer.', p_label, p_max; end if;
  return v;
end $$;

create function app_private.check_contact(p_phone text, p_email text)
returns void language plpgsql immutable set search_path = '' as $$
begin
  if coalesce(p_email, '') <> '' and p_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then raise exception 'Email address is not valid.'; end if;
  if coalesce(p_phone, '') <> '' and p_phone !~ '^[+()\d\s-]{6,}$' then raise exception 'Phone number is not valid.'; end if;
end $$;

create function app_private.check_money(p_value bigint, p_label text, p_allow_zero boolean default true)
returns bigint language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or p_value < 0 then raise exception '% must be a valid, non-negative amount.', p_label; end if;
  if not p_allow_zero and p_value = 0 then raise exception '% must be greater than zero.', p_label; end if;
  if p_value > 10000000000 then raise exception '% is unrealistically large.', p_label; end if;
  return p_value;
end $$;

create function app_private.check_qty(p_business uuid, p_unit text, p_qty numeric, p_label text default 'Quantity')
returns numeric language plpgsql stable set search_path = '' as $$
declare v_dec boolean;
begin
  if p_qty is null or p_qty <= 0 then raise exception '% must be greater than zero.', p_label; end if;
  select allow_decimal into v_dec from public.units where business_id = p_business and name = p_unit;
  if not coalesce(v_dec, false) and p_qty <> trunc(p_qty) then
    raise exception '% must be a whole number of %.', p_label, p_unit;
  end if;
  return round(p_qty, 3);
end $$;

create function app_private.check_method(p_business uuid, p_method text)
returns text language plpgsql stable set search_path = '' as $$
begin
  if not exists (select 1 from public.businesses where id = p_business and p_method = any (payment_methods)) then
    raise exception 'Choose a valid payment method.';
  end if;
  return p_method;
end $$;

create function app_private.stock_on_hand(p_business uuid, p_product uuid)
returns numeric language sql stable set search_path = '' as $$
  select coalesce(sum(quantity), 0) from public.stock_movements where business_id = p_business and product_id = p_product;
$$;

create function app_private.batch_qty(p_business uuid, p_batch uuid)
returns numeric language sql stable set search_path = '' as $$
  select coalesce(sum(quantity), 0) from public.stock_movements where business_id = p_business and batch_id = p_batch;
$$;

create function app_private.next_number(p_business uuid, p_kind text)
returns int language plpgsql set search_path = '' as $$
declare v int;
begin
  insert into public.counters (business_id, kind, value) values (p_business, p_kind, 1)
  on conflict (business_id, kind) do update set value = public.counters.value + 1
  returning value into v;
  return v;
end $$;

create function app_private.audit(p_business uuid, p_action text, p_summary text)
returns void language sql set search_path = '' as $$
  insert into public.audit_log (business_id, user_id, action, summary) values (p_business, auth.uid(), p_action, left(p_summary, 500));
$$;

create function app_private.receive_purchase(p_business uuid, p_purchase uuid)
returns void language plpgsql set search_path = '' as $$
declare p public.purchases; l record;
begin
  select * into p from public.purchases where id = p_purchase and business_id = p_business for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if p.status = 'confirmed' then raise exception 'Purchase % has already been received into stock.', p.number; end if;
  if p.status = 'cancelled' then raise exception 'Purchase % was cancelled.', p.number; end if;
  for l in select pl.*, pr.track_stock, pr.unit as product_unit, pr.archived, pr.name
           from public.purchase_lines pl join public.products pr on pr.id = pl.product_id
           where pl.purchase_id = p.id loop
    if l.archived then raise exception '"%" is archived.', l.name; end if;
    if not l.track_stock then raise exception '"%" no longer tracks stock.', l.name; end if;
    if l.product_unit <> l.unit then raise exception '"%" unit changed since this purchase was drafted.', l.name; end if;
  end loop;
  insert into public.stock_movements (business_id, product_id, quantity, reason, movement_date, note, purchase_id, created_by)
  select business_id, product_id, quantity, 'purchase', p.purchase_date, 'Purchase ' || p.number, p.id, auth.uid()
  from public.purchase_lines where purchase_id = p.id order by line_no;
  update public.purchases set status = 'confirmed', confirmed_at = now() where id = p.id;
  perform app_private.audit(p_business, 'purchase.confirm', 'Purchase ' || p.number || ' received into stock');
end $$;

create function app_private.write_purchase_lines(p_business uuid, p_purchase uuid, p_lines jsonb)
returns void language plpgsql set search_path = '' as $$
declare l jsonb; n int := 0; prod public.products;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one item to the purchase.'; end if;
  for l in select * from jsonb_array_elements(p_lines) loop
    n := n + 1;
    select * into prod from public.products where id = (l->>'product_id')::uuid and business_id = p_business;
    if not found then raise exception 'Line %: product not found.', n; end if;
    if prod.archived then raise exception 'Line %: "%" is archived.', n, prod.name; end if;
    if not prod.track_stock then raise exception 'Line %: "%" does not track stock.', n, prod.name; end if;
    insert into public.purchase_lines (business_id, purchase_id, line_no, product_id, description, unit, quantity, unit_cost)
    values (p_business, p_purchase, n, prod.id, prod.name, prod.unit,
            app_private.check_qty(p_business, prod.unit, (l->>'quantity')::numeric, format('Line %s quantity', n)),
            app_private.check_money((l->>'unit_cost')::bigint, format('Line %s unit cost', n)));
  end loop;
end $$;
