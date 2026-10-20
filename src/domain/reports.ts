// Report and dashboard calculations. All figures are derived from records.

import { REASON_LABELS } from './commands';
import { addDays, inRange, roundQty } from './format';
import {
  allSaleViews,
  batchSummary,
  purchaseTotal,
  saleTotals,
  stockByProduct,
  stockLevel,
  totalReceivables,
  type SaleView,
  type StockLevel,
} from './selectors';
import type { AppState, Cents, ID, ISODate, MovementReason, Payment, Product, StockMovement } from './types';

export interface DateRange {
  from: ISODate | '';
  to: ISODate | '';
}

// ---------- Sales ----------

export function salesInRange(state: AppState, range: DateRange): SaleView[] {
  return allSaleViews(state)
    .filter((v) => inRange(v.sale.date, range.from, range.to))
    .sort((a, b) => (a.sale.date === b.sale.date ? b.sale.number.localeCompare(a.sale.number) : b.sale.date.localeCompare(a.sale.date)));
}

export function salesSummary(views: SaleView[]) {
  const completed = views.filter((v) => v.sale.status === 'completed');
  return {
    count: completed.length,
    voidedCount: views.length - completed.length,
    subtotal: completed.reduce((a, v) => a + v.totals.subtotal, 0),
    discount: completed.reduce((a, v) => a + v.totals.discount, 0),
    revenue: completed.reduce((a, v) => a + v.totals.total, 0),
    collectedOnTheseSales: completed.reduce((a, v) => a + v.paid, 0),
    outstandingOnTheseSales: completed.reduce((a, v) => a + Math.max(0, v.balance), 0),
  };
}

// ---------- Expenses ----------

