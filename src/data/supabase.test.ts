import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Action } from './actions';
import { rowsToState, rpcFor, settingsRpc, toDomainError } from './supabase';
import { DEFAULT_SETTINGS } from '../domain/defaults';
import { stockOnHand, customerBalance, saleView } from '../domain/selectors';

// Parse `create function public.<name>(<args>)` from the migration files so the
// app's RPC calls are checked against the real database signatures.
function dbSignatures(): Map<string, string[]> {
  const dir = join(__dirname, '../../supabase/migrations');
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
  const out = new Map<string, string[]>();
  const re = /create function public\.(\w+)\s*\(([^)]*)\)/g;
  for (const m of sql.matchAll(re)) {
    const args = m[2]
      .split(',')
      .map((a) => a.trim().split(/\s+/)[0])
      .filter(Boolean);
    out.set(m[1], args);
  }
  return out;
}

const BIZ = '10000000-0000-0000-0000-000000000001';
const ID = '20000000-0000-0000-0000-000000000001';

const sampleActions: Action[] = [
  { type: 'createProduct', input: { id: ID, name: 'x', category: 'Eggs', unit: 'trays', sellingPrice: 1, costPrice: null, lowStockThreshold: null, trackStock: true, openingStock: 0, date: '2026-10-21' } },
  { type: 'updateProduct', id: ID, input: { name: 'x', category: 'Eggs', unit: 'trays', sellingPrice: 1, costPrice: null, lowStockThreshold: null, trackStock: true } },
  { type: 'setProductArchived', id: ID, archived: true },
  { type: 'adjustStock', input: { productId: ID, batchId: null, direction: 'in', quantity: 1, reason: 'restock', date: '2026-10-21', note: '' } },
  { type: 'createBatch', input: { id: ID, name: 'b', poultryType: 'Broiler', productId: ID, startDate: '2026-10-21', initialQuantity: 1, startingCost: 0, notes: '' } },
  { type: 'updateBatch', id: ID, input: { name: 'b', poultryType: 'Broiler', startingCost: 0, notes: '' } },
  { type: 'setBatchStatus', id: ID, status: 'closed' },
  { type: 'createCustomer', input: { id: ID, name: 'c', businessName: '', phone: '', email: '', address: '', notes: '' } },
  { type: 'updateCustomer', id: ID, input: { name: 'c', businessName: '', phone: '', email: '', address: '', notes: '' } },
  { type: 'setCustomerArchived', id: ID, archived: true },
  { type: 'createSupplier', input: { id: ID, name: 's', contactPerson: '', phone: '', email: '', notes: '' } },
  { type: 'updateSupplier', id: ID, input: { name: 's', contactPerson: '', phone: '', email: '', notes: '' } },
  { type: 'setSupplierArchived', id: ID, archived: true },
  { type: 'createSale', input: { id: ID, date: '2026-10-21', customerId: null, walkInName: '', notes: '', payment: null, lines: [{ productId: ID, batchId: null, quantity: 1, unitPrice: 1, discount: 0 }] } },
  { type: 'recordSalePayment', saleId: ID, input: { id: ID, amount: 1, method: 'Cash', date: '2026-10-21', reference: '' } },
  { type: 'voidSale', saleId: ID, reason: 'x' },
  { type: 'createExpense', input: { id: ID, date: '2026-10-21', category: 'Feed', description: 'x', amount: 1, method: 'Cash', supplierId: null, reference: '' } },
  { type: 'updateExpense', id: ID, input: { date: '2026-10-21', category: 'Feed', description: 'x', amount: 1, method: 'Cash', supplierId: null, reference: '' } },
  { type: 'deleteExpense', id: ID },
  { type: 'createPurchase', input: { id: ID, supplierId: ID, date: '2026-10-21', lines: [{ productId: ID, quantity: 1, unitCost: 1 }], reference: '', notes: '' }, receive: false },
  { type: 'updatePurchase', input: { id: ID, supplierId: ID, date: '2026-10-21', lines: [{ productId: ID, quantity: 1, unitCost: 1 }], reference: '', notes: '' } },
  { type: 'confirmPurchase', id: ID },
  { type: 'cancelPurchase', id: ID },
  { type: 'recordPurchasePayment', purchaseId: ID, input: { id: ID, amount: 1, method: 'Cash', date: '2026-10-21', reference: '' } },
];

