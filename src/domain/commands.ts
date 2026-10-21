// Business commands. Each command is a pure function that takes the current
// state plus input and returns a NEW state, or throws a DomainError when a
// business rule would be violated. Because a command either returns a full
// new state or throws, a sale's stock movements, payment and audit entry are
// always applied together or not at all.
//
// Creation commands for financial documents (sales, purchases, payments) take
// a client-generated `id` that acts as an idempotency key: submitting the same
// id twice returns the state unchanged with `duplicate: true` instead of
// recording the transaction (and stock movement) a second time.

import { isValidISODate, roundQty, sumQty } from './format';
import {
  batchQuantity,
  lineGross,
  purchasePaid,
  purchaseTotal,
  salePaid,
  saleTotals,
  stockOnHand,
} from './selectors';
import type {
  AppState,
  BusinessSettings,
  Cents,
  Customer,
  Expense,
  ID,
  ISODate,
  MovementReason,
  Payment,
  PoultryBatch,
  Product,
  Purchase,
  Sale,
  StockMovement,
  Supplier,
} from './types';

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface Ctx {
  now: Date;
  newId: () => ID;
}

export interface Result {
  state: AppState;
  id: ID;
  /** True when the command was a repeat submission and nothing changed. */
  duplicate: boolean;
}

function fail(message: string): never {
  throw new DomainError(message);
}

function stamp(ctx: Ctx): string {
  return ctx.now.toISOString();
}

