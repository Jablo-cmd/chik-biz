// Supabase-backed data access.
//
// Reads: every table for the signed-in user's business, mapped to the same
// AppState the demo uses (row-level security limits rows to that business).
// Writes: only through the database functions in supabase/migrations, which
// validate, lock and audit on the server. Only the public publishable key is
// used here; there is no secret in the frontend.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DomainError } from '../domain/commands';
import { SCHEMA_VERSION } from '../domain/types';
import type {
  AppState,
  AuditEntry,
  BusinessSettings,
  Customer,
  Expense,
  ID,
  MovementReason,
  Payment,
  PoultryBatch,
  Product,
  Purchase,
  Sale,
  StockMovement,
  Supplier,
} from '../domain/types';
import type { Action } from './actions';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const supabaseConfigured = Boolean(URL && KEY);

let client: SupabaseClient | null = null;
export function getSupabase(): SupabaseClient {
  if (!supabaseConfigured) throw new Error('Supabase is not configured for this build.');
  if (!client) {
    client = createClient(URL!, KEY!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'chik-biz:auth' },
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface PgError {
  message: string;
  code?: string;
}

/** Turn a PostgREST/Postgres error into a message the UI can show. */
export function toDomainError(e: PgError): DomainError {
  if (e.code === 'PGRST202') {
    return new DomainError('This action is not available on the live database yet (setup pending). Please try again later.');
  }
  if (e.code === '42501') return new DomainError(e.message || 'You do not have permission to do this.');
  if (e.code === 'PGRST301' || /JWT/i.test(e.message)) return new DomainError('Your session has expired. Please sign in again.');
  if (/Failed to fetch|NetworkError|network/i.test(e.message)) {
    return new DomainError('Could not reach the database. Check your internet connection and try again.');
  }
  return new DomainError(e.message);
}

// ---------------------------------------------------------------------------
// Row mapping (pure, unit-tested)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface RemoteRows {
  business: Row;
  units: Row[];
  products: Row[];
  movements: Row[];
  batches: Row[];
  customers: Row[];
  suppliers: Row[];
  sales: Row[];
  saleLines: Row[];
  payments: Row[];
  expenses: Row[];
  purchases: Row[];
  purchaseLines: Row[];
  audit: Row[];
}

export function settingsFromRow(b: Row, units: Row[]): BusinessSettings {
  return {
    businessName: b.name,
    logoDataUrl: b.logo_data_url ?? null,
    address: b.address ?? '',
    phone: b.phone ?? '',
    email: b.email ?? '',
    currency: String(b.currency).trim(),
    locale: b.locale,
    productCategories: b.product_categories ?? [],
    expenseCategories: b.expense_categories ?? [],
    units: units
      .map((u) => ({ name: u.name as string, allowDecimal: Boolean(u.allow_decimal) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    paymentMethods: b.payment_methods ?? [],
    defaultLowStockThreshold: num(b.default_low_stock_threshold),
    maxDiscountPercent: num(b.max_discount_percent),
    batchTrackingEnabled: Boolean(b.batch_tracking_enabled),
  };
}

export function rowsToState(r: RemoteRows): AppState {
  const products: Product[] = r.products.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    unit: p.unit,
    sellingPrice: num(p.selling_price),
    costPrice: numOrNull(p.cost_price),
    lowStockThreshold: numOrNull(p.low_stock_threshold),
    trackStock: Boolean(p.track_stock),
    archived: Boolean(p.archived),
    createdAt: p.created_at,
  }));

  const movements: StockMovement[] = r.movements.map((m) => ({
    id: String(m.id),
    productId: m.product_id,
    batchId: m.batch_id ?? null,
    quantity: num(m.quantity),
    reason: m.reason as MovementReason,
    date: m.movement_date,
    note: m.note ?? '',
    ref: m.sale_id
      ? { kind: 'sale', id: m.sale_id }
      : m.purchase_id
        ? { kind: 'purchase', id: m.purchase_id }
        : m.batch_id
          ? { kind: 'batch', id: m.batch_id }
          : { kind: 'adjustment', id: m.product_id },
    createdAt: m.created_at,
  }));

  const batches: PoultryBatch[] = r.batches.map((b) => ({
    id: b.id,
    reference: b.reference,
    name: b.name,
    poultryType: b.poultry_type,
    productId: b.product_id,
    startDate: b.start_date,
    initialQuantity: num(b.initial_quantity),
    startingCost: num(b.starting_cost),
    status: b.status,
    notes: b.notes ?? '',
    createdAt: b.created_at,
  }));

  const customers: Customer[] = r.customers.map((c) => ({
    id: c.id,
    name: c.name,
    businessName: c.business_name ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    address: c.address ?? '',
    notes: c.notes ?? '',
    archived: Boolean(c.archived),
    createdAt: c.created_at,
  }));

  const suppliers: Supplier[] = r.suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    contactPerson: s.contact_person ?? '',
    phone: s.phone ?? '',
    email: s.email ?? '',
    notes: s.notes ?? '',
    archived: Boolean(s.archived),
    createdAt: s.created_at,
  }));

  const linesBySale = new Map<ID, Row[]>();
  for (const l of r.saleLines) linesBySale.set(l.sale_id, [...(linesBySale.get(l.sale_id) ?? []), l]);
  const sales: Sale[] = r.sales.map((s) => ({
    id: s.id,
    number: s.number,
    date: s.sale_date,
    customerId: s.customer_id ?? null,
    walkInName: s.walk_in_name ?? '',
    lines: (linesBySale.get(s.id) ?? [])
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => ({
        productId: l.product_id,
        batchId: l.batch_id ?? null,
        description: l.description,
        unit: l.unit,
        quantity: num(l.quantity),
        unitPrice: num(l.unit_price),
        discount: num(l.discount),
      })),
    status: s.status,
    notes: s.notes ?? '',
    voidReason: s.void_reason ?? '',
    createdAt: s.created_at,
  }));

  const payments: Payment[] = r.payments.map((p) => ({
    id: p.id,
    direction: p.direction,
    date: p.payment_date,
    amount: num(p.amount),
    method: p.method,
    saleId: p.sale_id ?? null,
    purchaseId: p.purchase_id ?? null,
    reference: p.reference ?? '',
    createdAt: p.created_at,
  }));

  const expenses: Expense[] = r.expenses.map((e) => ({
    id: e.id,
    date: e.expense_date,
    category: e.category,
    description: e.description,
    amount: num(e.amount),
    method: e.method,
    supplierId: e.supplier_id ?? null,
    reference: e.reference ?? '',
    createdAt: e.created_at,
  }));

  const linesByPurchase = new Map<ID, Row[]>();
  for (const l of r.purchaseLines) linesByPurchase.set(l.purchase_id, [...(linesByPurchase.get(l.purchase_id) ?? []), l]);
  const purchases: Purchase[] = r.purchases.map((p) => ({
    id: p.id,
    number: p.number,
    supplierId: p.supplier_id,
    date: p.purchase_date,
    lines: (linesByPurchase.get(p.id) ?? [])
      .sort((a, b) => a.line_no - b.line_no)
      .map((l) => ({
        productId: l.product_id,
        description: l.description,
        unit: l.unit,
        quantity: num(l.quantity),
        unitCost: num(l.unit_cost),
      })),
    status: p.status,
    reference: p.reference ?? '',
    notes: p.notes ?? '',
    confirmedAt: p.confirmed_at ?? null,
    createdAt: p.created_at,
  }));

  const audit: AuditEntry[] = r.audit.map((a) => ({ id: String(a.id), at: a.created_at, action: a.action, summary: a.summary }));

  return {
    schemaVersion: SCHEMA_VERSION,
    isSampleData: false,
    settings: settingsFromRow(r.business, r.units),
    products,
    movements,
    batches,
    customers,
    sales,
    payments,
    expenses,
    suppliers,
    purchases,
    audit,
    counters: { sale: 0, purchase: 0, batch: 0 },
  };
}