describe('RPC calls match the database functions', () => {
  const sigs = dbSignatures();

  it('found the migration functions', () => {
    expect(sigs.size).toBeGreaterThan(20);
  });

  for (const a of sampleActions) {
    it(`${a.type} → exact argument names`, () => {
      const { fn, args } = rpcFor(BIZ, a);
      expect(sigs.has(fn), `missing function ${fn}`).toBe(true);
      expect(Object.keys(args).sort()).toEqual([...sigs.get(fn)!].sort());
      expect(args.p_business).toBe(BIZ);
    });
  }

  it('updateSettings → exact argument names', () => {
    const { fn, args } = settingsRpc(BIZ, DEFAULT_SETTINGS);
    expect(Object.keys(args).sort()).toEqual([...sigs.get(fn)!].sort());
  });

  it('every action type is covered', () => {
    const covered = new Set(sampleActions.map((a) => a.type));
    covered.add('updateSettings');
    expect(covered.size).toBe(25);
  });
});

describe('row mapping', () => {
  const rows = {
    business: {
      id: BIZ, name: 'Farm', address: '', phone: '', email: '', logo_data_url: null, currency: 'ZAR', locale: 'en-ZA',
      product_categories: ['Eggs'], expense_categories: ['Feed'], payment_methods: ['Cash'],
      default_low_stock_threshold: '10.000', max_discount_percent: '15.00', batch_tracking_enabled: true,
    },
    units: [{ business_id: BIZ, name: 'trays', allow_decimal: false }, { business_id: BIZ, name: 'kg', allow_decimal: true }],
    products: [{ id: 'p1', business_id: BIZ, name: 'Eggs', category: 'Eggs', unit: 'trays', selling_price: 7500, cost_price: null, low_stock_threshold: null, track_stock: true, archived: false, created_at: '2026-10-21T08:00:00Z' }],
    movements: [
      { id: 1, business_id: BIZ, product_id: 'p1', batch_id: null, quantity: '10.000', reason: 'opening', movement_date: '2026-10-21', note: '', sale_id: null, purchase_id: null, created_at: '2026-10-21T08:00:00Z' },
      { id: 2, business_id: BIZ, product_id: 'p1', batch_id: null, quantity: '-2.000', reason: 'sale', movement_date: '2026-10-21', note: 'Sale S-00001', sale_id: 's1', purchase_id: null, created_at: '2026-10-21T09:00:00Z' },
    ],
    batches: [],
    customers: [{ id: 'c1', business_id: BIZ, name: 'Cust', business_name: '', phone: '', email: '', address: '', notes: '', archived: false, created_at: '2026-10-21T08:00:00Z' }],
    suppliers: [],
    sales: [{ id: 's1', business_id: BIZ, number: 'S-00001', sale_date: '2026-10-21', customer_id: 'c1', walk_in_name: '', status: 'completed', notes: '', void_reason: '', created_at: '2026-10-21T09:00:00Z' }],
    saleLines: [{ id: 1, business_id: BIZ, sale_id: 's1', line_no: 1, product_id: 'p1', batch_id: null, description: 'Eggs', unit: 'trays', quantity: '2.000', unit_price: 7500, discount: 0 }],
    payments: [{ id: 'pay1', business_id: BIZ, direction: 'in', payment_date: '2026-10-21', amount: 5000, method: 'Cash', sale_id: 's1', purchase_id: null, reference: '', created_at: '2026-10-21T09:00:00Z' }],
    expenses: [],
    purchases: [],
    purchaseLines: [],
    audit: [{ id: 7, business_id: BIZ, action: 'sale.create', summary: 'Sale S-00001 recorded', created_at: '2026-10-21T09:00:00Z' }],
  };

  it('maps numeric strings, references and derived figures', () => {
    const s = rowsToState(rows);
    expect(s.settings.defaultLowStockThreshold).toBe(10);
    expect(s.settings.units.map((u) => u.name)).toEqual(['kg', 'trays']);
    expect(stockOnHand(s, 'p1')).toBe(8);
    expect(s.movements[1].ref).toEqual({ kind: 'sale', id: 's1' });
    expect(s.movements[0].ref).toEqual({ kind: 'adjustment', id: 'p1' });
    const v = saleView(s, s.sales[0]);
    expect(v.totals.total).toBe(15000);
    expect(v.paid).toBe(5000);
    expect(customerBalance(s, 'c1')).toBe(10000);
    expect(s.audit[0].id).toBe('7');
    expect(s.isSampleData).toBe(false);
  });
});

describe('error mapping', () => {
  it('explains functions that are not deployed yet', () => {
    expect(toDomainError({ code: 'PGRST202', message: 'Could not find the function' }).message).toMatch(/not available on the live database yet/);
  });
  it('passes business-rule messages through', () => {
    expect(toDomainError({ code: 'P0001', message: 'Insufficient stock for "Eggs": 3 trays available.' }).message).toBe('Insufficient stock for "Eggs": 3 trays available.');
  });
});
