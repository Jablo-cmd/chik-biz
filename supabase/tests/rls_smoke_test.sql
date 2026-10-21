-- Smoke test for the Chik-Biz schema. Run after local_auth_stub.sql + the migration
-- on a DISPOSABLE database. Prints PASS/FAIL notices; stops on the first unexpected error.
\set ON_ERROR_STOP on
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
set role authenticated;

create temp table t_ids (k text primary key, v uuid);
grant all on t_ids to authenticated;

create or replace function pg_temp.expect_error(p_sql text, p_like text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL (no error): %', p_sql;
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlerrm not ilike p_like then raise exception 'FAIL unexpected error "%" for %', sqlerrm, p_sql; end if;
  raise notice 'PASS rejected: %', sqlerrm;
end $$;

-- ===== User A: onboarding and core workflow =====
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
insert into t_ids values ('bizA', public.create_business('Biz A'));
insert into t_ids values ('egg', '20000000-0000-0000-0000-000000000001'), ('bird', '20000000-0000-0000-0000-000000000002'),
  ('cust', '30000000-0000-0000-0000-000000000001'), ('sup', '40000000-0000-0000-0000-000000000001'),
  ('batch', '50000000-0000-0000-0000-000000000001'), ('sale1', '60000000-0000-0000-0000-000000000001'),
  ('pur', '70000000-0000-0000-0000-000000000001');

select public.create_product((select v from t_ids where k='bizA'), (select v from t_ids where k='egg'), 'Eggs tray', 'Eggs', 'trays', 7500, 5000, 5, true, 10, current_date);
select public.create_product((select v from t_ids where k='bizA'), (select v from t_ids where k='bird'), 'Live broiler', 'Live birds', 'birds', 9000, null, null, true, 0, current_date);
select public.save_customer((select v from t_ids where k='bizA'), (select v from t_ids where k='cust'), 'Cust', '', '', '', '', '');
select public.save_supplier((select v from t_ids where k='bizA'), (select v from t_ids where k='sup'), 'Supp', '', '', '', '');

-- Sale + idempotent repeat
select public.create_sale((select v from t_ids where k='bizA'), (select v from t_ids where k='sale1'), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 3, 'unit_price', 7500, 'discount', 0)),
  '{"amount":22500,"method":"Cash"}', '');
select public.create_sale((select v from t_ids where k='bizA'), (select v from t_ids where k='sale1'), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 3, 'unit_price', 7500, 'discount', 0)),
  '{"amount":22500,"method":"Cash"}', '');
do $$ begin
  if (select on_hand from public.product_stock where product_id = '20000000-0000-0000-0000-000000000001') <> 7 then raise exception 'FAIL stock after repeat'; end if;
  if (select count(*) from public.payments) <> 1 then raise exception 'FAIL payments after repeat'; end if;
  raise notice 'PASS repeated sale submission ignored (stock 7, 1 payment)';
end $$;

select pg_temp.expect_error($q$select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 4, 'unit_price', 7500, 'discount', 0),
                    jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 4, 'unit_price', 7500, 'discount', 0)),
  '{"amount":60000,"method":"Cash"}', '')$q$, 'Insufficient stock%');
select pg_temp.expect_error($q$select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 1, 'unit_price', 7500, 'discount', 0)),
  '{"amount":1000,"method":"Cash"}', '')$q$, 'Walk-in sales must be paid in full%');
select pg_temp.expect_error($q$select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 1, 'unit_price', 7500, 'discount', 2000)),
  '{"amount":5500,"method":"Cash"}', '')$q$, '%permitted maximum of 15%%');
select pg_temp.expect_error($q$select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date + 5, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 1, 'unit_price', 7500, 'discount', 0)),
  '{"amount":7500,"method":"Cash"}', '')$q$, '%future%');
select pg_temp.expect_error($q$select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 1.5, 'unit_price', 7500, 'discount', 0)),
  '{"amount":11250,"method":"Cash"}', '')$q$, '%whole number%');

-- Credit sale, partial then full payment, overpayment rejected
select public.create_sale((select v from t_ids where k='bizA'), '60000000-0000-0000-0000-000000000002', current_date, (select v from t_ids where k='cust'), '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 2, 'unit_price', 7500, 'discount', 0)),
  '{"amount":5000,"method":"Cash"}', '');
select pg_temp.expect_error($q$select public.record_sale_payment((select v from t_ids where k='bizA'), gen_random_uuid(), '60000000-0000-0000-0000-000000000002', 10001, 'EFT', current_date, '')$q$, '%exceeds the outstanding balance%');
select public.record_sale_payment((select v from t_ids where k='bizA'), '80000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', 10000, 'EFT', current_date, '');
select public.record_sale_payment((select v from t_ids where k='bizA'), '80000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002', 10000, 'EFT', current_date, '');
do $$ begin
  if (select total - paid from public.sale_balances where sale_id = '60000000-0000-0000-0000-000000000002') <> 0 then raise exception 'FAIL balance'; end if;
  raise notice 'PASS partial + later payment settles balance; repeated payment ignored';
end $$;

-- Stock adjustments
select pg_temp.expect_error($q$select public.adjust_stock((select v from t_ids where k='bizA'), (select v from t_ids where k='egg'), null, 'out', 99, 'damage', current_date, '')$q$, 'Insufficient stock%');
select pg_temp.expect_error($q$select public.adjust_stock((select v from t_ids where k='bizA'), (select v from t_ids where k='egg'), null, 'out', 1, 'other', current_date, '')$q$, '%note%');
select public.adjust_stock((select v from t_ids where k='bizA'), (select v from t_ids where k='egg'), null, 'out', 1, 'damage', current_date, 'cracked');
select pg_temp.expect_error($q$select public.update_product((select v from t_ids where k='bizA'), (select v from t_ids where k='egg'), 'Eggs tray', 'Eggs', 'eggs', 7500, null, null, true)$q$, '%unit cannot be changed%');

