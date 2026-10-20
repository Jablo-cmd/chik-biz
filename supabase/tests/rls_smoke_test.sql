\set ON_ERROR_STOP on
-- Setup as superuser
insert into auth.users values ('00000000-0000-0000-0000-00000000000a'), ('00000000-0000-0000-0000-00000000000b');
insert into public.businesses (id, name) values ('10000000-0000-0000-0000-000000000001', 'Biz A'), ('10000000-0000-0000-0000-000000000002', 'Biz B');
insert into public.business_members values ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', 'owner', now()),
                                           ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000b', 'owner', now());
insert into public.units values ('10000000-0000-0000-0000-000000000001', 'trays', false), ('10000000-0000-0000-0000-000000000002', 'trays', false);
insert into public.products (id, business_id, name, category, unit, selling_price) values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Eggs tray', 'Eggs', 'trays', 7500),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'B eggs', 'Eggs', 'trays', 7000);
insert into public.stock_movements (business_id, product_id, quantity, reason, movement_date) values
  ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 10, 'opening', current_date);

-- Act as user A
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);

select 'A sees businesses: ' || count(*) from public.businesses;
select 'A sees B products: ' || count(*) from public.products where business_id = '10000000-0000-0000-0000-000000000002';

select public.create_sale('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', current_date, null, '',
  '[{"product_id":"20000000-0000-0000-0000-000000000001","quantity":3,"unit_price":7500,"discount":0}]', '{"amount":22500,"method":"Cash"}');
-- Repeat submission: must not deduct again
select public.create_sale('10000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', current_date, null, '',
  '[{"product_id":"20000000-0000-0000-0000-000000000001","quantity":3,"unit_price":7500,"discount":0}]', '{"amount":22500,"method":"Cash"}');
select 'stock after sale+repeat (expect 7): ' || on_hand from public.product_stock where product_id = '20000000-0000-0000-0000-000000000001';
select 'payments (expect 1): ' || count(*) from public.payments;

do $$ begin
  perform public.create_sale('10000000-0000-0000-0000-000000000001', gen_random_uuid(), current_date, null, '',
    '[{"product_id":"20000000-0000-0000-0000-000000000001","quantity":99,"unit_price":7500,"discount":0}]', '{"amount":742500,"method":"Cash"}');
  raise exception 'FAIL oversell allowed';
exception when others then raise notice 'PASS oversell rejected: %', sqlerrm; end $$;

do $$ begin
  insert into public.stock_movements (business_id, product_id, quantity, reason, movement_date) values ('10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 100, 'restock', current_date);
  raise exception 'FAIL direct ledger insert allowed';
exception when insufficient_privilege then raise notice 'PASS direct ledger insert denied'; end $$;

do $$ begin
  perform public.create_sale('10000000-0000-0000-0000-000000000002', gen_random_uuid(), current_date, null, '',
    '[{"product_id":"20000000-0000-0000-0000-000000000002","quantity":1,"unit_price":7000,"discount":0}]', '{"amount":7000,"method":"Cash"}');
  raise exception 'FAIL cross-tenant sale allowed';
exception when insufficient_privilege then raise notice 'PASS cross-tenant RPC denied'; end $$;

do $$ begin
  insert into public.products (business_id, name, category, unit, selling_price) values ('10000000-0000-0000-0000-000000000002', 'X', 'Eggs', 'trays', 1);
  raise exception 'FAIL cross-tenant insert allowed';
exception when insufficient_privilege then raise notice 'PASS cross-tenant insert denied by RLS'; end $$;

-- Purchase received once
reset role;
insert into public.suppliers (id, business_id, name) values ('40000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Supp');
insert into public.purchases (id, business_id, number, supplier_id, purchase_date) values ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'P-00001', '40000000-0000-0000-0000-000000000001', current_date);
insert into public.purchase_lines (business_id, purchase_id, product_id, description, unit, quantity, unit_cost) values ('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Eggs tray', 'trays', 5, 5000);
set role authenticated;
select public.confirm_purchase('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001');
do $$ begin
  perform public.confirm_purchase('10000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001');
  raise exception 'FAIL purchase received twice';
exception when others then raise notice 'PASS second receipt rejected: %', sqlerrm; end $$;
select 'stock after purchase (expect 12): ' || on_hand from public.product_stock where product_id = '20000000-0000-0000-0000-000000000001';

-- User B sees nothing of A
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000b', false);
select 'B sees A sales (expect 0): ' || count(*) from public.sales;
select 'B sees A ledger rows (expect 0): ' || count(*) from public.stock_movements;
-- Anonymous sees nothing
select set_config('request.jwt.claim.sub', '', false);
set role anon;
do $$ begin perform count(*) from public.sales; raise exception 'FAIL anon read'; exception when insufficient_privilege then raise notice 'PASS anon denied'; end $$;