// ---------------------------------------------------------------------------
// Action → database function
// ---------------------------------------------------------------------------

/** The database function and named arguments for an action. */
export function rpcFor(businessId: ID, a: Action): { fn: string; args: Record<string, unknown> } {
  const b = { p_business: businessId };
  switch (a.type) {
    case 'updateSettings': {
      throw new Error('updateSettings needs the merged settings; use settingsRpc().');
    }
    case 'createProduct':
      return {
        fn: 'create_product',
        args: {
          ...b,
          p_id: a.input.id,
          p_name: a.input.name,
          p_category: a.input.category,
          p_unit: a.input.unit,
          p_selling_price: a.input.sellingPrice,
          p_cost_price: a.input.costPrice,
          p_low_stock_threshold: a.input.lowStockThreshold,
          p_track_stock: a.input.trackStock,
          p_opening: a.input.openingStock,
          p_date: a.input.date,
        },
      };
    case 'updateProduct':
      return {
        fn: 'update_product',
        args: {
          ...b,
          p_id: a.id,
          p_name: a.input.name,
          p_category: a.input.category,
          p_unit: a.input.unit,
          p_selling_price: a.input.sellingPrice,
          p_cost_price: a.input.costPrice,
          p_low_stock_threshold: a.input.lowStockThreshold,
          p_track_stock: a.input.trackStock,
        },
      };
    case 'setProductArchived':
      return { fn: 'set_product_archived', args: { ...b, p_id: a.id, p_archived: a.archived } };
    case 'adjustStock':
      return {
        fn: 'adjust_stock',
        args: {
          ...b,
          p_product: a.input.productId,
          p_batch: a.input.batchId,
          p_direction: a.input.direction,
          p_quantity: a.input.quantity,
          p_reason: a.input.reason,
          p_date: a.input.date,
          p_note: a.input.note,
        },
      };
    case 'createBatch':
      return {
        fn: 'create_batch',
        args: {
          ...b,
          p_id: a.input.id,
          p_name: a.input.name,
          p_poultry_type: a.input.poultryType,
          p_product: a.input.productId,
          p_start_date: a.input.startDate,
          p_initial_quantity: a.input.initialQuantity,
          p_starting_cost: a.input.startingCost,
          p_notes: a.input.notes,
        },
      };
    case 'updateBatch':
      return {
        fn: 'update_batch',
        args: { ...b, p_id: a.id, p_name: a.input.name, p_poultry_type: a.input.poultryType, p_starting_cost: a.input.startingCost, p_notes: a.input.notes },
      };
    case 'setBatchStatus':
      return { fn: 'set_batch_status', args: { ...b, p_id: a.id, p_status: a.status } };
    case 'createCustomer':
    case 'updateCustomer': {
      const input = a.input;
      return {
        fn: 'save_customer',
        args: {
          ...b,
          p_id: a.type === 'createCustomer' ? a.input.id : a.id,
          p_name: input.name,
          p_business_name: input.businessName,
          p_phone: input.phone,
          p_email: input.email,
          p_address: input.address,
          p_notes: input.notes,
        },
      };
    }
    case 'setCustomerArchived':
      return { fn: 'set_customer_archived', args: { ...b, p_id: a.id, p_archived: a.archived } };
    case 'createSupplier':
    case 'updateSupplier': {
      const input = a.input;
      return {
        fn: 'save_supplier',
        args: {
          ...b,
          p_id: a.type === 'createSupplier' ? a.input.id : a.id,
          p_name: input.name,
          p_contact_person: input.contactPerson,
          p_phone: input.phone,
          p_email: input.email,
          p_notes: input.notes,
        },
      };
    }
    case 'setSupplierArchived':
      return { fn: 'set_supplier_archived', args: { ...b, p_id: a.id, p_archived: a.archived } };
    case 'createSale':
      return {
        fn: 'create_sale',
        args: {
          ...b,
          p_sale_id: a.input.id,
          p_date: a.input.date,
          p_customer: a.input.customerId,
          p_walk_in_name: a.input.walkInName,
          p_lines: a.input.lines.map((l) => ({
            product_id: l.productId,
            batch_id: l.batchId,
            quantity: l.quantity,
            unit_price: l.unitPrice,
            discount: l.discount,
          })),
          p_payment: a.input.payment,
          p_notes: a.input.notes,
        },
      };
    case 'recordSalePayment':
      return {
        fn: 'record_sale_payment',
        args: {
          ...b,
          p_payment_id: a.input.id,
          p_sale_id: a.saleId,
          p_amount: a.input.amount,
          p_method: a.input.method,
          p_date: a.input.date,
          p_reference: a.input.reference,
        },
      };
    case 'voidSale':
      return { fn: 'void_sale', args: { ...b, p_sale_id: a.saleId, p_reason: a.reason } };
    case 'createExpense':
    case 'updateExpense': {
      const input = a.input;
      return {
        fn: 'save_expense',
        args: {
          ...b,
          p_id: a.type === 'createExpense' ? a.input.id : a.id,
          p_date: input.date,
          p_category: input.category,
          p_description: input.description,
          p_amount: input.amount,
          p_method: input.method,
          p_supplier: input.supplierId,
          p_reference: input.reference,
        },
      };
    }
    case 'deleteExpense':
      return { fn: 'delete_expense', args: { ...b, p_id: a.id } };
    case 'createPurchase':
      return {
        fn: 'create_purchase',
        args: {
          ...b,
          p_id: a.input.id,
          p_supplier: a.input.supplierId,
          p_date: a.input.date,
          p_lines: a.input.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity, unit_cost: l.unitCost })),
          p_reference: a.input.reference,
          p_notes: a.input.notes,
          p_receive: a.receive,
        },
      };
    case 'updatePurchase':
      return {
        fn: 'update_purchase',
        args: {
          ...b,
          p_id: a.input.id,
          p_supplier: a.input.supplierId,
          p_date: a.input.date,
          p_lines: a.input.lines.map((l) => ({ product_id: l.productId, quantity: l.quantity, unit_cost: l.unitCost })),
          p_reference: a.input.reference,
          p_notes: a.input.notes,
        },
      };
    case 'confirmPurchase':
      return { fn: 'confirm_purchase', args: { ...b, p_id: a.id } };
    case 'cancelPurchase':
      return { fn: 'cancel_purchase', args: { ...b, p_id: a.id } };
    case 'recordPurchasePayment':
      return {
        fn: 'record_purchase_payment',
        args: {
          ...b,
          p_payment_id: a.input.id,
          p_purchase_id: a.purchaseId,
          p_amount: a.input.amount,
          p_method: a.input.method,
          p_date: a.input.date,
          p_reference: a.input.reference,
        },
      };
  }
}

