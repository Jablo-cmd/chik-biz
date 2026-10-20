// Fictional demonstration data. Every name, number and figure here is made up
// for demonstration and does NOT represent any real client, customer or
// supplier. All records are created through the same business commands the UI
// uses, so stock, balances and reports reconcile exactly as they would in use.

import * as cmd from './commands';
import { DEFAULT_SETTINGS, emptyState } from './defaults';
import { addDays, toISODate } from './format';
import type { AppState, ID, ISODate } from './types';

/** Small deterministic PRNG so the demo looks the same on every reset. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDemoState(now: Date = new Date()): AppState {
  const rand = mulberry32(20261020);
  const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
  let seq = 0;
  const newId = () => `demo-${(++seq).toString(36).padStart(5, '0')}`;
  const today = toISODate(now);
  let minute = 0;
  /** Context whose clock sits on the given business date (never later than now). */
  const at = (date: ISODate): cmd.Ctx => {
    const [y, m, d] = date.split('-').map(Number);
    minute = (minute + 7) % 600;
    let t = new Date(y, m - 1, d, 8, 0, 0);
    t = new Date(t.getTime() + minute * 60_000);
    if (t > now) t = new Date(now.getTime() - 1000);
    return { now: t, newId };
  };
  const day = (offset: number) => addDays(today, offset);

  let s = emptyState({ ...DEFAULT_SETTINGS, businessName: 'Chik-Biz Demo Farm' });
  s = { ...s, isSampleData: true };

  // ----- Products -----
  const product = (
    name: string,
    category: string,
    unit: string,
    price: number,
    cost: number | null,
    opening: number,
    threshold: number | null,
  ): ID => {
    const r = cmd.createProduct(
      s,
      {
        name,
        category,
        unit,
        sellingPrice: price * 100,
        costPrice: cost === null ? null : cost * 100,
        lowStockThreshold: threshold,
        trackStock: true,
        openingStock: opening,
        date: day(-21),
      },
      at(day(-21)),
    );
    s = r.state;
    return r.id;
  };
  const broiler = product('Live broiler chicken', 'Live birds', 'birds', 95, null, 0, 20);
  const dressed = product('Dressed whole chicken', 'Dressed chicken', 'kg', 72, null, 60, 15);
  const portions = product('Chicken portions (2 kg pack)', 'Dressed chicken', 'packs', 130, null, 30, 8);
  const trays = product('Eggs – tray of 30 (large)', 'Eggs', 'trays', 75, 52, 24, 8);
  const loose = product('Eggs – loose (large)', 'Eggs', 'eggs', 3, null, 150, 30);
  const feet = product('Chicken feet (1 kg pack)', 'Other products', 'packs', 35, null, 16, 6);

  // ----- Customers (fictional) -----
  const customer = (name: string, businessName: string, phone: string, notes: string): ID => {
    const r = cmd.createCustomer(
      s,
      { name, businessName, phone, email: '', address: '', notes },
      at(day(-30)),
    );
    s = r.state;
    return r.id;
  };
  const customers = [
    customer('Sample Customer A', 'Corner Spaza (fictional)', '000 000 0001', 'Fictional demo customer — buys on 7-day credit.'),
    customer('Sample Customer B', 'Weekend Market Stall (fictional)', '000 000 0002', 'Fictional demo customer.'),
    customer('Sample Customer C', 'Takeaway Kitchen (fictional)', '000 000 0003', 'Fictional demo customer — weekly order.'),
    customer('Sample Customer D', '', '000 000 0004', 'Fictional demo household customer.'),
  ];

  // ----- Suppliers (fictional) -----
  const supplier = (name: string, notes: string): ID => {
    const r = cmd.createSupplier(s, { name, contactPerson: '', phone: '', email: '', notes }, at(day(-30)));
    s = r.state;
    return r.id;
  };
  const feedSupplier = supplier('Sample Feed Supplier', 'Fictional demo supplier.');
  supplier('Sample Hatchery', 'Fictional demo supplier of day-old chicks.');
  const eggSupplier = supplier('Sample Egg Wholesaler', 'Fictional demo supplier.');

  // ----- Poultry batch -----
  const batch = cmd.createBatch(
    s,
    {
      name: 'Broilers – cycle 1',
      poultryType: 'Broiler',
      productId: broiler,
      startDate: day(-35),
      initialQuantity: 250,
      startingCost: 2_250_00,
      notes: 'Fictional demo batch.',
    },
    at(day(-35)),
  );
  s = batch.state;
  const batchId = batch.id;
  for (const [offset, qty, reason] of [
    [-34, 3, 'death'],
    [-31, 2, 'death'],
    [-26, 1, 'death'],
    [-12, 1, 'death'],
    [-8, 2, 'loss'],
    [-3, 1, 'death'],
  ] as const) {
    s = cmd.adjustStock(
      s,
      {
        productId: broiler,
        batchId,
        direction: 'out',
        quantity: qty,
        reason,
        date: day(offset),
        note: reason === 'loss' ? 'Missing at evening count (demo)' : '',
      },
      at(day(offset)),
    );
  }

  // ----- Stock adjustments -----
  s = cmd.adjustStock(
    s,
    { productId: loose, batchId: null, direction: 'out', quantity: 6, reason: 'damage', date: day(-5), note: 'Cracked in transit (demo)' },
    at(day(-5)),
  );
  s = cmd.adjustStock(
    s,
    { productId: dressed, batchId: null, direction: 'in', quantity: 45.5, reason: 'production', date: day(-7), note: 'Processed from own birds (demo)' },
    at(day(-7)),
  );

  // ----- Purchases -----
  const p1 = cmd.createPurchase(
    s,
    {
      id: newId(),
      supplierId: eggSupplier,
      date: day(-10),
      lines: [{ productId: trays, quantity: 40, unitCost: 52_00 }],
      reference: 'DEMO-INV-1001',
      notes: '',
    },
    at(day(-10)),
  );
  s = cmd.confirmPurchase(p1.state, p1.id, at(day(-10)));
  s = cmd.recordPurchasePayment(
    s,
    p1.id,
    { id: newId(), amount: 1_000_00, method: 'EFT', date: day(-9), reference: 'DEMO-EFT' },
    at(day(-9)),
  ).state;
  s = cmd.createPurchase(
    s,
    {
      id: newId(),
      supplierId: eggSupplier,
      date: day(-1),
      lines: [{ productId: trays, quantity: 20, unitCost: 52_00 }],
      reference: 'DEMO-INV-1002',
      notes: 'Awaiting delivery (demo).',
    },
    at(day(-1)),
  ).state;

  // ----- Expenses -----
  const expense = (offset: number, category: string, description: string, amount: number, method = 'Cash', supplierId: ID | null = null) => {
    s = cmd.createExpense(
      s,
      { id: newId(), date: day(offset), category, description, amount: amount * 100, method, supplierId, reference: '' },
      at(day(offset)),
    ).state;
  };
  expense(-20, 'Feed', 'Broiler grower feed – 5 bags (demo)', 1_850, 'EFT', feedSupplier);
  expense(-13, 'Feed', 'Broiler finisher feed – 5 bags (demo)', 1_925, 'EFT', feedSupplier);
  expense(-6, 'Feed', 'Broiler finisher feed – 5 bags (demo)', 1_925, 'EFT', feedSupplier);
  expense(-18, 'Medication & vaccines', 'Vitamins and vaccine (demo)', 420, 'Card');
  expense(-15, 'Utilities', 'Electricity prepaid (demo)', 650, 'Card');
  expense(-14, 'Labour', 'Casual labour – week (demo)', 1_200);
  expense(-7, 'Labour', 'Casual labour – week (demo)', 1_200);
  expense(-11, 'Transport', 'Delivery fuel (demo)', 280);
  expense(-4, 'Transport', 'Delivery fuel (demo)', 310);
  expense(-9, 'Packaging', 'Bags and labels (demo)', 320);
  expense(0, 'Transport', 'Market trip fuel (demo)', 180);
  expense(0, 'Packaging', 'Egg trays and bags (demo)', 95);

  // ----- Sales over the last 14 days -----
  const catalogue = [
    { id: broiler, price: 95_00, qty: () => 1 + Math.floor(rand() * 6), batch: true },
    { id: dressed, price: 72_00, qty: () => Math.round((1.2 + rand() * 4) * 10) / 10, batch: false },
    { id: portions, price: 130_00, qty: () => 1 + Math.floor(rand() * 2), batch: false },
    { id: trays, price: 75_00, qty: () => 1 + Math.floor(rand() * 3), batch: false },
    { id: loose, price: 3_00, qty: () => 6 + Math.floor(rand() * 13), batch: false },
    { id: feet, price: 35_00, qty: () => 1, batch: false },
  ];
  const creditSales: { id: ID; date: ISODate }[] = [];
  for (let offset = -13; offset <= 0; offset++) {
    const date = day(offset);
    const count = offset === 0 ? 3 : 1 + Math.floor(rand() * 4);
    for (let i = 0; i < count; i++) {
      const walkIn = rand() < 0.4;
      const customerId = walkIn ? null : pick(customers);
      const lineCount = 1 + Math.floor(rand() * 2);
      const used = new Set<ID>();
      const lines: cmd.SaleLineInput[] = [];
      for (let j = 0; j < lineCount; j++) {
        const item = pick(catalogue);
        if (used.has(item.id)) continue;
        used.add(item.id);
        const qty = item.qty();
        const gross = Math.round(qty * item.price);
        const discount = !walkIn && rand() < 0.15 ? Math.floor(gross * 0.05) : 0;
        lines.push({ productId: item.id, batchId: item.batch ? batchId : null, quantity: qty, unitPrice: item.price, discount });
      }
      const total = lines.reduce((a, l) => a + Math.round(l.quantity * l.unitPrice) - l.discount, 0);
      const roll = rand();
      const amount = walkIn || roll < 0.6 ? total : roll < 0.85 ? Math.round(total / 200) * 100 : 0;
      try {
        const r = cmd.createSale(
          s,
          {
            id: newId(),
            date,
            customerId,
            walkInName: '',
            lines,
            notes: '',
            payment: amount > 0 ? { amount, method: pick(['Cash', 'Cash', 'Card', 'EFT', 'Mobile payment']), reference: '' } : null,
          },
          at(date),
        );
        s = r.state;
        if (amount < total) creditSales.push({ id: r.id, date });
      } catch (e) {
        if (!(e instanceof cmd.DomainError)) throw e;
        // Skip a generated sale that would exceed available stock.
      }
    }
  }

  // Settle some older credit sales.
  for (const cs of creditSales.slice(0, Math.ceil(creditSales.length / 2))) {
    const payDate = addDays(cs.date, 3) > today ? today : addDays(cs.date, 3);
    const sale = s.sales.find((x) => x.id === cs.id)!;
    const total = sale.lines.reduce((a, l) => a + Math.round(l.quantity * l.unitPrice) - l.discount, 0);
    const paid = s.payments.filter((p) => p.saleId === cs.id).reduce((a, p) => a + p.amount, 0);
    if (total - paid <= 0) continue;
    s = cmd.recordSalePayment(
      s,
      cs.id,
      { id: newId(), amount: total - paid, method: 'EFT', date: payDate, reference: '' },
      at(payDate),
    ).state;
  }

  return { ...s, audit: [] };
}
