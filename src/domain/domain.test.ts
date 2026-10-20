import { describe, expect, it } from 'vitest';
import * as cmd from './commands';
import { DEFAULT_SETTINGS, emptyState } from './defaults';
import { parseMoney, parseQty } from './format';
import {
  dashboardMetrics,
  expensesByCategory,
  inventoryAsOf,
  lossSummary,
  operatingPerformance,
  receivablesAsOf,
  salesInRange,
  salesSummary,
  toCSV,
} from './reports';
import { batchSummary, customerBalance, saleView, stockOnHand, totalReceivables } from './selectors';
import { buildDemoState } from './seed';
import type { AppState } from './types';
import { LocalDemoStore, memoryStorage } from '../data/store';

const NOW = new Date(2026, 9, 20, 12, 0, 0); // 20 Oct 2026, local time
const TODAY = '2026-10-20';

function ctx(): cmd.Ctx {
  let n = 0;
  return { now: NOW, newId: () => `t-${++n}-${Math.random().toString(36).slice(2, 7)}` };
}

function setup() {
  const c = ctx();
  let s: AppState = emptyState();
  const egg = cmd.createProduct(
    s,
    {
      name: 'Eggs tray',
      category: 'Eggs',
      unit: 'trays',
      sellingPrice: 75_00,
      costPrice: 50_00,
      lowStockThreshold: 5,
      trackStock: true,
      openingStock: 20,
      date: TODAY,
    },
    c,
  );
  s = egg.state;
  const meat = cmd.createProduct(
    s,
    {
      name: 'Dressed chicken',
      category: 'Dressed chicken',
      unit: 'kg',
      sellingPrice: 70_00,
      costPrice: null,
      lowStockThreshold: null,
      trackStock: true,
      openingStock: 10.5,
      date: TODAY,
    },
    c,
  );
  s = meat.state;
  const cust = cmd.createCustomer(
    s,
    { name: 'Test Customer', businessName: '', phone: '', email: '', address: '', notes: '' },
    c,
  );
  s = cust.state;
  return { s, c, egg: egg.id, meat: meat.id, customer: cust.id };
}

