// Core domain model for Chik-Biz.
//
// Design rules:
// - Money is stored as integer cents to avoid floating-point drift.
// - Stock on hand and batch head-counts are never stored directly; they are
//   derived from the StockMovement ledger, so they always reconcile.
// - Customer balances and sale payment status are derived from sales and
//   payments, never stored as separate totals.
// - Records referenced by history (products, customers, suppliers) are
//   archived rather than deleted.

export type ID = string;
/** ISO date, `YYYY-MM-DD` (business date, local time). */
export type ISODate = string;
/** ISO timestamp. */
export type ISODateTime = string;
/** Integer number of cents in the configured currency. */
export type Cents = number;

export interface UnitDef {
  name: string;
  /** Whether fractional quantities (e.g. 1.25 kg) are allowed. */
  allowDecimal: boolean;
}

export interface BusinessSettings {
  businessName: string;
  /** Data URL of an uploaded logo, kept small (see MAX_LOGO_BYTES). */
  logoDataUrl: string | null;
  address: string;
  phone: string;
  email: string;
  /** ISO 4217 code, e.g. ZAR. */
  currency: string;
  /** BCP 47 locale used for number/currency formatting, e.g. en-ZA. */
  locale: string;
  productCategories: string[];
  expenseCategories: string[];
  units: UnitDef[];
  paymentMethods: string[];
  defaultLowStockThreshold: number;
  /** Maximum discount allowed on a sale line, as a percentage of the line value. */
  maxDiscountPercent: number;
  /** Poultry batch tracking is optional — not every business raises birds. */
  batchTrackingEnabled: boolean;
}

export interface Product {
  id: ID;
  name: string;
  category: string;
  unit: string;
  sellingPrice: Cents;
  /** Optional reference cost per unit (informational). */
  costPrice: Cents | null;
  /** Overrides the default threshold when set. */
  lowStockThreshold: number | null;
  /** Some products (e.g. services, made-to-order) may not track stock. */
  trackStock: boolean;
  archived: boolean;
  createdAt: ISODateTime;
}

export type MovementReason =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'sale_void'
  | 'restock'
  | 'batch_intake'
  | 'production'
  | 'damage'
  | 'loss'
  | 'death'
  | 'theft'
  | 'own_use'
  | 'count_correction'
  | 'other';

export interface StockMovement {
  id: ID;
  productId: ID;
  /** Present when the movement belongs to a poultry batch. */
  batchId: ID | null;
  /** Signed quantity in the product's unit. Positive = in, negative = out. */
  quantity: number;
  reason: MovementReason;
  date: ISODate;
  note: string;
  /** Source document, if any. */
  ref: { kind: 'sale' | 'purchase' | 'batch' | 'adjustment'; id: ID } | null;
  createdAt: ISODateTime;
}

export type BatchStatus = 'active' | 'closed';

export interface PoultryBatch {
  id: ID;
  reference: string;
  name: string;
  poultryType: string;
  /** The stock product that this batch's birds are counted under. */
  productId: ID;
  startDate: ISODate;
  initialQuantity: number;
  startingCost: Cents;
  status: BatchStatus;
  notes: string;
  createdAt: ISODateTime;
}

export interface Customer {
  id: ID;
  name: string;
  businessName: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  archived: boolean;
  createdAt: ISODateTime;
}

export interface SaleLine {
  productId: ID;
  /** Optional batch the sold birds came from. */
  batchId: ID | null;
  /** Snapshot of product name/unit at time of sale, for history and receipts. */
  description: string;
  unit: string;
  quantity: number;
  unitPrice: Cents;
  discount: Cents;
}

export type SaleStatus = 'completed' | 'voided';

export interface Sale {
  /** Generated when the sale form opens; doubles as the idempotency key. */
  id: ID;
  number: string;
  date: ISODate;
  customerId: ID | null;
  walkInName: string;
  lines: SaleLine[];
  status: SaleStatus;
  notes: string;
  voidReason: string;
  createdAt: ISODateTime;
}

export type PaymentDirection = 'in' | 'out';

export interface Payment {
  id: ID;
  direction: PaymentDirection;
  date: ISODate;
  amount: Cents;
  method: string;
  saleId: ID | null;
  purchaseId: ID | null;
  reference: string;
  createdAt: ISODateTime;
}

export interface Expense {
  id: ID;
  date: ISODate;
  category: string;
  description: string;
  amount: Cents;
  method: string;
  supplierId: ID | null;
  reference: string;
  createdAt: ISODateTime;
}

export interface Supplier {
  id: ID;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  notes: string;
  archived: boolean;
  createdAt: ISODateTime;
}

export interface PurchaseLine {
  productId: ID;
  description: string;
  unit: string;
  quantity: number;
  unitCost: Cents;
}

export type PurchaseStatus = 'draft' | 'confirmed' | 'cancelled';

export interface Purchase {
  id: ID;
  number: string;
  supplierId: ID;
  date: ISODate;
  lines: PurchaseLine[];
  status: PurchaseStatus;
  reference: string;
  notes: string;
  confirmedAt: ISODateTime | null;
  createdAt: ISODateTime;
}

export interface AuditEntry {
  id: ID;
  at: ISODateTime;
  action: string;
  summary: string;
}

export interface AppState {
  schemaVersion: number;
  /** True while the dataset contains generated sample data. */
  isSampleData: boolean;
  settings: BusinessSettings;
  products: Product[];
  movements: StockMovement[];
  batches: PoultryBatch[];
  customers: Customer[];
  sales: Sale[];
  payments: Payment[];
  expenses: Expense[];
  suppliers: Supplier[];
  purchases: Purchase[];
  audit: AuditEntry[];
  counters: { sale: number; purchase: number; batch: number };
}

export const SCHEMA_VERSION = 1;