/** update_settings takes the complete settings object (already merged and validated locally). */
export function settingsRpc(businessId: ID, s: BusinessSettings) {
  return {
    fn: 'update_settings',
    args: {
      p_business: businessId,
      p_settings: {
        business_name: s.businessName,
        address: s.address,
        phone: s.phone,
        email: s.email,
        logo_data_url: s.logoDataUrl ?? '',
        currency: s.currency,
        locale: s.locale,
        product_categories: s.productCategories,
        expense_categories: s.expenseCategories,
        payment_methods: s.paymentMethods,
        units: s.units.map((u) => ({ name: u.name, allow_decimal: u.allowDecimal })),
        default_low_stock_threshold: s.defaultLowStockThreshold,
        max_discount_percent: s.maxDiscountPercent,
        batch_tracking_enabled: s.batchTrackingEnabled,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const PAGE = 1000;

/** Fetch every row of a table for one business, paging past PostgREST's row limit. */
async function fetchAll(sb: SupabaseClient, table: string, businessId: ID, order: string): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select('*')
      .eq('business_id', businessId)
      .order(order, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw toDomainError(error);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export async function loadBusinessState(sb: SupabaseClient, businessId: ID): Promise<AppState> {
  const [biz, units, products, movements, batches, customers, suppliers, sales, saleLines, payments, expenses, purchases, purchaseLines, audit] =
    await Promise.all([
      sb.from('businesses').select('*').eq('id', businessId).single(),
      fetchAll(sb, 'units', businessId, 'name'),
      fetchAll(sb, 'products', businessId, 'created_at'),
      fetchAll(sb, 'stock_movements', businessId, 'id'),
      fetchAll(sb, 'poultry_batches', businessId, 'created_at'),
      fetchAll(sb, 'customers', businessId, 'created_at'),
      fetchAll(sb, 'suppliers', businessId, 'created_at'),
      fetchAll(sb, 'sales', businessId, 'created_at'),
      fetchAll(sb, 'sale_lines', businessId, 'id'),
      fetchAll(sb, 'payments', businessId, 'created_at'),
      fetchAll(sb, 'expenses', businessId, 'created_at'),
      fetchAll(sb, 'purchases', businessId, 'created_at'),
      fetchAll(sb, 'purchase_lines', businessId, 'id'),
      sb.from('audit_log').select('*').eq('business_id', businessId).order('created_at', { ascending: false }).limit(300),
    ]);
  if (biz.error) throw toDomainError(biz.error);
  if (audit.error) throw toDomainError(audit.error);
  return rowsToState({
    business: biz.data,
    units,
    products,
    movements,
    batches,
    customers,
    suppliers,
    sales,
    saleLines,
    payments,
    expenses,
    purchases,
    purchaseLines,
    audit: audit.data ?? [],
  });
}

export interface Membership {
  businessId: ID;
  role: 'owner' | 'manager' | 'staff';
  businessName: string;
}

export async function myMemberships(sb: SupabaseClient, userId: ID): Promise<Membership[]> {
  const { data, error } = await sb
    .from('business_members')
    .select('business_id, role, created_at, businesses(name)')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw toDomainError(error);
  return (data ?? []).map((m: Row) => ({
    businessId: m.business_id,
    role: m.role,
    businessName: (Array.isArray(m.businesses) ? m.businesses[0]?.name : m.businesses?.name) ?? '',
  }));
}

export async function callRpc(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw toDomainError(error);
  return data;
}