describe('parsing', () => {
  it('parses money into cents', () => {
    expect(parseMoney('12.50')).toBe(1250);
    expect(parseMoney('12,5')).toBe(1250);
    expect(parseMoney('R 1200')).toBe(120000);
    expect(parseMoney('0.1')).toBe(10);
    expect(parseMoney('-1')).toBeNull();
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
  it('parses quantities', () => {
    expect(parseQty('2,25')).toBe(2.25);
    expect(parseQty('x')).toBeNull();
  });
});

describe('sales totals and payments', () => {
  it('calculates line totals, discounts and partial payment balance', () => {
    const { s, c, egg, meat, customer } = setup();
    const r = cmd.createSale(
      s,
      {
        id: 'sale-1',
        date: TODAY,
        customerId: customer,
        walkInName: '',
        lines: [
          { productId: egg, batchId: null, quantity: 3, unitPrice: 75_00, discount: 10_00 },
          { productId: meat, batchId: null, quantity: 1.5, unitPrice: 70_00, discount: 0 },
        ],
        notes: '',
        payment: { amount: 100_00, method: 'Cash', reference: '' },
      },
      c,
    );
    const v = saleView(r.state, r.state.sales[0]);
    expect(v.totals.subtotal).toBe(225_00 + 105_00);
    expect(v.totals.discount).toBe(10_00);
    expect(v.totals.total).toBe(320_00);
    expect(v.paid).toBe(100_00);
    expect(v.balance).toBe(220_00);
    expect(v.status).toBe('partial');
    expect(customerBalance(r.state, customer)).toBe(220_00);
    expect(totalReceivables(r.state)).toBe(220_00);

    // Pay the rest in two instalments.
    let s2 = cmd.recordSalePayment(r.state, 'sale-1', { id: 'p1', amount: 120_00, method: 'EFT', date: TODAY, reference: '' }, c).state;
    expect(customerBalance(s2, customer)).toBe(100_00);
    expect(() =>
      cmd.recordSalePayment(s2, 'sale-1', { id: 'p2', amount: 100_01, method: 'EFT', date: TODAY, reference: '' }, c),
    ).toThrow(/exceeds the outstanding balance/);
    s2 = cmd.recordSalePayment(s2, 'sale-1', { id: 'p2', amount: 100_00, method: 'EFT', date: TODAY, reference: '' }, c).state;
    expect(saleView(s2, s2.sales[0]).status).toBe('paid');
    expect(customerBalance(s2, customer)).toBe(0);
    expect(() =>
      cmd.recordSalePayment(s2, 'sale-1', { id: 'p3', amount: 1, method: 'EFT', date: TODAY, reference: '' }, c),
    ).toThrow(/already paid/);
  });

  it('marks an unpaid credit sale as unpaid', () => {
    const { s, c, egg, customer } = setup();
    const r = cmd.createSale(
      s,
      { id: 'x', date: TODAY, customerId: customer, walkInName: '', notes: '', payment: null, lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 75_00, discount: 0 }] },
      c,
    );
    expect(saleView(r.state, r.state.sales[0]).status).toBe('unpaid');
    expect(customerBalance(r.state, customer)).toBe(75_00);
  });

  it('requires walk-in sales to be paid in full', () => {
    const { s, c, egg } = setup();
    expect(() =>
      cmd.createSale(
        s,
        { id: 'x', date: TODAY, customerId: null, walkInName: '', notes: '', payment: { amount: 10_00, method: 'Cash', reference: '' }, lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 75_00, discount: 0 }] },
        c,
      ),
    ).toThrow(/paid in full/);
  });

  it('rejects overpayment and excessive discounts', () => {
    const { s, c, egg, customer } = setup();
    const base = { id: 'x', date: TODAY, customerId: customer, walkInName: '', notes: '' };
    expect(() =>
      cmd.createSale(s, { ...base, payment: { amount: 80_00, method: 'Cash', reference: '' }, lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 75_00, discount: 0 }] }, c),
    ).toThrow(/cannot exceed the sale total/);
    // Default max discount is 15%: 75.00 * 15% = 11.25
    expect(() =>
      cmd.createSale(s, { ...base, payment: null, lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 75_00, discount: 11_26 }] }, c),
    ).toThrow(/permitted maximum/);
    expect(() =>
      cmd.createSale(s, { ...base, payment: null, lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 75_00, discount: 11_25 }] }, c),
    ).not.toThrow();
  });

  it('rejects future-dated sales and fractional quantities for whole-number units', () => {
    const { s, c, egg, customer } = setup();
    const base = { id: 'x', customerId: customer, walkInName: '', notes: '', payment: null };
    expect(() =>
      cmd.createSale(s, { ...base, date: '2026-10-21', lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 1, discount: 0 }] }, c),
    ).toThrow(/future/);
    expect(() =>
      cmd.createSale(s, { ...base, date: TODAY, lines: [{ productId: egg, batchId: null, quantity: 1.5, unitPrice: 1, discount: 0 }] }, c),
    ).toThrow(/whole number/);
  });
});

