# Supabase backend

This folder holds the Supabase backend for Chik-Biz: the database schema, its
access rules and the functions the app calls in live mode.

## Status

The schema lives in `migrations/20261020000001…4_*.sql` and has been applied to the Supabase project `xtbqnmndrlkxelritzzn` ("chik-biz"), with three functions still outstanding:

| Item | Status |
| --- | --- |
| Tables, indexes, RLS, views (`…0001`) | Applied |
| Private helpers (`…0002`) | Applied |
| API functions except the three below (`…0003`, `…0004`) | Applied, in smaller batches because of connector timeouts |
| `update_settings`, `update_purchase`, `delete_expense` | **Not yet applied.** Their SQL contains `DELETE`, which needs the owner's confirmation through the connector. Alternatively, paste them from the migration files into the SQL editor. |
| `tests/rls_smoke_test.sql` | 25/25 checks passed against a local PostgreSQL 16 with the stubbed `auth` schema |
| Supabase security advisor | Only finding: signed-in users can call the `SECURITY DEFINER` API functions. This is intended — each one checks membership itself — and logged-out visitors (`anon`) can't call any of them. |
| Live check on the real project | Passed inside a rolled-back transaction: repeated sale/payment ignored, oversell / double receipt / direct ledger writes rejected, batch counts correct, a second business cannot see or change the first |
| Frontend | Connected: start screen offers live sign-in or the demo. Writes go through these functions only. |

## Design summary

- **Tenant isolation.** Every business table has a `business_id` column. Row-level security admits a row only when `auth.uid()` belongs to that business (`business_members`). A business id sent by the client is never treated as proof of access.
- **Roles.** The roles are `owner`, `manager` and `staff`. Only owners and managers can void sales, delete expenses or change settings.
- **Ledgers.** `stock_movements`, `payments`, `sales` and `purchases` cannot be written directly by API users. Changes go through `SECURITY DEFINER` functions:
  - `create_sale`
  - `record_sale_payment`
  - `void_sale`
  - `confirm_purchase`
  - `adjust_stock`

  Each function checks membership, locks the affected rows, validates stock and amounts, and writes an audit entry.
- **Idempotency.** Sales, payments, purchases and expenses use a client-generated UUID as the primary key. A repeated `create_sale` with the same id returns the existing sale without touching stock again.
- **Derived values.** Stock on hand (`product_stock` view) and sale balances (`sale_balances` view) are calculated from the records, not stored. Both views use `security_invoker`, so RLS still applies.
- **Logos.** Logos should be stored in Supabase Storage (`businesses.logo_path`) with a bucket policy restricted to members, not as data URLs.

## Run the local checks

You need a local PostgreSQL 15 or later. The Supabase CLI (`supabase start`) also works; if you use it, skip the stub file because Supabase provides `auth` itself.

```bash
createdb chikbiz_test
psql -d chikbiz_test -v ON_ERROR_STOP=1 \
  -f supabase/tests/local_auth_stub.sql \
  -f supabase/migrations/20261020000001_schema_tables_rls.sql \
  -f supabase/migrations/20261020000002_private_helpers.sql \
  -f supabase/migrations/20261020000003_api_catalogue.sql \
  -f supabase/migrations/20261020000004_api_transactions.sql
psql -d chikbiz_test -f supabase/tests/rls_smoke_test.sql   # look for PASS / FAIL notices
```

## How the app connects

- `src/data/supabase.ts` creates the client from `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`, loads the signed-in user's business (paging past the 1,000-row API limit) and maps each app action to one database function.
- `src/data/supabase.test.ts` checks that every function call uses exactly the argument names declared in the migrations.
- Sign-in uses Supabase Auth (email + password). A new user with no business is asked to create one and becomes its owner (`create_business`).
- If a function is missing (e.g. the three pending ones), the app shows "This action is not available on the live database yet" instead of failing silently.

## Owner checklist (Supabase dashboard)

1. **Authentication → URL Configuration:** set **Site URL** to the address the app is served from (for GitHub Pages: `https://<owner>.github.io/chik-biz/`) and add it under **Redirect URLs**, so confirmation and password-reset emails link back to the app.
2. **Authentication → Providers → Email:** keep "Confirm email" on for production. The default Supabase mailer is rate-limited; configure custom SMTP before real users sign up.
3. Apply the three pending functions (see Status).
4. Never use the service-role key in the app.