-- Batches
select public.create_batch((select v from t_ids where k='bizA'), (select v from t_ids where k='batch'), 'Cycle 1', 'Broiler', (select v from t_ids where k='bird'), current_date, 100, 90000, '');
select public.adjust_stock((select v from t_ids where k='bizA'), (select v from t_ids where k='bird'), (select v from t_ids where k='batch'), 'out', 4, 'death', current_date, '');
select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='bird'), 'batch_id', (select v from t_ids where k='batch'), 'quantity', 10, 'unit_price', 9000, 'discount', 0)),
  '{"amount":90000,"method":"Cash"}', '');
do $$ begin
  if (select sum(quantity) from public.stock_movements where batch_id = '50000000-0000-0000-0000-000000000001') <> 86 then raise exception 'FAIL batch qty'; end if;
  raise notice 'PASS batch intake/death/sale = 86 birds';
end $$;

-- Purchases: received once
select public.create_purchase((select v from t_ids where k='bizA'), (select v from t_ids where k='pur'), (select v from t_ids where k='sup'), current_date,
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 5, 'unit_cost', 5000)), '', '', false);
select public.confirm_purchase((select v from t_ids where k='bizA'), (select v from t_ids where k='pur'));
select pg_temp.expect_error($q$select public.confirm_purchase((select v from t_ids where k='bizA'), (select v from t_ids where k='pur'))$q$, '%already been received%');
select public.record_purchase_payment((select v from t_ids where k='bizA'), gen_random_uuid(), (select v from t_ids where k='pur'), 10000, 'EFT', current_date, '');
do $$ begin
  if (select on_hand from public.product_stock where product_id = '20000000-0000-0000-0000-000000000001') <> 9 then raise exception 'FAIL stock after purchase: %', (select on_hand from public.product_stock where product_id = '20000000-0000-0000-0000-000000000001'); end if;
  raise notice 'PASS purchase received once (stock 9)';
end $$;

-- Expenses and settings
select public.save_expense((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, 'Feed', 'Feed bags', 185000, 'EFT', (select v from t_ids where k='sup'), '');
select pg_temp.expect_error($q$select public.save_expense((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, 'Nope', 'x', 100, 'Cash', null, '')$q$, '%expense category%');
select pg_temp.expect_error($q$select public.update_settings((select v from t_ids where k='bizA'), '{"business_name":"Biz A","currency":"ZAR","product_categories":["Eggs"],"expense_categories":["Feed"],"payment_methods":["Cash"],"units":[{"name":"trays","allow_decimal":false},{"name":"birds","allow_decimal":false}],"default_low_stock_threshold":10,"max_discount_percent":15,"batch_tracking_enabled":true}')$q$, '%Category "Live birds" is used%');
select public.update_settings((select v from t_ids where k='bizA'), '{"business_name":"Biz A Renamed","currency":"ZAR","product_categories":["Eggs","Live birds"],"expense_categories":["Feed"],"payment_methods":["Cash","EFT"],"units":[{"name":"trays","allow_decimal":false},{"name":"birds","allow_decimal":false},{"name":"kg","allow_decimal":true}],"default_low_stock_threshold":10,"max_discount_percent":15,"batch_tracking_enabled":true}');
do $$ begin
  if (select count(*) from public.units) <> 3 then raise exception 'FAIL units'; end if;
  raise notice 'PASS settings saved; unused units removed';
end $$;

-- Ledger tables cannot be written directly
select pg_temp.expect_error($q$insert into public.stock_movements (business_id, product_id, quantity, reason, movement_date) values ((select v from t_ids where k='bizA'), (select v from t_ids where k='egg'), 100, 'restock', current_date)$q$, 'permission denied%');
select pg_temp.expect_error($q$update public.products set selling_price = 1$q$, 'permission denied%');
select pg_temp.expect_error($q$select app_private.next_number((select v from t_ids where k='bizA'), 'sale')$q$, 'permission denied%');

-- ===== User B: isolation =====
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
insert into t_ids values ('bizB', public.create_business('Biz B'));
do $$ begin
  if (select count(*) from public.businesses) <> 1 then raise exception 'FAIL B sees other businesses'; end if;
  if (select count(*) from public.sales) + (select count(*) from public.stock_movements) + (select count(*) from public.products) <> 0 then raise exception 'FAIL B sees A data'; end if;
  raise notice 'PASS user B sees only their own business';
end $$;
select pg_temp.expect_error($q$select public.create_sale((select v from t_ids where k='bizA'), gen_random_uuid(), current_date, null, '',
  jsonb_build_array(jsonb_build_object('product_id', (select v from t_ids where k='egg'), 'quantity', 1, 'unit_price', 7500, 'discount', 0)), '{"amount":7500,"method":"Cash"}', '')$q$, '%do not have permission%');
select pg_temp.expect_error($q$select public.create_product((select v from t_ids where k='bizB'), (select v from t_ids where k='egg'), 'Steal', 'Eggs', 'trays', 1, null, null, true, 0, current_date)$q$, '%id conflict%');

-- ===== Anonymous =====
select set_config('request.jwt.claim.sub', '', false);
set role anon;
select pg_temp.expect_error($q$select count(*) from public.sales$q$, 'permission denied%');
select pg_temp.expect_error($q$select public.create_business('x')$q$, 'permission denied%');
reset role;
\echo ALL CHECKS COMPLETED