describe('inventory', () => {
  it('derives stock from movements: additions, deductions and losses', () => {
    const { s, c, egg } = setup();
    expect(stockOnHand(s, egg)).toBe(20);
    let s2 = cmd.adjustStock(s, { productId: egg, batchId: null, direction: 'in', quantity: 5, reason: 'restock', date: TODAY, note: '' }, c);
    s2 = cmd.adjustStock(s2, { productId: egg, batchId: null, direction: 'out', quantity: 2, reason: 'damage', date: TODAY, note: '' }, c);
    s2 = cmd.adjustStock(s2, { productId: egg, batchId: null, direction: 'out', quantity: 1, reason: 'loss', date: TODAY, note: '' }, c);
    expect(stockOnHand(s2, egg)).toBe(22);
    const losses = lossSummary(s2, { from: TODAY, to: TODAY });
    expect(losses.find((l) => l.reason === 'damage')?.quantity).toBe(2);
    expect(losses.find((l) => l.reason === 'loss')?.estValue).toBe(50_00);
  });

  it('prevents negative stock from adjustments and sales', () => {
    const { s, c, egg, meat, customer } = setup();
    expect(() =>
      cmd.adjustStock(s, { productId: egg, batchId: null, direction: 'out', quantity: 21, reason: 'damage', date: TODAY, note: '' }, c),
    ).toThrow(/Insufficient stock/);
    // Two lines for the same product are checked together.
    expect(() =>
      cmd.createSale(
        s,
        {
          id: 'x', date: TODAY, customerId: customer, walkInName: '', notes: '', payment: null,
          lines: [
            { productId: meat, batchId: null, quantity: 6, unitPrice: 70_00, discount: 0 },
            { productId: meat, batchId: null, quantity: 5, unitPrice: 70_00, discount: 0 },
          ],
        },
        c,
      ),
    ).toThrow(/Insufficient stock/);
    expect(stockOnHand(s, meat)).toBe(10.5);
  });

  it('requires a note for "other" adjustments and rejects decimal quantities for whole units', () => {
    const { s, c, egg, meat } = setup();
    expect(() =>
      cmd.adjustStock(s, { productId: egg, batchId: null, direction: 'out', quantity: 1, reason: 'other', date: TODAY, note: '' }, c),
    ).toThrow(/note/);
    expect(() =>
      cmd.adjustStock(s, { productId: egg, batchId: null, direction: 'in', quantity: 1.5, reason: 'restock', date: TODAY, note: '' }, c),
    ).toThrow(/whole number/);
    const s2 = cmd.adjustStock(s, { productId: meat, batchId: null, direction: 'in', quantity: 0.1, reason: 'production', date: TODAY, note: '' }, c);
    expect(stockOnHand(s2, meat)).toBe(10.6);
  });

  it('does not allow changing the unit once stock history exists', () => {
    const { s, c, egg } = setup();
    const p = s.products.find((x) => x.id === egg)!;
    expect(() => cmd.updateProduct(s, egg, { ...p, unit: 'eggs' }, c)).toThrow(/not convertible/);
  });

  it('reconciles inventory report with movements as at a date', () => {
    const { s, c, egg } = setup();
    const s2 = cmd.adjustStock(s, { productId: egg, batchId: null, direction: 'out', quantity: 3, reason: 'damage', date: TODAY, note: '' }, c);
    const row = inventoryAsOf(s2, '').find((r) => r.product.id === egg)!;
    expect(row.quantity).toBe(17);
    expect(row.valueAtSellingPrice).toBe(17 * 75_00);
    expect(inventoryAsOf(s2, '2026-10-19').find((r) => r.product.id === egg)!.quantity).toBe(0);
  });
});

