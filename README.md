# Chik-Biz — poultry business management (prototype)

Chik-Biz is a mobile-first web app for running a small poultry business day to day. It covers sales and receipts, customers and credit, stock, optional poultry batches, expenses, suppliers and purchases, and reports.

It is developed by **Auris Nexus Technologies (Pty) Ltd** as the technology provider. The business name and logo shown in the app belong to the poultry business using it. You can set them in **Settings**, and they default to a neutral placeholder.

> **Status: working prototype, not yet production-hardened.**
> The app has two modes, chosen on the start screen:
> - **Live** — sign in and work with your business's data in Supabase (shared, access-controlled, server-validated).
> - **Demo** — **fictional** sample data kept only in this browser, clearly labelled.

---

## Run it locally

You need Node.js 20 or later (CI uses 22).

```bash
npm ci            # install exact versions from package-lock.json
npm run dev       # http://localhost:5173
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm test` | Runs the unit tests (Vitest) for calculations and business rules |
| `npm run build` | Type-checks (`tsc -b`) and builds static files into `dist/` |
| `npm run preview` | Serves the production build locally (http://localhost:4173) |
| `npm run typecheck` | Type-checks only |

No environment variables are needed for the demo. To enable live mode locally, copy `.env.example` to `.env.local` and fill in the project URL and **publishable** key (Supabase dashboard → Project Settings → API). These are public values; the service-role key must never be used.

---

## Features

| Module | What works |
| --- | --- |
| **Dashboard** | <ul><li>Sales today (including credit) and cash collected today</li><li>Expenses today and the total owed by customers</li><li>Inventory summary</li><li>14-day sales chart with daily cash collected</li><li>Alerts: low or out of stock, credit unpaid for more than 14 days, batch mortality of 5% or more, purchases awaiting receipt</li><li>Recent transactions</li></ul>Every figure is calculated from the records. |
| **Inventory** | <ul><li>Add, edit, archive and restore products (name, category, unit, selling price, optional cost price, low-stock threshold)</li><li>Products can be marked as stock-tracked or not</li><li>Stock in and out with reasons: restock, production, damage, loss, death, theft, own use, count correction, other</li><li>Full movement history per product</li><li>Search and filters; low-stock badges</li><li>Negative stock is blocked</li></ul> |
| **Poultry batches** *(optional, switch off in Settings)* | <ul><li>Batches with reference, name, poultry type, start date, initial quantity and starting cost</li><li>Record deaths, losses and additions</li><li>Sales can be linked to a batch</li><li>Running totals, mortality % and a traceable event history</li><li>Close or reopen a batch</li></ul>Batch birds are counted in a normal product's stock, so batch and inventory figures always agree. |
| **Sales** | <ul><li>Multi-line sales for a customer or a walk-in buyer</li><li>Per-line discounts up to a configurable maximum</li><li>Automatic totals; payment method and amount</li><li>Paid, part-paid and unpaid status; record later payments</li><li>Void a sale: stock is returned and the record is kept</li><li>Printable receipt or invoice</li><li>History with search, date and status filters, and CSV export</li></ul> |
| **Customers** | <ul><li>Contact details and optional business name</li><li>Sales history</li><li>Balance owed, calculated from sales and payments</li><li>Archive and restore</li></ul> |
| **Expenses** | <ul><li>Date, configurable category, description, amount, payment method, optional supplier and reference</li><li>Edit, and delete with confirmation (logged)</li><li>Filters and CSV export</li></ul> |
| **Suppliers & purchases** | <ul><li>Supplier directory</li><li>Purchases with lines, saved as drafts and received into stock exactly once</li><li>Cancel a draft</li><li>Record supplier payments, with paid status and balance</li></ul> |
| **Reports** *(date-filtered, with CSV export)* | <ul><li>Overview: estimated operating result and cash flow, with the assumptions listed</li><li>Sales by product and by sale</li><li>Expenses by category</li><li>Payments received and paid out</li><li>Customer balances as at a date</li><li>Inventory levels as at a date</li><li>Stock movements and recorded losses</li></ul> |
| **Settings** | <ul><li>Business name, logo, address and contact details</li><li>Currency (ZAR by default; display only, no conversion)</li><li>Product and expense categories, units (with decimal rules) and payment methods</li><li>Default low-stock threshold, maximum discount and batch tracking on or off</li><li>Backup download and restore</li><li>Reset sample data or start empty</li><li>Activity log</li></ul> |

### Business rules worth knowing

- **Stock** is never stored as a number. It is the sum of the stock-movement ledger, so inventory always reconciles with its history.
- **Sales cannot be recorded twice.** Each sale form gets a unique id when it opens, and a repeat submission (double-click, refresh, back button) with that id changes nothing. This is tested in unit and browser tests.
- **Purchases can be received only once.** A second "Receive" is rejected.
- **Walk-in sales must be paid in full.** Credit sales need a customer record.
- **Units are not converted.** For example, trays of eggs and loose eggs are separate products. A product's unit is locked once stock has been recorded in it.
- **Payments cannot exceed the outstanding balance.** A sale with payments cannot be voided; refunds are not supported yet.
- **Future dates are rejected** for transactions.

### About the "estimated operating result"

Reports keep these figures separate:

- **Sales revenue:** the value of completed sales, paid or not.
- **Cash collected:** payments actually received.
- **Receivables:** money still owed by customers.
- **Expenses.**

The operating estimate is *revenue − expenses − stock purchases received − batch starting costs*. It is **not net profit**: it does not account for opening or closing stock, cost of goods sold, depreciation, tax or unrecorded costs. The full list of assumptions is shown next to the figure in the app.

---

## Architecture

```
src/
  domain/      Pure business logic (no React, no storage). Fully unit-tested.
    types.ts      Data model (money in integer cents)
    commands.ts   Validated, idempotent state changes
    selectors.ts  Derived values (stock, balances, payment status)
    reports.ts    Report, dashboard and CSV calculations
    seed.ts       Fictional demo data, built through the same commands
  data/actions.ts  Every change as a typed action (shared by both modes)
  data/store.ts    Demo mode: browser storage (LocalDemoStore)
  data/supabase.ts Live mode: Supabase loading + one database function per action
  app/           App shell, navigation, hash router, context
  pages/         One file per module
  ui/            Shared components (forms, dialogs, tables…)
supabase/      Database schema, access rules, functions and tests (see supabase/README.md)
```

- The UI changes data only through `run(action)`.
  - **Demo:** the action is applied with the domain commands and saved in one write. If it fails, nothing is saved.
  - **Live:** the same validation runs first for instant feedback. Then the matching database function re-validates, locks the affected rows, writes an audit entry and is idempotent on the client-generated id. The app then reloads from the database.
- Routing is hash-based (`#/sales/…`), so the build works on static hosting such as GitHub Pages with no rewrite rules. `vite.config.ts` uses `base: './'`.

### Limitations

- **Live mode:** one business per account for now (the first one you belong to); no staff invitation screen yet; changes from other devices appear when you return to the app (no real-time push).
- **Demo mode:** data lives in one browser on one device, with no user accounts or permissions.
- Clearing browser data deletes everything. Use **Settings → Download backup** to keep a copy.
- Browser storage is **not** secure storage. Do not enter sensitive personal information.
- Backend-level guarantees (row locks, transactions across devices) only exist once a backend is connected.

---

## Tests

```bash
npm test
```

There are 56 unit tests. `src/data/supabase.test.ts` (30) checks every database call's argument names against the migrations, plus row mapping and error messages. `src/domain/domain.test.ts` (26) covers:

- money and quantity parsing
- sale totals, discounts and maximum-discount rules
- partial, full and over-payments
- customer balances and receivables
- stock additions, deductions and losses, including rejection of negative stock
- fractional quantities for whole-number units, and the unit-change lock
- **duplicate sale submission**, including after a simulated page reload
- nothing persisted when a command fails
- purchases received only once; duplicate payments ignored
- voiding a sale
- batch tracking and mortality
- expense totals by category and date
- revenue vs cash vs receivables vs expenses
- dashboard figures
- CSV escaping and formula-injection protection
- settings validation
- consistency of the sample data

The backend proposal has its own SQL smoke test; see `supabase/README.md`.

---

## Deployment

The repository includes two GitHub Actions workflows:

- **`.github/workflows/ci.yml`** runs tests and the production build on every push and pull request.
- **`.github/workflows/deploy-pages.yml`** deploys `dist/` to **GitHub Pages**. It runs **only when started manually**: Actions → "Deploy demo to GitHub Pages" → *Run workflow*.

  One-time setup: **Settings → Pages → Source: GitHub Actions**. To include live mode, also add repository **variables** (not secrets — they are public) `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Without them the published site is demo-only. The site would be served at `https://<owner>.github.io/chik-biz/`.

The demo has **not** been deployed yet.

Any static host works. Serve the `dist/` folder produced by `npm run build`.

---

## Backend (Supabase)

Live mode uses the Supabase project `xtbqnmndrlkxelritzzn`. See [`supabase/README.md`](supabase/README.md) for:

- the schema, access rules and functions
- what is applied and what is pending
- the test scripts
- the dashboard settings the owner must check (site URL, email confirmation, SMTP)

Never place a service-role key in the frontend.

---

## Open questions for the client

These have not been answered yet. The prototype deliberately stays flexible until they are:

- Which activities apply: raising birds, buying and reselling live birds, processing and selling dressed chicken, eggs, other products?
- Product list, units and typical prices. Are any unit conversions needed (e.g. trays ↔ eggs)?
- One location or several? *(Not yet modelled.)*
- Credit terms for customers, and how payments are usually received.
- Expense categories in use, and whether suppliers are paid on account.
- Business name, logo, address and contact details for receipts. Are VAT/tax invoices required?
- Who will use the system, and whether staff need restricted permissions.
- Main operational pain points to prioritise.
