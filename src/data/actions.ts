// Every change the UI can make, as a plain serialisable action.
//
// The demo backend applies an action with the pure domain commands. The
// Supabase backend first runs the same command against its current snapshot
// (so the user gets the same validation messages instantly), then calls the
// matching database function, which re-validates everything on the server.

import * as cmd from '../domain/commands';
import type { AppState, BusinessSettings, ID, PoultryBatch } from '../domain/types';

export type Action =
  | { type: 'updateSettings'; patch: Partial<BusinessSettings> }
  | { type: 'createProduct'; input: cmd.ProductInput & { id: ID; openingStock: number; date: string } }
  | { type: 'updateProduct'; id: ID; input: cmd.ProductInput }
  | { type: 'setProductArchived'; id: ID; archived: boolean }
  | { type: 'adjustStock'; input: cmd.AdjustmentInput }
  | { type: 'createBatch'; input: cmd.BatchInput & { id: ID } }
  | { type: 'updateBatch'; id: ID; input: Pick<cmd.BatchInput, 'name' | 'poultryType' | 'startingCost' | 'notes'> }
  | { type: 'setBatchStatus'; id: ID; status: PoultryBatch['status'] }
  | { type: 'createCustomer'; input: cmd.CustomerInput & { id: ID } }
  | { type: 'updateCustomer'; id: ID; input: cmd.CustomerInput }
  | { type: 'setCustomerArchived'; id: ID; archived: boolean }
  | { type: 'createSupplier'; input: cmd.SupplierInput & { id: ID } }
  | { type: 'updateSupplier'; id: ID; input: cmd.SupplierInput }
  | { type: 'setSupplierArchived'; id: ID; archived: boolean }
  | { type: 'createSale'; input: cmd.SaleInput }
  | { type: 'recordSalePayment'; saleId: ID; input: cmd.PaymentInput }
  | { type: 'voidSale'; saleId: ID; reason: string }
  | { type: 'createExpense'; input: cmd.ExpenseInput & { id: ID } }
  | { type: 'updateExpense'; id: ID; input: cmd.ExpenseInput }
  | { type: 'deleteExpense'; id: ID }
  | { type: 'createPurchase'; input: cmd.PurchaseInput; receive: boolean }
  | { type: 'updatePurchase'; input: cmd.PurchaseInput }
  | { type: 'confirmPurchase'; id: ID }
  | { type: 'cancelPurchase'; id: ID }
  | { type: 'recordPurchasePayment'; purchaseId: ID; input: cmd.PaymentInput };

/** Apply an action with the pure domain commands. Throws DomainError on invalid input. */
export function applyAction(s: AppState, a: Action, ctx: cmd.Ctx): AppState {
  switch (a.type) {
    case 'updateSettings':
      return cmd.updateSettings(s, a.patch, ctx);
    case 'createProduct':
      return cmd.createProduct(s, a.input, ctx).state;
    case 'updateProduct':
      return cmd.updateProduct(s, a.id, a.input, ctx);
    case 'setProductArchived':
      return cmd.setProductArchived(s, a.id, a.archived, ctx);
    case 'adjustStock':
      return cmd.adjustStock(s, a.input, ctx);
    case 'createBatch':
      return cmd.createBatch(s, a.input, ctx).state;
    case 'updateBatch':
      return cmd.updateBatch(s, a.id, a.input, ctx);
    case 'setBatchStatus':
      return cmd.setBatchStatus(s, a.id, a.status, ctx);
    case 'createCustomer':
      return cmd.createCustomer(s, a.input, ctx).state;
    case 'updateCustomer':
      return cmd.updateCustomer(s, a.id, a.input, ctx);
    case 'setCustomerArchived':
      return cmd.setCustomerArchived(s, a.id, a.archived, ctx);
    case 'createSupplier':
      return cmd.createSupplier(s, a.input, ctx).state;
    case 'updateSupplier':
      return cmd.updateSupplier(s, a.id, a.input, ctx);
    case 'setSupplierArchived':
      return cmd.setSupplierArchived(s, a.id, a.archived, ctx);
    case 'createSale':
      return cmd.createSale(s, a.input, ctx).state;
    case 'recordSalePayment':
      return cmd.recordSalePayment(s, a.saleId, a.input, ctx).state;
    case 'voidSale':
      return cmd.voidSale(s, a.saleId, a.reason, ctx);
    case 'createExpense':
      return cmd.createExpense(s, a.input, ctx).state;
    case 'updateExpense':
      return cmd.updateExpense(s, a.id, a.input, ctx);
    case 'deleteExpense':
      return cmd.deleteExpense(s, a.id, ctx);
    case 'createPurchase': {
      const r = cmd.createPurchase(s, a.input, ctx);
      return a.receive && !r.duplicate ? cmd.confirmPurchase(r.state, r.id, ctx) : r.state;
    }
    case 'updatePurchase':
      return cmd.updatePurchase(s, a.input, ctx);
    case 'confirmPurchase':
      return cmd.confirmPurchase(s, a.id, ctx);
    case 'cancelPurchase':
      return cmd.cancelPurchase(s, a.id, ctx);
    case 'recordPurchasePayment':
      return cmd.recordPurchasePayment(s, a.purchaseId, a.input, ctx).state;
  }
}