describe('duplicate protection', () => {
  it('does not deduct stock twice when the same sale is submitted again', () => {
    const { s, c, egg, customer } = setup();
    const input: cmd.SaleInput = {
      id: 'same-sale',
      date: TODAY,
      customerId: customer,
      walkInName: '',
      notes: '',
      payment: { amount: 150_00, method: 'Cash', reference: '' },
      lines: [{ productId: egg, batchId: null, quantity: 2, unitPrice: 75_00, discount: 0 }],
    };
    const first = cmd.createSale(s, input, c);
    const second = cmd.createSale(first.state, input, c);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.state).toBe(first.state);
    expect(second.state.sales).toHaveLength(1);
    expect(second.state.payments).toHaveLength(1);
    expect(stockOnHand(second.state, egg)).toBe(18);
  });

  it('survives a reload: a repeated submission after persisting is still ignored', () => {
    const { s, c, egg, customer } = setup();
    const storage = memoryStorage();
    const store = new LocalDemoStore(storage, () => s);
    store.load();
    const input: cmd.SaleInput = {
      id: 'persisted-sale', date: TODAY, customerId: customer, walkInName: '', notes: '', payment: null,
      lines: [{ productId: egg, batchId: null, quantity: 4, unitPrice: 75_00, discount: 0 }],
    };
    store.apply((st) => cmd.createSale(st, input, c).state);
    // Simulate a page refresh: a fresh store instance reading the same storage.
    const reloaded = new LocalDemoStore(storage, () => emptyState());
    reloaded.apply((st) => cmd.createSale(st, input, c).state);
    expect(stockOnHand(reloaded.load(), egg)).toBe(16);
    expect(reloaded.load().sales).toHaveLength(1);
  });

  it('does not persist anything when a command fails', () => {
    const { s, c, egg } = setup();
    const store = new LocalDemoStore(memoryStorage(), () => s);
    const before = store.load();
    expect(() =>
      store.apply((st) =>
        cmd.adjustStock(st, { productId: egg, batchId: null, direction: 'out', quantity: 999, reason: 'loss', date: TODAY, note: '' }, c),
      ),
    ).toThrow();
    expect(store.load()).toEqual(before);
  });

  it('does not add purchase stock twice when confirmed again', () => {
    const { s, c, egg } = setup();
    const sup = cmd.createSupplier(s, { name: 'Supp', contactPerson: '', phone: '', email: '', notes: '' }, c);
    const p = cmd.createPurchase(sup.state, { id: 'pur-1', supplierId: sup.id, date: TODAY, lines: [{ productId: egg, quantity: 10, unitCost: 50_00 }], reference: '', notes: '' }, c);
    expect(stockOnHand(p.state, egg)).toBe(20); // draft does not move stock
    const confirmed = cmd.confirmPurchase(p.state, 'pur-1', c);
    expect(stockOnHand(confirmed, egg)).toBe(30);
    expect(() => cmd.confirmPurchase(confirmed, 'pur-1', c)).toThrow(/already been received/);
    // Resubmitting the create with the same id is a no-op.
    expect(cmd.createPurchase(confirmed, { id: 'pur-1', supplierId: sup.id, date: TODAY, lines: [{ productId: egg, quantity: 10, unitCost: 50_00 }], reference: '', notes: '' }, c).duplicate).toBe(true);
  });

  it('ignores a repeated payment submission', () => {
    const { s, c, egg, customer } = setup();
    const sale = cmd.createSale(s, { id: 's', date: TODAY, customerId: customer, walkInName: '', notes: '', payment: null, lines: [{ productId: egg, batchId: null, quantity: 2, unitPrice: 75_00, discount: 0 }] }, c);
    const pay = { id: 'pay-1', amount: 50_00, method: 'Cash', date: TODAY, reference: '' };
    const a = cmd.recordSalePayment(sale.state, 's', pay, c);
    const b = cmd.recordSalePayment(a.state, 's', pay, c);
    expect(b.duplicate).toBe(true);
    expect(customerBalance(b.state, customer)).toBe(100_00);
  });
});

describe('voiding sales', () => {
  it('returns stock and removes the sale from revenue, keeping history', () => {
    const { s, c, egg, customer } = setup();
    const r = cmd.createSale(s, { id: 's', date: TODAY, customerId: customer, walkInName: '', notes: '', payment: null, lines: [{ productId: egg, batchId: null, quantity: 5, unitPrice: 75_00, discount: 0 }] }, c);
    expect(stockOnHand(r.state, egg)).toBe(15);
    const v = cmd.voidSale(r.state, 's', 'Entered in error', c);
    expect(stockOnHand(v, egg)).toBe(20);
    expect(v.sales).toHaveLength(1);
    expect(customerBalance(v, customer)).toBe(0);
    expect(salesSummary(salesInRange(v, { from: '', to: '' })).revenue).toBe(0);
    expect(() => cmd.voidSale(v, 's', 'again', c)).toThrow(/already been voided/);
  });

  it('refuses to void a sale with payments', () => {
    const { s, c, egg } = setup();
    const r = cmd.createSale(s, { id: 's', date: TODAY, customerId: null, walkInName: '', notes: '', payment: { amount: 75_00, method: 'Cash', reference: '' }, lines: [{ productId: egg, batchId: null, quantity: 1, unitPrice: 75_00, discount: 0 }] }, c);
    expect(() => cmd.voidSale(r.state, 's', 'x', c)).toThrow(/payments recorded/);
  });
});