export function expensesInRange(state: AppState, range: DateRange) {
  return state.expenses
    .filter((e) => inRange(e.date, range.from, range.to))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function expensesByCategory(state: AppState, range: DateRange): { category: string; total: Cents; count: number }[] {
  const map = new Map<string, { total: Cents; count: number }>();
  for (const e of expensesInRange(state, range)) {
    const cur = map.get(e.category) ?? { total: 0, count: 0 };
    map.set(e.category, { total: cur.total + e.amount, count: cur.count + 1 });
  }
  return [...map.entries()].map(([category, v]) => ({ category, ...v })).sort((a, b) => b.total - a.total);
}

// ---------- Payments ----------

export interface PaymentRow {
  payment: Payment;
  /** e.g. "Sale S-00012 · Customer" or "Purchase P-00002 · Supplier" */
  description: string;
}

export function paymentsInRange(state: AppState, range: DateRange): PaymentRow[] {
  const sales = new Map(state.sales.map((s) => [s.id, s]));
  const purchases = new Map(state.purchases.map((p) => [p.id, p]));
  const customers = new Map(state.customers.map((c) => [c.id, c]));
  const suppliers = new Map(state.suppliers.map((s) => [s.id, s]));
  return state.payments
    .filter((p) => inRange(p.date, range.from, range.to))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .map((payment) => {
      let description = '';
      if (payment.saleId) {
        const s = sales.get(payment.saleId);
        const who = s?.customerId ? customers.get(s.customerId)?.name : s?.walkInName || 'Walk-in customer';
        description = `Sale ${s?.number ?? '?'} · ${who ?? ''}`;
      } else if (payment.purchaseId) {
        const p = purchases.get(payment.purchaseId);
        description = `Purchase ${p?.number ?? '?'} · ${suppliers.get(p?.supplierId ?? '')?.name ?? ''}`;
      }
      return { payment, description };
    });
}

// ---------- Receivables ----------

export interface ReceivableRow {
  customerId: ID;
  name: string;
  invoiced: Cents;
  paid: Cents;
  outstanding: Cents;
  openSales: number;
  oldestOpenDate: ISODate | null;
}

/** Outstanding customer balances as at `asOf` (inclusive). Empty asOf = all time. */
export function receivablesAsOf(state: AppState, asOf: ISODate | ''): ReceivableRow[] {
  const rows = new Map<ID, ReceivableRow>();
  for (const sale of state.sales) {
    if (sale.status !== 'completed' || !sale.customerId) continue;
    if (asOf && sale.date > asOf) continue;
    const total = saleTotals(sale.lines).total;
    const paid = state.payments
      .filter((p) => p.saleId === sale.id && p.direction === 'in' && (!asOf || p.date <= asOf))
      .reduce((a, p) => a + p.amount, 0);
    const c = state.customers.find((x) => x.id === sale.customerId);
    const row = rows.get(sale.customerId) ?? {
      customerId: sale.customerId,
      name: c?.name ?? 'Unknown customer',
      invoiced: 0,
      paid: 0,
      outstanding: 0,
      openSales: 0,
      oldestOpenDate: null,
    };
    row.invoiced += total;
    row.paid += paid;
    row.outstanding += total - paid;
    if (total - paid > 0) {
      row.openSales += 1;
      if (!row.oldestOpenDate || sale.date < row.oldestOpenDate) row.oldestOpenDate = sale.date;
    }
    rows.set(sale.customerId, row);
  }
  return [...rows.values()].filter((r) => r.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
}

// ---------- Inventory ----------

export interface InventoryRow {
  product: Product;
  quantity: number;
  level: StockLevel;
  valueAtSellingPrice: Cents;
  valueAtCost: Cents | null;
}

/** Stock levels as at `asOf` (inclusive), derived from movements. */
export function inventoryAsOf(state: AppState, asOf: ISODate | '', includeArchived = false): InventoryRow[] {
  const movements = asOf ? state.movements.filter((m) => m.date <= asOf) : state.movements;
  const stock = stockByProduct({ movements });
  return state.products
    .filter((p) => includeArchived || !p.archived)
    .map((product) => {
      const quantity = stock.get(product.id) ?? 0;
      return {
        product,
        quantity,
        level: stockLevel(product, quantity, state.settings.defaultLowStockThreshold),
        valueAtSellingPrice: product.trackStock ? Math.round(Math.max(0, quantity) * product.sellingPrice) : 0,
        valueAtCost:
          product.trackStock && product.costPrice !== null ? Math.round(Math.max(0, quantity) * product.costPrice) : null,
      };
    })
    .sort((a, b) => a.product.name.localeCompare(b.product.name));
}

// ---------- Stock movements ----------

export const LOSS_REASONS: MovementReason[] = ['damage', 'loss', 'death', 'theft'];

export function movementsInRange(state: AppState, range: DateRange): StockMovement[] {
  return state.movements
    .filter((m) => inRange(m.date, range.from, range.to))
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}

export function lossSummary(state: AppState, range: DateRange) {
  const rows = new Map<string, { productId: ID; reason: MovementReason; quantity: number; estValue: Cents }>();
  for (const m of movementsInRange(state, range)) {
    if (!LOSS_REASONS.includes(m.reason)) continue;
    const key = `${m.productId}|${m.reason}`;
    const p = state.products.find((x) => x.id === m.productId);
    const unitValue = p?.costPrice ?? p?.sellingPrice ?? 0;
    const cur = rows.get(key) ?? { productId: m.productId, reason: m.reason, quantity: 0, estValue: 0 };
    cur.quantity = roundQty(cur.quantity - m.quantity);
    cur.estValue += Math.round(-m.quantity * unitValue);
    rows.set(key, cur);
  }
  return [...rows.values()].map((r) => ({
    ...r,
    productName: state.products.find((p) => p.id === r.productId)?.name ?? 'Unknown',
    reasonLabel: REASON_LABELS[r.reason],
  }));
}

// ---------- Operating performance ----------

export function operatingPerformance(state: AppState, range: DateRange) {
  const sales = salesSummary(salesInRange(state, range));
  const expenses = expensesInRange(state, range).reduce((a, e) => a + e.amount, 0);
  const stockPurchases = state.purchases
    .filter((p) => p.status === 'confirmed' && inRange(p.date, range.from, range.to))
    .reduce((a, p) => a + purchaseTotal(p.lines), 0);
  const payments = state.payments.filter((p) => inRange(p.date, range.from, range.to));
  const cashIn = payments.filter((p) => p.direction === 'in').reduce((a, p) => a + p.amount, 0);
  const supplierPaymentsOut = payments.filter((p) => p.direction === 'out').reduce((a, p) => a + p.amount, 0);
  const batchStartingCosts = state.batches
    .filter((b) => inRange(b.startDate, range.from, range.to))
    .reduce((a, b) => a + b.startingCost, 0);
  return {
    revenue: sales.revenue,
    discounts: sales.discount,
    cashIn,
    expenses,
    stockPurchases,
    supplierPaymentsOut,
    batchStartingCosts,
    /** Revenue − recorded expenses − stock received from suppliers − batch starting costs. */
    estimatedOperatingResult: sales.revenue - expenses - stockPurchases - batchStartingCosts,
    /** Cash collected − expenses (assumed paid when recorded) − supplier payments. */
    estimatedNetCashFlow: cashIn - expenses - supplierPaymentsOut,
  };
}

export const PERFORMANCE_ASSUMPTIONS = [
  'Revenue is the value of completed (non-voided) sales dated in the period, whether or not they have been paid.',
  'Expenses are recorded expenses dated in the period and are assumed to have been paid when recorded.',
  'Stock purchases are received supplier purchases dated in the period, counted in full when received — not when the stock is sold. This is not cost of goods sold.',
  'Batch starting costs are counted in the period the batch started, not spread over the batch life.',
  'Opening stock, unrecorded costs, depreciation, tax, owner drawings and stock still on hand at the end of the period are not taken into account.',
  'This is therefore an operating estimate for management purposes, not a statement of net profit.',
];

// ---------- Dashboard ----------

export function dashboardMetrics(state: AppState, today: ISODate) {
  const views = allSaleViews(state);
  const todaysSales = views.filter((v) => v.sale.date === today && v.sale.status === 'completed');
  const salesToday = todaysSales.reduce((a, v) => a + v.totals.total, 0);
  const expensesToday = state.expenses.filter((e) => e.date === today).reduce((a, e) => a + e.amount, 0);
  const collectedToday = state.payments
    .filter((p) => p.date === today && p.direction === 'in')
    .reduce((a, p) => a + p.amount, 0);
  const inventory = inventoryAsOf(state, '');
  const tracked = inventory.filter((r) => r.product.trackStock);
  const low = tracked.filter((r) => r.level === 'low');
  const out = tracked.filter((r) => r.level === 'out');

  const series: { date: ISODate; total: Cents; collected: Cents }[] = [];
  for (let i = 13; i >= 0; i--) {
    const date = addDays(today, -i);
    series.push({
      date,
      total: views
        .filter((v) => v.sale.date === date && v.sale.status === 'completed')
        .reduce((a, v) => a + v.totals.total, 0),
      collected: state.payments
        .filter((p) => p.date === date && p.direction === 'in')
        .reduce((a, p) => a + p.amount, 0),
    });
  }

  type Alert = { level: 'danger' | 'warning' | 'info'; message: string; href: string };
  const alerts: Alert[] = [];
  for (const r of out) {
    alerts.push({ level: 'danger', message: `${r.product.name} is out of stock`, href: '#/inventory' });
  }
  for (const r of low) {
    alerts.push({
      level: 'warning',
      message: `${r.product.name} is low: ${r.quantity} ${r.quantity === 1 ? r.product.unit.replace(/s$/, '') : r.product.unit} left`,
      href: '#/inventory',
    });
  }
  const overdueCutoff = addDays(today, -14);
  const overdue = views.filter((v) => v.sale.status === 'completed' && v.balance > 0 && v.sale.date < overdueCutoff);
  if (overdue.length > 0) {
    alerts.push({
      level: 'warning',
      message: `${overdue.length} credit sale${overdue.length === 1 ? ' has' : 's have'} been unpaid for more than 14 days`,
      href: '#/reports?tab=receivables',
    });
  }
  if (state.settings.batchTrackingEnabled) {
    for (const b of state.batches.filter((x) => x.status === 'active')) {
      const s = batchSummary(state, b);
      if (s.mortalityPct >= 5) {
        alerts.push({
          level: 'warning',
          message: `Batch ${b.reference} mortality is ${s.mortalityPct}%`,
          href: `#/batches/${b.id}`,
        });
      }
    }
  }
  const draftPurchases = state.purchases.filter((p) => p.status === 'draft').length;
  if (draftPurchases > 0) {
    alerts.push({
      level: 'info',
      message: `${draftPurchases} purchase${draftPurchases === 1 ? ' is' : 's are'} awaiting receipt into stock`,
      href: '#/suppliers?tab=purchases',
    });
  }

  return {
    salesToday,
    salesCountToday: todaysSales.length,
    expensesToday,
    collectedToday,
    receivables: totalReceivables(state),
    inventory: {
      trackedProducts: tracked.length,
      lowCount: low.length,
      outCount: out.length,
      valueAtSellingPrice: tracked.reduce((a, r) => a + r.valueAtSellingPrice, 0),
    },
    series,
    alerts,
  };
}

export interface ActivityItem {
  id: ID;
  date: ISODate;
  createdAt: string;
  kind: 'sale' | 'payment_in' | 'payment_out' | 'expense' | 'purchase';
  title: string;
  detail: string;
  amount: Cents;
  href: string;
}

export function recentActivity(state: AppState, limit = 8): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const v of allSaleViews(state)) {
    items.push({
      id: v.sale.id,
      date: v.sale.date,
      createdAt: v.sale.createdAt,
      kind: 'sale',
      title: `Sale ${v.sale.number}${v.sale.status === 'voided' ? ' (voided)' : ''}`,
      detail: v.customerName,
      amount: v.sale.status === 'voided' ? 0 : v.totals.total,
      href: `#/sales/${v.sale.id}`,
    });
  }
  for (const row of paymentsInRange(state, { from: '', to: '' })) {
    // Payments taken at the moment of sale are already represented by the sale.
    const sale = row.payment.saleId ? state.sales.find((s) => s.id === row.payment.saleId) : null;
    if (sale && sale.createdAt === row.payment.createdAt) continue;
    items.push({
      id: row.payment.id,
      date: row.payment.date,
      createdAt: row.payment.createdAt,
      kind: row.payment.direction === 'in' ? 'payment_in' : 'payment_out',
      title: row.payment.direction === 'in' ? 'Payment received' : 'Supplier payment',
      detail: row.description,
      amount: row.payment.amount,
      href: row.payment.saleId ? `#/sales/${row.payment.saleId}` : '#/suppliers?tab=purchases',
    });
  }
  for (const e of state.expenses) {
    items.push({
      id: e.id,
      date: e.date,
      createdAt: e.createdAt,
      kind: 'expense',
      title: e.description,
      detail: e.category,
      amount: e.amount,
      href: '#/expenses',
    });
  }
  for (const p of state.purchases.filter((x) => x.status !== 'cancelled')) {
    items.push({
      id: p.id,
      date: p.date,
      createdAt: p.createdAt,
      kind: 'purchase',
      title: `Purchase ${p.number}${p.status === 'draft' ? ' (draft)' : ''}`,
      detail: state.suppliers.find((s) => s.id === p.supplierId)?.name ?? '',
      amount: purchaseTotal(p.lines),
      href: '#/suppliers?tab=purchases',
    });
  }
  return items
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

// ---------- CSV ----------

export function toCSV(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
}

/** Plain decimal for CSV (no currency symbol, dot decimal separator). */
export function centsToDecimal(c: Cents): string {
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
