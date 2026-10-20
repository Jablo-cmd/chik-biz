# Backend plan (Supabase) — not yet connected

The current Chik-Biz prototype runs **entirely in the browser**. Nothing in this
folder is used by the app today, and **nothing here has been applied to any
Supabase project**.

This folder is a reviewed starting point for the production backend.

## Status

| Item | Status |
| --- | --- |
| `migrations/20261020000000_initial_schema.sql` | Proposed schema. Executed only against a disposable local PostgreSQL 16 database with a stubbed `auth` schema. |
| `tests/rls_smoke_test.sql` | Passed locally on 20 Oct 2026. Covers tenant isolation, duplicate-sale protection, oversell rejection, denial of direct ledger writes, single receipt of purchases and anonymous access. |
| Supabase project | **Not connected.** The project URL supplied in the brief (`xtbqnmndrlkxelritzzn`) was not reachable from the development tooling, so its existing schema, auth settings and policies have **not** been inspected. Inspect them before applying anything. |

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
  -f supabase/migrations/20261020000000_initial_schema.sql
psql -d chikbiz_test -f supabase/tests/rls_smoke_test.sql   # look for PASS / FAIL notices
```

## Connecting the app (future work)

1. **Confirm the project.** Confirm which Supabase project is the client's. Inspect its existing tables, auth providers and policies (for example with `supabase db pull`) before applying this migration. Apply it to a branch or staging project first.
2. **Install the client.** Add `@supabase/supabase-js`. Put only the project URL and the **anon/publishable** key in `.env.local` (see `.env.example`). **Never** use the service-role key in frontend code or in any `VITE_*` variable.
3. **Add a backend store.** Implement a `SupabaseStore` alongside `LocalDemoStore` in `src/data/store.ts`. Reads come from tables and views. Writes call the RPC functions above, passing the same client-generated ids the UI already creates.
4. **Add sign-in and onboarding.** Add Supabase Auth sign-in and an onboarding flow that creates a business and its owner membership. That flow needs a trusted function, because `businesses` has no insert policy.
5. **Keep the shared rules.** Keep `src/domain/commands.ts` validation in the UI for immediate feedback. The database functions remain the source of truth.

GitHub Pages can host the frontend. It cannot run server code or keep secrets, so all trusted logic must live in the database functions or in Supabase Edge Functions.