describe('poultry batches', () => {
  it('tracks intake, deaths, losses and sales with a traceable history', () => {
    let { s, c } = setup();
    const bird = cmd.createProduct(s, { name: 'Live broiler', category: 'Live birds', unit: 'birds', sellingPrice: 90_00, costPrice: null, lowStockThreshold: null, trackStock: true, openingStock: 0, date: TODAY }, c);
    s = bird.state;
    const b = cmd.createBatch(s, { name: 'Cycle 1', poultryType: 'Broiler', productId: bird.id, startDate: TODAY, initialQuantity: 100, startingCost: 900_00, notes: '' }, c);
    s = b.state;
    s = cmd.adjustStock(s, { productId: bird.id, batchId: b.id, direction: 'out', quantity: 4, reason: 'death', date: TODAY, note: '' }, c);
    s = cmd.adjustStock(s, { productId: bird.id, batchId: b.id, direction: 'out', quantity: 1, reason: 'loss', date: TODAY, note: '' }, c);
    s = cmd.createSale(s, { id: 'bs', date: TODAY, customerId: null, walkInName: '', notes: '', payment: { amount: 900_00, method: 'Cash', reference: '' }, lines: [{ productId: bird.id, batchId: b.id, quantity: 10, unitPrice: 90_00, discount: 0 }] }, c).state;
    const summary = batchSummary(s, s.batches[0]);
    expect(summary).toMatchObject({ current: 85, added: 100, deaths: 4, losses: 1, sold: 10, mortalityPct: 4 });
    expect(stockOnHand(s, bird.id)).toBe(85);
    expect(() =>
      cmd.createSale(s, { id: 'too-many', date: TODAY, customerId: null, walkInName: '', notes: '', payment: { amount: 86 * 90_00, method: 'Cash', reference: '' }, lines: [{ productId: bird.id, batchId: b.id, quantity: 86, unitPrice: 90_00, discount: 0 }] }, c),
    ).toThrow(/Insufficient stock|only/);
  });

  it('cannot create batches when tracking is disabled', () => {
    const { s, c, egg } = setup();
    const off = { ...s, settings: { ...s.settings, batchTrackingEnabled: false } };
    expect(() => cmd.createBatch(off, { name: 'x', poultryType: 'x', productId: egg, startDate: TODAY, initialQuantity: 1, startingCost: 0, notes: '' }, c)).toThrow(/switched off/);
  });
});