function today(ctx: Ctx): ISODate {
  const d = ctx.now;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function audit(state: AppState, ctx: Ctx, action: string, summary: string): AppState {
  return {
    ...state,
    audit: [{ id: ctx.newId(), at: stamp(ctx), action, summary }, ...state.audit].slice(0, 1000),
  };
}

function requireText(value: string, label: string, max = 120): string {
  const v = value.trim();
  if (!v) fail(`${label} is required.`);
  if (v.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return v;
}

function optionalText(value: string | undefined, label: string, max = 500): string {
  const v = (value ?? '').trim();
  if (v.length > max) fail(`${label} must be ${max} characters or fewer.`);
  return v;
}

function requireDate(date: string, ctx: Ctx, label = 'Date'): ISODate {
  if (!isValidISODate(date)) fail(`${label} is not a valid date.`);
  if (date > today(ctx)) fail(`${label} cannot be in the future.`);
  return date;
}

function requireMoney(value: Cents, label: string, { allowZero = true } = {}): Cents {
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a valid, non-negative amount.`);
  if (!allowZero && value === 0) fail(`${label} must be greater than zero.`);
  if (value > 100_000_000_00) fail(`${label} is unrealistically large.`);
  return value;
}

function unitDef(state: AppState, unit: string) {
  return state.settings.units.find((u) => u.name === unit);
}

function requireQuantity(state: AppState, unit: string, qty: number, label = 'Quantity'): number {
  if (!Number.isFinite(qty) || qty <= 0) fail(`${label} must be greater than zero.`);
  const def = unitDef(state, unit);
  const allowDecimal = def ? def.allowDecimal : false;
  if (!allowDecimal && !Number.isInteger(qty)) {
    fail(`${label} must be a whole number of ${unit}.`);
  }
  return roundQty(qty);
}

function requireProduct(state: AppState, id: ID, { allowArchived = false } = {}): Product {
  const p = state.products.find((x) => x.id === id);
  if (!p) fail('Product not found.');
  if (p.archived && !allowArchived) fail(`"${p.name}" is archived.`);
  return p;
}

function requirePaymentMethod(state: AppState, method: string): string {
  if (!state.settings.paymentMethods.includes(method)) fail('Choose a valid payment method.');
  return method;
}

function movement(
  ctx: Ctx,
  m: Omit<StockMovement, 'id' | 'createdAt'>,
): StockMovement {
  return { ...m, id: ctx.newId(), createdAt: stamp(ctx) };
}

// ===================== Settings =====================

export const MAX_LOGO_BYTES = 300_000;

export function updateSettings(state: AppState, patch: Partial<BusinessSettings>, ctx: Ctx): AppState {
  const next: BusinessSettings = { ...state.settings, ...patch };
  next.businessName = requireText(next.businessName, 'Business name', 80);
  next.address = optionalText(next.address, 'Address');
  next.phone = optionalText(next.phone, 'Phone', 40);
  next.email = optionalText(next.email, 'Email', 120);
  if (!/^[A-Z]{3}$/.test(next.currency)) fail('Currency must be a 3-letter ISO code, e.g. ZAR.');
  try {
    new Intl.NumberFormat(next.locale, { style: 'currency', currency: next.currency });
  } catch {
    fail('Currency or locale is not supported by this browser.');
  }
  if (next.logoDataUrl && next.logoDataUrl.length > MAX_LOGO_BYTES * 1.4) {
    fail('Logo image is too large. Use an image under 300 KB.');
  }
  if (!Number.isFinite(next.defaultLowStockThreshold) || next.defaultLowStockThreshold < 0) {
    fail('Low-stock threshold must be zero or more.');
  }
  if (!Number.isFinite(next.maxDiscountPercent) || next.maxDiscountPercent < 0 || next.maxDiscountPercent > 100) {
    fail('Maximum discount must be between 0 and 100%.');
  }
  const lists: [keyof BusinessSettings, string[], string][] = [
    ['productCategories', next.productCategories, 'product category'],
    ['expenseCategories', next.expenseCategories, 'expense category'],
    ['paymentMethods', next.paymentMethods, 'payment method'],
  ];
  for (const [, list, label] of lists) {
    if (list.length === 0) fail(`Keep at least one ${label}.`);
    if (new Set(list.map((x) => x.toLowerCase())).size !== list.length) fail(`Duplicate ${label} names.`);
    if (list.some((x) => !x.trim())) fail(`A ${label} name is empty.`);
  }
  if (next.units.length === 0) fail('Keep at least one unit.');
  if (new Set(next.units.map((u) => u.name.toLowerCase())).size !== next.units.length) fail('Duplicate unit names.');

  // Prevent removing a category/unit/method that active records still use.
  const activeProducts = state.products.filter((p) => !p.archived);
  for (const p of activeProducts) {
    if (!next.productCategories.includes(p.category)) {
      fail(`Category "${p.category}" is used by "${p.name}". Re-categorise or archive it first.`);
    }
    if (!next.units.some((u) => u.name === p.unit)) {
      fail(`Unit "${p.unit}" is used by "${p.name}". It cannot be removed.`);
    }
  }
  // A unit's decimal rule cannot be tightened if existing stock is fractional.
  for (const u of next.units) {
    if (u.allowDecimal) continue;
    const fractional = state.products.find(
      (p) => p.unit === u.name && !Number.isInteger(stockOnHand(state, p.id)),
    );
    if (fractional) fail(`"${fractional.name}" has a fractional stock quantity, so "${u.name}" must allow decimals.`);
  }

  return audit({ ...state, settings: next }, ctx, 'settings.update', 'Business settings updated');
}

// ===================== Products & stock =====================

export interface ProductInput {
  name: string;
  category: string;
  unit: string;
  sellingPrice: Cents;
  costPrice: Cents | null;
  lowStockThreshold: number | null;
  trackStock: boolean;
}

function validateProduct(state: AppState, input: ProductInput, existing?: Product): ProductInput {
  const name = requireText(input.name, 'Product name', 80);
  const dup = state.products.find(
    (p) => p.id !== existing?.id && !p.archived && p.name.toLowerCase() === name.toLowerCase(),
  );
  if (dup) fail(`A product called "${name}" already exists.`);
  if (!state.settings.productCategories.includes(input.category) && input.category !== existing?.category) {
    fail('Choose a valid category.');
  }
  if (!unitDef(state, input.unit)) fail('Choose a valid unit.');
  requireMoney(input.sellingPrice, 'Selling price');
  if (input.costPrice !== null) requireMoney(input.costPrice, 'Cost price');
  if (input.lowStockThreshold !== null && (!Number.isFinite(input.lowStockThreshold) || input.lowStockThreshold < 0)) {
    fail('Low-stock threshold must be zero or more.');
  }
  return { ...input, name };
}

export function createProduct(
  state: AppState,
  input: ProductInput & { openingStock: number; date: ISODate; id?: ID },
  ctx: Ctx,
): Result {
  const v = validateProduct(state, input);
  const id = input.id ?? ctx.newId();
  const product: Product = { ...v, id, archived: false, createdAt: stamp(ctx) };
  let movements = state.movements;
  if (input.openingStock !== 0) {
    if (!v.trackStock) fail('Opening stock only applies to products with stock tracking.');
    const qty = requireQuantity(state, v.unit, input.openingStock, 'Opening stock');
    movements = [
      ...movements,
      movement(ctx, {
        productId: id,
        batchId: null,
        quantity: qty,
        reason: 'opening',
        date: requireDate(input.date, ctx),
        note: 'Opening stock',
        ref: null,
      }),
    ];
  }
  const next = audit(
    { ...state, products: [...state.products, product], movements },
    ctx,
    'product.create',
    `Product "${v.name}" created`,
  );
  return { state: next, id, duplicate: false };
}

export function updateProduct(state: AppState, id: ID, input: ProductInput, ctx: Ctx): AppState {
  const existing = requireProduct(state, id, { allowArchived: true });
  const v = validateProduct(state, input, existing);
  const hasHistory = state.movements.some((m) => m.productId === id);
  if (v.unit !== existing.unit && hasHistory) {
    fail(
      'The unit cannot be changed once stock has been recorded — quantities are not convertible between units. Create a new product instead.',
    );
  }
  if (!v.trackStock && existing.trackStock && stockOnHand(state, id) !== 0) {
    fail('Stock tracking cannot be switched off while stock is on hand.');
  }
  if (!v.trackStock && state.batches.some((b) => b.productId === id)) {
    fail('This product is used by a poultry batch and must track stock.');
  }
  const products = state.products.map((p) => (p.id === id ? { ...p, ...v } : p));
  return audit({ ...state, products }, ctx, 'product.update', `Product "${v.name}" updated`);
}

export function setProductArchived(state: AppState, id: ID, archived: boolean, ctx: Ctx): AppState {
  const p = requireProduct(state, id, { allowArchived: true });
  if (!archived) {
    const dup = state.products.find(
      (x) => x.id !== id && !x.archived && x.name.toLowerCase() === p.name.toLowerCase(),
    );
    if (dup) fail(`An active product called "${p.name}" already exists.`);
  }
  if (archived && state.batches.some((b) => b.productId === id && b.status === 'active')) {
    fail('Close the active poultry batches for this product before archiving it.');
  }
  const products = state.products.map((x) => (x.id === id ? { ...x, archived } : x));
  return audit(
    { ...state, products },
    ctx,
    archived ? 'product.archive' : 'product.restore',
    `Product "${p.name}" ${archived ? 'archived' : 'restored'}`,
  );
}

export const STOCK_IN_REASONS: MovementReason[] = ['restock', 'production', 'count_correction', 'other'];
export const STOCK_OUT_REASONS: MovementReason[] = [
  'damage',
  'loss',
  'death',
  'theft',
  'own_use',
  'count_correction',
  'other',
];

export const REASON_LABELS: Record<MovementReason, string> = {
  opening: 'Opening stock',
  purchase: 'Purchase received',
  sale: 'Sale',
  sale_void: 'Sale voided (returned)',
  restock: 'Restock / received',
  batch_intake: 'Batch intake',
  production: 'Produced / collected',
  damage: 'Damaged',
  loss: 'Lost / missing',
  death: 'Death (mortality)',
  theft: 'Theft',
  own_use: 'Own use / samples',
  count_correction: 'Stock count correction',
  other: 'Other',
};

export interface AdjustmentInput {
  productId: ID;
  batchId: ID | null;
  direction: 'in' | 'out';
  quantity: number;
  reason: MovementReason;
  date: ISODate;
  note: string;
}

export function adjustStock(state: AppState, input: AdjustmentInput, ctx: Ctx): AppState {
  const p = requireProduct(state, input.productId);
  if (!p.trackStock) fail(`"${p.name}" does not track stock.`);
  const allowed = input.direction === 'in' ? STOCK_IN_REASONS : STOCK_OUT_REASONS;
  if (!allowed.includes(input.reason)) fail('Choose a valid reason for this adjustment.');
  const qty = requireQuantity(state, p.unit, input.quantity);
  const date = requireDate(input.date, ctx);
  const note = optionalText(input.note, 'Note', 300);
  if (['other', 'count_correction'].includes(input.reason) && !note) {
    fail('Add a note explaining this adjustment.');
  }

  let batch: PoultryBatch | undefined;
  if (input.batchId) {
    batch = state.batches.find((b) => b.id === input.batchId);
    if (!batch || batch.productId !== p.id) fail('Batch does not belong to this product.');
    if (batch.status !== 'active') fail(`Batch ${batch.reference} is closed.`);
  }
  if (input.reason === 'death' && !batch && !['birds'].includes(p.unit)) {
    // Deaths only make sense for live birds; allow when the unit is birds.
    fail('Deaths can only be recorded for live birds.');
  }

  if (input.direction === 'out') {
    const onHand = stockOnHand(state, p.id);
    if (qty > onHand) {
      fail(`Insufficient stock: only ${onHand} ${p.unit} of "${p.name}" on hand.`);
    }
    if (batch) {
      const inBatch = batchQuantity(state, batch.id);
      if (qty > inBatch) fail(`Batch ${batch.reference} only has ${inBatch} ${p.unit}.`);
    }
  }

  const m = movement(ctx, {
    productId: p.id,
    batchId: batch?.id ?? null,
    quantity: input.direction === 'in' ? qty : -qty,
    reason: input.reason,
    date,
    note,
    ref: batch ? { kind: 'batch', id: batch.id } : { kind: 'adjustment', id: p.id },
  });
  return audit(
    { ...state, movements: [...state.movements, m] },
    ctx,
    'stock.adjust',
    `${input.direction === 'in' ? '+' : '−'}${qty} ${p.unit} ${p.name} (${REASON_LABELS[input.reason]})${batch ? ` · ${batch.reference}` : ''}`,
  );
}

// ===================== Poultry batches =====================

export interface BatchInput {
  name: string;
  poultryType: string;
  productId: ID;
  startDate: ISODate;
  initialQuantity: number;
  startingCost: Cents;
  notes: string;
}

export function createBatch(state: AppState, input: BatchInput & { id?: ID }, ctx: Ctx): Result {
  if (!state.settings.batchTrackingEnabled) fail('Batch tracking is switched off in Settings.');
  const p = requireProduct(state, input.productId);
  if (!p.trackStock) fail('The batch product must track stock.');
  const unit = unitDef(state, p.unit);
  if (unit?.allowDecimal) fail('Batches must use a product counted in whole units (e.g. birds).');
  const name = requireText(input.name, 'Batch name', 80);
  const poultryType = requireText(input.poultryType, 'Poultry type', 60);
  const qty = requireQuantity(state, p.unit, input.initialQuantity, 'Initial quantity');
  const startDate = requireDate(input.startDate, ctx, 'Start date');
  requireMoney(input.startingCost, 'Starting cost');
  const n = state.counters.batch + 1;
  const id = input.id ?? ctx.newId();
  const batch: PoultryBatch = {
    id,
    reference: `B-${String(n).padStart(3, '0')}`,
    name,
    poultryType,
    productId: p.id,
    startDate,
    initialQuantity: qty,
    startingCost: input.startingCost,
    status: 'active',
    notes: optionalText(input.notes, 'Notes'),
    createdAt: stamp(ctx),
  };
  const m = movement(ctx, {
    productId: p.id,
    batchId: id,
    quantity: qty,
    reason: 'batch_intake',
    date: startDate,
    note: `Batch ${batch.reference} intake`,
    ref: { kind: 'batch', id },
  });
  const next = audit(
    {
      ...state,
      batches: [...state.batches, batch],
      movements: [...state.movements, m],
      counters: { ...state.counters, batch: n },
    },
    ctx,
    'batch.create',
    `Batch ${batch.reference} "${name}" started with ${qty} ${p.unit}`,
  );
  return { state: next, id, duplicate: false };
}

export function updateBatch(
  state: AppState,
  id: ID,
  input: Pick<BatchInput, 'name' | 'poultryType' | 'startingCost' | 'notes'>,
  ctx: Ctx,
): AppState {
  const b = state.batches.find((x) => x.id === id);
  if (!b) fail('Batch not found.');
  const name = requireText(input.name, 'Batch name', 80);
  const poultryType = requireText(input.poultryType, 'Poultry type', 60);
  requireMoney(input.startingCost, 'Starting cost');
  const batches = state.batches.map((x) =>
    x.id === id
      ? { ...x, name, poultryType, startingCost: input.startingCost, notes: optionalText(input.notes, 'Notes') }
      : x,
  );
  return audit({ ...state, batches }, ctx, 'batch.update', `Batch ${b.reference} updated`);
}

export function setBatchStatus(state: AppState, id: ID, status: PoultryBatch['status'], ctx: Ctx): AppState {
  const b = state.batches.find((x) => x.id === id);
  if (!b) fail('Batch not found.');
  if (status === 'active' && requireProduct(state, b.productId, { allowArchived: true }).archived) {
    fail('Restore the batch product before reopening this batch.');
  }
  const batches = state.batches.map((x) => (x.id === id ? { ...x, status } : x));
  return audit(
    { ...state, batches },
    ctx,
    status === 'closed' ? 'batch.close' : 'batch.reopen',
    `Batch ${b.reference} ${status === 'closed' ? 'closed' : 'reopened'}`,
  );
}

// ===================== Customers =====================

export interface CustomerInput {
  name: string;
  businessName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

function validateCustomer(input: CustomerInput): CustomerInput {
  const email = optionalText(input.email, 'Email', 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email address is not valid.');
  const phone = optionalText(input.phone, 'Phone', 40);
  if (phone && !/^[+()\d\s-]{6,}$/.test(phone)) fail('Phone number is not valid.');
  return {
    name: requireText(input.name, 'Customer name', 80),
    businessName: optionalText(input.businessName, 'Business name', 80),
    phone,
    email,
    address: optionalText(input.address, 'Address'),
    notes: optionalText(input.notes, 'Notes'),
  };
}

export function createCustomer(state: AppState, input: CustomerInput & { id?: ID }, ctx: Ctx): Result {
  const v = validateCustomer(input);
  const id = input.id ?? ctx.newId();
  const c: Customer = { ...v, id, archived: false, createdAt: stamp(ctx) };
  const next = audit({ ...state, customers: [...state.customers, c] }, ctx, 'customer.create', `Customer "${v.name}" added`);
  return { state: next, id, duplicate: false };
}

export function updateCustomer(state: AppState, id: ID, input: CustomerInput, ctx: Ctx): AppState {
  if (!state.customers.some((c) => c.id === id)) fail('Customer not found.');
  const v = validateCustomer(input);
  const customers = state.customers.map((c) => (c.id === id ? { ...c, ...v } : c));
  return audit({ ...state, customers }, ctx, 'customer.update', `Customer "${v.name}" updated`);
}

export function setCustomerArchived(state: AppState, id: ID, archived: boolean, ctx: Ctx): AppState {
  const c = state.customers.find((x) => x.id === id);
  if (!c) fail('Customer not found.');
  const customers = state.customers.map((x) => (x.id === id ? { ...x, archived } : x));
  return audit(
    { ...state, customers },
    ctx,
    archived ? 'customer.archive' : 'customer.restore',
    `Customer "${c.name}" ${archived ? 'archived' : 'restored'}`,
  );
}

// ===================== Sales & payments =====================

export interface SaleLineInput {
  productId: ID;
  batchId: ID | null;
  quantity: number;
  unitPrice: Cents;
  discount: Cents;
}

export interface SaleInput {
  /** Idempotency key generated when the sale form was opened. */
  id: ID;
  date: ISODate;
  customerId: ID | null;
  walkInName: string;
  lines: SaleLineInput[];
  notes: string;
  payment: { amount: Cents; method: string; reference: string } | null;
}

export function createSale(state: AppState, input: SaleInput, ctx: Ctx): Result {
  if (!input.id) fail('Missing sale reference.');
  if (state.sales.some((s) => s.id === input.id)) {
    return { state, id: input.id, duplicate: true };
  }
  const date = requireDate(input.date, ctx, 'Sale date');
  if (input.customerId) {
    const c = state.customers.find((x) => x.id === input.customerId);
    if (!c) fail('Customer not found.');
    if (c.archived) fail(`Customer "${c.name}" is archived.`);
  }
  if (input.lines.length === 0) fail('Add at least one item to the sale.');
  if (input.lines.length > 100) fail('A sale can have at most 100 lines.');

  const maxPct = state.settings.maxDiscountPercent;
  const requiredByProduct = new Map<ID, number>();
  const requiredByBatch = new Map<ID, number>();
  const lines = input.lines.map((l, i) => {
    const label = `Line ${i + 1}`;
    const p = requireProduct(state, l.productId);
    const qty = requireQuantity(state, p.unit, l.quantity, `${label} quantity`);
    requireMoney(l.unitPrice, `${label} unit price`);
    requireMoney(l.discount, `${label} discount`);
    const gross = lineGross({ quantity: qty, unitPrice: l.unitPrice });
    if (l.discount > gross) fail(`${label}: discount cannot exceed the line value.`);
    if (l.discount > Math.floor((gross * maxPct) / 100)) {
      fail(`${label}: discount exceeds the permitted maximum of ${maxPct}%.`);
    }
    if (l.batchId) {
      const b = state.batches.find((x) => x.id === l.batchId);
      if (!b || b.productId !== p.id) fail(`${label}: batch does not match the product.`);
      if (b.status !== 'active') fail(`${label}: batch ${b.reference} is closed.`);
      requiredByBatch.set(b.id, roundQty((requiredByBatch.get(b.id) ?? 0) + qty));
    }
    if (p.trackStock) requiredByProduct.set(p.id, roundQty((requiredByProduct.get(p.id) ?? 0) + qty));
    return {
      productId: p.id,
      batchId: l.batchId ?? null,
      description: p.name,
      unit: p.unit,
      quantity: qty,
      unitPrice: l.unitPrice,
      discount: l.discount,
    };
  });

  for (const [productId, qty] of requiredByProduct) {
    const onHand = stockOnHand(state, productId);
    if (qty > onHand) {
      const p = state.products.find((x) => x.id === productId)!;
      fail(`Insufficient stock for "${p.name}": ${onHand} ${p.unit} available, ${qty} requested.`);
    }
  }
  for (const [batchId, qty] of requiredByBatch) {
    const available = batchQuantity(state, batchId);
    if (qty > available) {
      const b = state.batches.find((x) => x.id === batchId)!;
      fail(`Batch ${b.reference} has only ${available} available, ${qty} requested.`);
    }
  }

  const totals = saleTotals(lines);
  const n = state.counters.sale + 1;
  const sale: Sale = {
    id: input.id,
    number: `S-${String(n).padStart(5, '0')}`,
    date,
    customerId: input.customerId,
    walkInName: input.customerId ? '' : optionalText(input.walkInName, 'Walk-in name', 80),
    lines,
    status: 'completed',
    notes: optionalText(input.notes, 'Notes'),
    voidReason: '',
    createdAt: stamp(ctx),
  };

  const newMovements = lines
    .filter((l) => requiredByProduct.has(l.productId))
    .map((l) =>
      movement(ctx, {
        productId: l.productId,
        batchId: l.batchId,
        quantity: -l.quantity,
        reason: 'sale',
        date,
        note: `Sale ${sale.number}`,
        ref: { kind: 'sale', id: sale.id },
      }),
    );

  const payments: Payment[] = [];
  if (input.payment && input.payment.amount > 0) {
    requireMoney(input.payment.amount, 'Amount paid');
    if (input.payment.amount > totals.total) {
      fail('Amount paid cannot exceed the sale total. Record change given separately.');
    }
    if (!input.customerId && input.payment.amount < totals.total) {
      fail('Walk-in sales must be paid in full. Select a customer to sell on credit.');
    }
    payments.push({
      id: ctx.newId(),
      direction: 'in',
      date,
      amount: input.payment.amount,
      method: requirePaymentMethod(state, input.payment.method),
      saleId: sale.id,
      purchaseId: null,
      reference: optionalText(input.payment.reference, 'Payment reference', 80),
      createdAt: stamp(ctx),
    });
  } else if (!input.customerId && totals.total > 0) {
    fail('Walk-in sales must be paid in full. Select a customer to sell on credit.');
  }

  const next = audit(
    {
      ...state,
      sales: [...state.sales, sale],
      movements: [...state.movements, ...newMovements],
      payments: [...state.payments, ...payments],
      counters: { ...state.counters, sale: n },
    },
    ctx,
    'sale.create',
    `Sale ${sale.number} recorded (${lines.length} line${lines.length === 1 ? '' : 's'})`,
  );
  return { state: next, id: sale.id, duplicate: false };
}

export interface PaymentInput {
  /** Idempotency key generated when the payment form was opened. */
  id: ID;
  amount: Cents;
  method: string;
  date: ISODate;
  reference: string;
}

export function recordSalePayment(state: AppState, saleId: ID, input: PaymentInput, ctx: Ctx): Result {
  if (state.payments.some((p) => p.id === input.id)) return { state, id: input.id, duplicate: true };
  const sale = state.sales.find((s) => s.id === saleId);
  if (!sale) fail('Sale not found.');
  if (sale.status === 'voided') fail('Cannot take payment for a voided sale.');
  const amount = requireMoney(input.amount, 'Payment amount', { allowZero: false });
  const balance = saleTotals(sale.lines).total - salePaid(state, saleId);
  if (balance <= 0) fail('This sale is already paid in full.');
  if (amount > balance) fail('Payment exceeds the outstanding balance on this sale.');
  const date = requireDate(input.date, ctx, 'Payment date');
  if (date < sale.date) fail('Payment date cannot be before the sale date.');
  const payment: Payment = {
    id: input.id,
    direction: 'in',
    date,
    amount,
    method: requirePaymentMethod(state, input.method),
    saleId,
    purchaseId: null,
    reference: optionalText(input.reference, 'Reference', 80),
    createdAt: stamp(ctx),
  };
  const next = audit(
    { ...state, payments: [...state.payments, payment] },
    ctx,
    'payment.receive',
    `Payment received for ${sale.number}`,
  );
  return { state: next, id: payment.id, duplicate: false };
}

export function voidSale(state: AppState, saleId: ID, reason: string, ctx: Ctx): AppState {
  const sale = state.sales.find((s) => s.id === saleId);
  if (!sale) fail('Sale not found.');
  if (sale.status === 'voided') fail('This sale has already been voided.');
  if (salePaid(state, saleId) > 0) {
    fail('This sale has payments recorded. Payments must be refunded outside the system before voiding (not supported in this prototype).');
  }
  const why = requireText(reason, 'Reason for voiding', 200);
  const reversals = state.movements
    .filter((m) => m.ref?.kind === 'sale' && m.ref.id === saleId && m.reason === 'sale')
    .map((m) =>
      movement(ctx, {
        productId: m.productId,
        batchId: m.batchId,
        quantity: -m.quantity,
        reason: 'sale_void',
        date: today(ctx),
        note: `Sale ${sale.number} voided`,
        ref: { kind: 'sale', id: saleId },
      }),
    );
  const sales = state.sales.map((s) => (s.id === saleId ? { ...s, status: 'voided' as const, voidReason: why } : s));
  return audit(
    { ...state, sales, movements: [...state.movements, ...reversals] },
    ctx,
    'sale.void',
    `Sale ${sale.number} voided: ${why}`,
  );
}

// ===================== Expenses =====================

export interface ExpenseInput {
  date: ISODate;
  category: string;
  description: string;
  amount: Cents;
  method: string;
  supplierId: ID | null;
  reference: string;
}

function validateExpense(state: AppState, input: ExpenseInput, ctx: Ctx, existing?: Expense): ExpenseInput {
  if (!state.settings.expenseCategories.includes(input.category) && input.category !== existing?.category) {
    fail('Choose a valid expense category.');
  }
  if (input.supplierId && !state.suppliers.some((s) => s.id === input.supplierId)) fail('Supplier not found.');
  return {
    date: requireDate(input.date, ctx),
    category: input.category,
    description: requireText(input.description, 'Description', 160),
    amount: requireMoney(input.amount, 'Amount', { allowZero: false }),
    method: requirePaymentMethod(state, input.method),
    supplierId: input.supplierId,
    reference: optionalText(input.reference, 'Reference', 80),
  };
}

export function createExpense(state: AppState, input: ExpenseInput & { id: ID }, ctx: Ctx): Result {
  if (state.expenses.some((e) => e.id === input.id)) return { state, id: input.id, duplicate: true };
  const v = validateExpense(state, input, ctx);
  const e: Expense = { ...v, id: input.id, createdAt: stamp(ctx) };
  const next = audit({ ...state, expenses: [...state.expenses, e] }, ctx, 'expense.create', `Expense "${v.description}" recorded`);
  return { state: next, id: e.id, duplicate: false };
}

export function updateExpense(state: AppState, id: ID, input: ExpenseInput, ctx: Ctx): AppState {
  const existing = state.expenses.find((e) => e.id === id);
  if (!existing) fail('Expense not found.');
  const v = validateExpense(state, input, ctx, existing);
  const expenses = state.expenses.map((e) => (e.id === id ? { ...e, ...v } : e));
  return audit({ ...state, expenses }, ctx, 'expense.update', `Expense "${v.description}" updated`);
}

export function deleteExpense(state: AppState, id: ID, ctx: Ctx): AppState {
  const e = state.expenses.find((x) => x.id === id);
  if (!e) fail('Expense not found.');
  return audit(
    { ...state, expenses: state.expenses.filter((x) => x.id !== id) },
    ctx,
    'expense.delete',
    `Expense "${e.description}" (${e.date}, ${(e.amount / 100).toFixed(2)}) deleted`,
  );
}

// ===================== Suppliers & purchases =====================

export interface SupplierInput {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  notes: string;
}

function validateSupplier(input: SupplierInput): SupplierInput {
  const email = optionalText(input.email, 'Email', 120);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Email address is not valid.');
  const phone = optionalText(input.phone, 'Phone', 40);
  if (phone && !/^[+()\d\s-]{6,}$/.test(phone)) fail('Phone number is not valid.');
  return {
    name: requireText(input.name, 'Supplier name', 80),
    contactPerson: optionalText(input.contactPerson, 'Contact person', 80),
    phone,
    email,
    notes: optionalText(input.notes, 'Notes'),
  };
}

export function createSupplier(state: AppState, input: SupplierInput & { id?: ID }, ctx: Ctx): Result {
  const v = validateSupplier(input);
  const id = input.id ?? ctx.newId();
  const s: Supplier = { ...v, id, archived: false, createdAt: stamp(ctx) };
  const next = audit({ ...state, suppliers: [...state.suppliers, s] }, ctx, 'supplier.create', `Supplier "${v.name}" added`);
  return { state: next, id, duplicate: false };
}

export function updateSupplier(state: AppState, id: ID, input: SupplierInput, ctx: Ctx): AppState {
  if (!state.suppliers.some((s) => s.id === id)) fail('Supplier not found.');
  const v = validateSupplier(input);
  const suppliers = state.suppliers.map((s) => (s.id === id ? { ...s, ...v } : s));
  return audit({ ...state, suppliers }, ctx, 'supplier.update', `Supplier "${v.name}" updated`);
}

export function setSupplierArchived(state: AppState, id: ID, archived: boolean, ctx: Ctx): AppState {
  const s = state.suppliers.find((x) => x.id === id);
  if (!s) fail('Supplier not found.');
  const suppliers = state.suppliers.map((x) => (x.id === id ? { ...x, archived } : x));
  return audit(
    { ...state, suppliers },
    ctx,
    archived ? 'supplier.archive' : 'supplier.restore',
    `Supplier "${s.name}" ${archived ? 'archived' : 'restored'}`,
  );
}

export interface PurchaseLineInput {
  productId: ID;
  quantity: number;
  unitCost: Cents;
}

export interface PurchaseInput {
  id: ID;
  supplierId: ID;
  date: ISODate;
  lines: PurchaseLineInput[];
  reference: string;
  notes: string;
}

function validatePurchase(state: AppState, input: PurchaseInput, ctx: Ctx) {
  const supplier = state.suppliers.find((s) => s.id === input.supplierId);
  if (!supplier) fail('Choose a supplier.');
  if (input.lines.length === 0) fail('Add at least one item to the purchase.');
  const lines = input.lines.map((l, i) => {
    const p = requireProduct(state, l.productId);
    if (!p.trackStock) fail(`Line ${i + 1}: "${p.name}" does not track stock.`);
    return {
      productId: p.id,
      description: p.name,
      unit: p.unit,
      quantity: requireQuantity(state, p.unit, l.quantity, `Line ${i + 1} quantity`),
      unitCost: requireMoney(l.unitCost, `Line ${i + 1} unit cost`),
    };
  });
  return {
    supplierId: supplier.id,
    date: requireDate(input.date, ctx, 'Purchase date'),
    lines,
    reference: optionalText(input.reference, 'Reference', 80),
    notes: optionalText(input.notes, 'Notes'),
  };
}

export function createPurchase(state: AppState, input: PurchaseInput, ctx: Ctx): Result {
  if (state.purchases.some((p) => p.id === input.id)) return { state, id: input.id, duplicate: true };
  const supplier = state.suppliers.find((s) => s.id === input.supplierId);
  if (supplier?.archived) fail(`Supplier "${supplier.name}" is archived.`);
  const v = validatePurchase(state, input, ctx);
  const n = state.counters.purchase + 1;
  const purchase: Purchase = {
    ...v,
    id: input.id,
    number: `P-${String(n).padStart(5, '0')}`,
    status: 'draft',
    confirmedAt: null,
    createdAt: stamp(ctx),
  };
  const next = audit(
    { ...state, purchases: [...state.purchases, purchase], counters: { ...state.counters, purchase: n } },
    ctx,
    'purchase.create',
    `Purchase ${purchase.number} drafted`,
  );
  return { state: next, id: purchase.id, duplicate: false };
}

export function updatePurchase(state: AppState, input: PurchaseInput, ctx: Ctx): AppState {
  const existing = state.purchases.find((p) => p.id === input.id);
  if (!existing) fail('Purchase not found.');
  if (existing.status !== 'draft') fail('Only draft purchases can be edited.');
  const v = validatePurchase(state, input, ctx);
  const purchases = state.purchases.map((p) => (p.id === input.id ? { ...p, ...v } : p));
  return audit({ ...state, purchases }, ctx, 'purchase.update', `Purchase ${existing.number} updated`);
}

/** Receives a draft purchase into stock. Repeating it is rejected, so stock can't be double-counted. */
export function confirmPurchase(state: AppState, id: ID, ctx: Ctx): AppState {
  const p = state.purchases.find((x) => x.id === id);
  if (!p) fail('Purchase not found.');
  if (p.status === 'confirmed') fail(`Purchase ${p.number} has already been received into stock.`);
  if (p.status === 'cancelled') fail(`Purchase ${p.number} was cancelled.`);
  for (const l of p.lines) {
    const prod = requireProduct(state, l.productId);
    if (!prod.trackStock) fail(`"${prod.name}" no longer tracks stock.`);
    if (prod.unit !== l.unit) fail(`"${prod.name}" unit changed since this purchase was drafted.`);
  }
  const ms = p.lines.map((l) =>
    movement(ctx, {
      productId: l.productId,
      batchId: null,
      quantity: l.quantity,
      reason: 'purchase',
      date: p.date,
      note: `Purchase ${p.number}`,
      ref: { kind: 'purchase', id: p.id },
    }),
  );
  const purchases = state.purchases.map((x) =>
    x.id === id ? { ...x, status: 'confirmed' as const, confirmedAt: stamp(ctx) } : x,
  );
  return audit(
    { ...state, purchases, movements: [...state.movements, ...ms] },
    ctx,
    'purchase.confirm',
    `Purchase ${p.number} received into stock (${sumQty(p.lines.map((l) => l.quantity))} units)`,
  );
}

export function cancelPurchase(state: AppState, id: ID, ctx: Ctx): AppState {
  const p = state.purchases.find((x) => x.id === id);
  if (!p) fail('Purchase not found.');
  if (p.status !== 'draft') fail('Only draft purchases can be cancelled.');
  const purchases = state.purchases.map((x) => (x.id === id ? { ...x, status: 'cancelled' as const } : x));
  return audit({ ...state, purchases }, ctx, 'purchase.cancel', `Purchase ${p.number} cancelled`);
}

export function recordPurchasePayment(state: AppState, purchaseId: ID, input: PaymentInput, ctx: Ctx): Result {
  if (state.payments.some((p) => p.id === input.id)) return { state, id: input.id, duplicate: true };
  const purchase = state.purchases.find((p) => p.id === purchaseId);
  if (!purchase) fail('Purchase not found.');
  if (purchase.status !== 'confirmed') fail('Only received purchases can be paid.');
  const amount = requireMoney(input.amount, 'Payment amount', { allowZero: false });
  const balance = purchaseTotal(purchase.lines) - purchasePaid(state, purchaseId);
  if (balance <= 0) fail('This purchase is already paid in full.');
  if (amount > balance) fail('Payment exceeds the outstanding balance on this purchase.');
  const date = requireDate(input.date, ctx, 'Payment date');
  const payment: Payment = {
    id: input.id,
    direction: 'out',
    date,
    amount,
    method: requirePaymentMethod(state, input.method),
    saleId: null,
    purchaseId,
    reference: optionalText(input.reference, 'Reference', 80),
    createdAt: stamp(ctx),
  };
  const next = audit(
    { ...state, payments: [...state.payments, payment] },
    ctx,
    'payment.pay',
    `Supplier payment for ${purchase.number}`,
  );
  return { state: next, id: payment.id, duplicate: false };
}
