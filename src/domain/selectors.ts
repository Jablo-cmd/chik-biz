// Derived values. Nothing here mutates state; every figure the UI shows is
// computed from the underlying records via these functions.

import { roundQty, sumQty } from './format';
import type {
  AppState,
  Cents,
  Customer,
  ID,
  PoultryBatch,
  Product,
  Purchase,
  PurchaseLine,
  Sale,
  SaleLine,
} from './types';

// ---------- Stock ----------

export function stockByProduct(state: Pick<AppState, 'movements'>): Map<ID, number> {
  const map = new Map<ID, number>();
  for (const m of state.movements) {
    map.set(m.productId, roundQty((map.get(m.productId) ?? 0) + m.quantity));
  }
  return map;
}

export function stockOnHand(state: Pick<AppState, 'movements'>, productId: ID): number {
  return sumQty(state.movements.filter((m) => m.productId === productId).map((m) => m.quantity));
}

export function batchQuantity(state: Pick<AppState, 'movements'>, batchId: ID): number {
  return sumQty(state.movements.filter((m) => m.batchId === batchId).map((m) => m.quantity));
}

export interface BatchSummary {
  current: number;
  added: number;
  deaths: number;
  losses: number;
  sold: number;
  /** Mortality as a percentage of all birds that entered the batch. */
  mortalityPct: number;
}

export function batchSummary(state: Pick<AppState, 'movements'>, batch: PoultryBatch): BatchSummary {
  const ms = state.movements.filter((m) => m.batchId === batch.id);
  const added = sumQty(ms.filter((m) => m.quantity > 0 && m.reason !== 'sale_void').map((m) => m.quantity));
  const deaths = -sumQty(ms.filter((m) => m.reason === 'death').map((m) => m.quantity));
  const losses = -sumQty(
    ms.filter((m) => ['loss', 'theft', 'damage'].includes(m.reason)).map((m) => m.quantity),
  );
  const sold = -sumQty(ms.filter((m) => m.reason === 'sale' || m.reason === 'sale_void').map((m) => m.quantity));
  const current = sumQty(ms.map((m) => m.quantity));
  return {
    current,
    added,
    deaths,
    losses,
    sold,
    mortalityPct: added > 0 ? Math.round((deaths / added) * 1000) / 10 : 0,
  };
}

export function lowStockThreshold(product: Product, defaultThreshold: number): number {
  return product.lowStockThreshold ?? defaultThreshold;
}

export type StockLevel = 'ok' | 'low' | 'out' | 'untracked';

export function stockLevel(product: Product, qty: number, defaultThreshold: number): StockLevel {
  if (!product.trackStock) return 'untracked';
  if (qty <= 0) return 'out';
  if (qty <= lowStockThreshold(product, defaultThreshold)) return 'low';
  return 'ok';
}

// ---------- Sales ----------

export function lineGross(line: Pick<SaleLine, 'quantity' | 'unitPrice'>): Cents {
  return Math.round(line.quantity * line.unitPrice);
}

export function lineTotal(line: Pick<SaleLine, 'quantity' | 'unitPrice' | 'discount'>): Cents {
  return lineGross(line) - line.discount;
}

export interface SaleTotals {
  subtotal: Cents;
  discount: Cents;
  total: Cents;
}

export function saleTotals(lines: Pick<SaleLine, 'quantity' | 'unitPrice' | 'discount'>[]): SaleTotals {
  const subtotal = lines.reduce((a, l) => a + lineGross(l), 0);
  const discount = lines.reduce((a, l) => a + l.discount, 0);
  return { subtotal, discount, total: subtotal - discount };
}

export function salePaid(state: Pick<AppState, 'payments'>, saleId: ID): Cents {
  return state.payments
    .filter((p) => p.saleId === saleId && p.direction === 'in')
    .reduce((a, p) => a + p.amount, 0);
}

export type PaymentStatus = 'paid' | 'partial' | 'unpaid';

export function paymentStatus(total: Cents, paid: Cents): PaymentStatus {
  if (paid >= total) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
}

export interface SaleView {
  sale: Sale;
  totals: SaleTotals;
  paid: Cents;
  balance: Cents;
  status: PaymentStatus;
  customerName: string;
}

export function saleView(state: AppState, sale: Sale, customers?: Map<ID, Customer>): SaleView {
  const totals = saleTotals(sale.lines);
  const paid = salePaid(state, sale.id);
  const customer = sale.customerId
    ? (customers?.get(sale.customerId) ?? state.customers.find((c) => c.id === sale.customerId))
    : undefined;
  const voided = sale.status === 'voided';
  return {
    sale,
    totals,
    paid,
    balance: voided ? 0 : totals.total - paid,
    status: paymentStatus(totals.total, paid),
    customerName: customer ? customer.name : sale.walkInName || 'Walk-in customer',
  };
}

export function allSaleViews(state: AppState): SaleView[] {
  const customers = new Map(state.customers.map((c) => [c.id, c]));
  return state.sales.map((s) => saleView(state, s, customers));
}

/** Outstanding amount owed by a customer across all completed sales. */
export function customerBalance(state: AppState, customerId: ID): Cents {
  return state.sales
    .filter((s) => s.customerId === customerId && s.status === 'completed')
    .reduce((a, s) => a + saleTotals(s.lines).total - salePaid(state, s.id), 0);
}

export function totalReceivables(state: AppState): Cents {
  return state.sales
    .filter((s) => s.status === 'completed')
    .reduce((a, s) => a + Math.max(0, saleTotals(s.lines).total - salePaid(state, s.id)), 0);
}

// ---------- Purchases ----------

export function purchaseTotal(lines: Pick<PurchaseLine, 'quantity' | 'unitCost'>[]): Cents {
  return lines.reduce((a, l) => a + Math.round(l.quantity * l.unitCost), 0);
}

export function purchasePaid(state: Pick<AppState, 'payments'>, purchaseId: ID): Cents {
  return state.payments
    .filter((p) => p.purchaseId === purchaseId && p.direction === 'out')
    .reduce((a, p) => a + p.amount, 0);
}

export function purchaseView(state: AppState, p: Purchase) {
  const total = purchaseTotal(p.lines);
  const paid = purchasePaid(state, p.id);
  return { purchase: p, total, paid, balance: total - paid, status: paymentStatus(total, paid) };
}