describe('expenses and reports', () => {
  it('totals expenses by category and within a date range', () => {
    let { s, c } = setup();
    const add = (id: string, date: string, category: string, amount: number) =>
      (s = cmd.createExpense(s, { id, date, category, description: 'x', amount, method: 'Cash', supplierId: null, reference: '' }, c).state);
    add('e1', '2026-10-01', 'Feed', 1_000_00);
    add('e2', '2026-10-15', 'Feed', 500_00);
    add('e3', '2026-10-15', 'Transport', 120_50);
    add('e4', '2026-09-30', 'Transport', 99_00);
    const rows = expensesByCategory(s, { from: '2026-10-01', to: '2026-10-31' });
    expect(rows).toEqual([
      { category: 'Feed', total: 1_500_00, count: 2 },
      { category: 'Transport', total: 120_50, count: 1 },
    ]);
    expect(() => cmd.createExpense(s, { id: 'e5', date: TODAY, category: 'Nope', description: 'x', amount: 1, method: 'Cash', supplierId: null, reference: '' }, c)).toThrow(/category/);
    expect(() => cmd.createExpense(s, { id: 'e6', date: TODAY, category: 'Feed', description: 'x', amount: 0, method: 'Cash', supplierId: null, reference: '' }, c)).toThrow(/greater than zero/);
    expect(cmd.deleteExpense(s, 'e1', c).expenses).toHaveLength(3);
  });

  it('distinguishes revenue, cash collected, receivables and expenses', () => {
    let { s, c, egg, customer } = setup();
    s = cmd.createSale(s, { id: 'a', date: TODAY, customerId: customer, walkInName: '', notes: '', payment: { amount: 50_00, method: 'Cash', reference: '' }, lines: [{ productId: egg, batchId: null, quantity: 2, unitPrice: 75_00, discount: 0 }] }, c).state;
    s = cmd.createExpense(s, { id: 'e', date: TODAY, category: 'Feed', description: 'feed', amount: 40_00, method: 'Cash', supplierId: null, reference: '' }, c).state;
    const perf = operatingPerformance(s, { from: TODAY, to: TODAY });
    expect(perf.revenue).toBe(150_00);
    expect(perf.cashIn).toBe(50_00);
    expect(perf.expenses).toBe(40_00);
    expect(perf.estimatedOperatingResult).toBe(110_00);
    expect(perf.estimatedNetCashFlow).toBe(10_00);
    expect(receivablesAsOf(s, TODAY)[0].outstanding).toBe(100_00);
    expect(receivablesAsOf(s, '2026-10-19')).toHaveLength(0);

    const d = dashboardMetrics(s, TODAY);
    expect(d.salesToday).toBe(150_00);
    expect(d.expensesToday).toBe(40_00);
    expect(d.collectedToday).toBe(50_00);
    expect(d.receivables).toBe(100_00);
  });

  it('escapes CSV values and neutralises formulas', () => {
    expect(toCSV(['a', 'b'], [['x,y', '=SUM(A1)'], ['he said "hi"', 3]])).toBe(
      'a,b\r\n"x,y",\'=SUM(A1)\r\n"he said ""hi""",3',
    );
  });
});

describe('settings', () => {
  it('blocks removing a category in use and validates currency', () => {
    const { s, c } = setup();
    expect(() => cmd.updateSettings(s, { productCategories: ['Live birds'] }, c)).toThrow(/is used by/);
    expect(() => cmd.updateSettings(s, { currency: 'rands' }, c)).toThrow(/3-letter/);
    const next = cmd.updateSettings(s, { currency: 'USD', locale: 'en-US' }, c);
    expect(next.settings.currency).toBe('USD');
  });
});

describe('demo data', () => {
  it('is internally consistent', () => {
    const s = buildDemoState(NOW);
    expect(s.isSampleData).toBe(true);
    expect(s.settings.currency).toBe(DEFAULT_SETTINGS.currency);
    expect(s.sales.length).toBeGreaterThan(10);
    // No product goes negative.
    for (const p of s.products) expect(stockOnHand(s, p.id)).toBeGreaterThanOrEqual(0);
    // Receivables equal the sum of per-customer balances.
    const perCustomer = s.customers.reduce((a, cu) => a + customerBalance(s, cu.id), 0);
    expect(totalReceivables(s)).toBe(perCustomer);
    // Dashboard figures are derived from the records.
    const d = dashboardMetrics(s, TODAY);
    const todays = s.sales.filter((x) => x.date === TODAY);
    expect(d.salesCountToday).toBe(todays.length);
    expect(d.expensesToday).toBe(s.expenses.filter((e) => e.date === TODAY).reduce((a, e) => a + e.amount, 0));
    // Deterministic.
    expect(buildDemoState(NOW).sales.map((x) => x.number)).toEqual(s.sales.map((x) => x.number));
  });
});
