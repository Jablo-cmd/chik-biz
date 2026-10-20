import { SCHEMA_VERSION, type AppState, type BusinessSettings } from './types';

// Neutral defaults. These are placeholders until the client's real business
// details, branding and categories are confirmed.
export const DEFAULT_SETTINGS: BusinessSettings = {
  businessName: 'My Poultry Business',
  logoDataUrl: null,
  address: '',
  phone: '',
  email: '',
  currency: 'ZAR',
  locale: 'en-ZA',
  productCategories: ['Live birds', 'Dressed chicken', 'Eggs', 'Other products'],
  expenseCategories: ['Feed', 'Medication & vaccines', 'Transport', 'Labour', 'Utilities', 'Packaging', 'Other operating costs'],
  units: [
    { name: 'birds', allowDecimal: false },
    { name: 'eggs', allowDecimal: false },
    { name: 'trays', allowDecimal: false },
    { name: 'kg', allowDecimal: true },
    { name: 'packs', allowDecimal: false },
  ],
  paymentMethods: ['Cash', 'Card', 'EFT', 'Mobile payment', 'Other'],
  defaultLowStockThreshold: 10,
  maxDiscountPercent: 15,
  batchTrackingEnabled: true,
};

export function emptyState(settings: BusinessSettings = DEFAULT_SETTINGS): AppState {
  return {
    schemaVersion: SCHEMA_VERSION,
    isSampleData: false,
    settings: structuredClone(settings),
    products: [],
    movements: [],
    batches: [],
    customers: [],
    sales: [],
    payments: [],
    expenses: [],
    suppliers: [],
    purchases: [],
    audit: [],
    counters: { sale: 0, purchase: 0, batch: 0 },
  };
}
