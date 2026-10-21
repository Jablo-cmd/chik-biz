import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import * as cmd from '../domain/commands';
import { parseQty } from '../domain/format';
import { batchQuantity, lineGross, stockOnHand } from '../domain/selectors';
import type { Cents } from '../domain/types';
import { newId } from '../data/store';
import { Button, Card, ErrorBanner, MoneyInput, PageHeader, SelectInput, TextInput, currencySymbol } from '../ui/components';
import { unitSingular } from './Inventory';

interface LineDraft {
  key: string;
  productId: string;
  batchId: string;
  quantity: string;
  unitPrice: Cents | null;
  discount: Cents | null;
}

const blankLine = (): LineDraft => ({ key: newId(), productId: '', batchId: '', quantity: '1', unitPrice: null, discount: 0 });

export function NewSalePage({ customerId: presetCustomer }: { customerId: string | null }) {
  const { state, run, money, today, qty } = useApp();
  // Generated once per form: the idempotency key that stops this sale being recorded twice.
  const [saleId] = useState(newId);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(today);
  const [customerId, setCustomerId] = useState(presetCustomer && state.customers.some((c) => c.id === presetCustomer && !c.archived) ? presetCustomer : '');
  const [walkInName, setWalkInName] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [amountPaid, setAmountPaid] = useState<Cents | null>(null);
  const [payTouched, setPayTouched] = useState(false);
  const [method, setMethod] = useState(state.settings.paymentMethods[0]);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const symbol = currencySymbol(state.settings.currency, state.settings.locale);

  const products = state.products.filter((p) => !p.archived);
  const customers = state.customers.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name));

  const computed = useMemo(
    () =>
      lines.map((l) => {
        const product = products.find((p) => p.id === l.productId);
        const q = parseQty(l.quantity);
        const gross = q !== null && l.unitPrice !== null ? lineGross({ quantity: q, unitPrice: l.unitPrice }) : 0;
        return { l, product, q, gross, total: gross - (l.discount ?? 0) };
      }),
    [lines, state],
  );
  const subtotal = computed.reduce((a, c) => a + c.gross, 0);
  const discount = computed.reduce((a, c) => a + (c.l.discount ?? 0), 0);
  const total = subtotal - discount;
  const paid = payTouched ? amountPaid : total;
  const balance = total - (paid ?? 0);

  const update = (key: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const submit = async () => {
    if (submitting.current) return;
    setError(null);
    if (computed.some((c) => !c.product)) return setError('Choose a product on every line, or remove empty lines.');
    if (computed.some((c) => c.q === null || c.q <= 0)) return setError('Every line needs a quantity greater than zero.');
    if (computed.some((c) => c.l.unitPrice === null)) return setError('Every line needs a valid unit price.');
    if (computed.some((c) => c.l.discount === null)) return setError('A discount is not a valid amount.');
    if (paid === null) return setError('Amount paid is not a valid amount.');
    submitting.current = true;
    setBusy(true);
    const input: cmd.SaleInput = {
      id: saleId,
      date,
      customerId: customerId || null,
      walkInName,
      notes,
      lines: computed.map((c) => ({ productId: c.l.productId, batchId: c.l.batchId || null, quantity: c.q!, unitPrice: c.l.unitPrice!, discount: c.l.discount ?? 0 })),
      payment: paid > 0 ? { amount: paid, method, reference } : null,
    };
    const res = await run({ type: 'createSale', input }, 'Sale recorded.');
    if (!res.ok) {
      submitting.current = false;
      setBusy(false);
      setError(res.error);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    // Replace history so "back" does not return to a spent form.
    history.replaceState(null, '', `#/sales/${saleId}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  };

  return (
    <>
      <a href="#/sales" className="back-link"><ArrowLeft size={16} /> Sales</a>
      <PageHeader title="New sale" />
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate className="sale-form">
        <ErrorBanner message={error} />
        <Card title="Customer">
          <div className="form-grid">
            <SelectInput
              label="Customer"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              options={[{ value: '', label: 'Walk-in customer (pay now)' }, ...customers.map((c) => ({ value: c.id, label: c.businessName ? `${c.name} — ${c.businessName}` : c.name }))]}
              hint={customerId ? 'Credit allowed: any unpaid amount is added to the customer’s balance.' : <>Walk-in sales must be paid in full. <a href="#/customers?new=1">Add a customer</a> to sell on credit.</>}
            />
            {!customerId && <TextInput label="Walk-in name (optional)" value={walkInName} onChange={(e) => setWalkInName(e.target.value)} maxLength={80} />}
            <TextInput label="Sale date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </Card>

        <Card title="Items" className="mt">
          {products.length === 0 && <p className="muted">No active products. <a href="#/inventory?new=1">Add a product</a> first.</p>}
          <div className="lines">
            {computed.map(({ l, product, q, gross, total: lt }, idx) => {
              const onHand = product ? stockOnHand(state, product.id) : 0;
              const batches = product && state.settings.batchTrackingEnabled ? state.batches.filter((b) => b.productId === product.id && b.status === 'active') : [];
              const maxDiscount = Math.floor((gross * state.settings.maxDiscountPercent) / 100);
              const over = product?.trackStock && q !== null && q > onHand;
              return (
                <fieldset key={l.key} className="line">
                  <legend className="sr-only">Line {idx + 1}</legend>
                  <SelectInput
                    label="Product"
                    className="line-product"
                    value={l.productId}
                    onChange={(e) => {
                      const p = products.find((x) => x.id === e.target.value);
                      update(l.key, { productId: e.target.value, unitPrice: p ? p.sellingPrice : null, batchId: '' });
                    }}
                    options={[{ value: '', label: 'Choose a product…' }, ...products.map((p) => ({ value: p.id, label: `${p.name}${p.trackStock ? ` (${qty(stockOnHand(state, p.id))} ${p.unit})` : ''}`, disabled: p.trackStock && stockOnHand(state, p.id) <= 0 }))]}
                    error={over ? `Only ${qty(onHand)} ${product!.unit} in stock.` : null}
                  />
                  {batches.length > 0 && (
                    <SelectInput
                      label="From batch"
                      className="line-batch"
                      value={l.batchId}
                      onChange={(e) => update(l.key, { batchId: e.target.value })}
                      options={[{ value: '', label: 'Not batch-specific' }, ...batches.map((b) => ({ value: b.id, label: `${b.reference} (${batchQuantity(state, b.id)})` }))]}
                    />
                  )}
                  <TextInput label={`Qty${product ? ` (${product.unit})` : ''}`} className="line-qty" inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} error={l.quantity && q === null ? 'Invalid' : null} />
                  <MoneyInput label={`Price${product ? ` / ${unitSingular(product.unit)}` : ''}`} className="line-price" symbol={symbol} value={l.unitPrice} onChange={(c) => update(l.key, { unitPrice: c })} />
                  <MoneyInput
                    label="Discount"
                    className="line-discount"
                    symbol={symbol}
                    value={l.discount}
                    onChange={(c) => update(l.key, { discount: c })}
                    error={l.discount !== null && l.discount > maxDiscount && gross > 0 ? `Max ${money(maxDiscount)}` : null}
                  />
                  <div className="line-total">
                    <span className="muted">Line total</span>
                    <strong className="num">{money(lt)}</strong>
                  </div>
                  <button type="button" className="icon-btn line-remove" aria-label={`Remove line ${idx + 1}`} onClick={() => setLines((ls) => (ls.length === 1 ? [blankLine()] : ls.filter((x) => x.key !== l.key)))}>
                    <Trash2 size={16} />
                  </button>
                </fieldset>
              );
            })}
          </div>
          <Button icon={<Plus size={16} />} onClick={() => setLines((ls) => [...ls, blankLine()])}>Add line</Button>
          <p className="footnote">Discounts are limited to {state.settings.maxDiscountPercent}% of each line (change in Settings).</p>
        </Card>

        <div className="sale-bottom mt">
          <Card title="Payment">
            <div className="form-grid">
              <MoneyInput
                label="Amount paid now"
                symbol={symbol}
                value={paid}
                onChange={(c) => { setPayTouched(true); setAmountPaid(c); }}
                error={paid !== null && paid > total ? 'Cannot exceed the sale total.' : null}
                hint={
                  customerId ? (
                    <span className="quick">
                      <button type="button" className="text-link" onClick={() => { setPayTouched(false); }}>Full</button>
                      <button type="button" className="text-link" onClick={() => { setPayTouched(true); setAmountPaid(0); }}>Nothing (credit)</button>
                    </span>
                  ) : 'Defaults to the full total.'
                }
              />
              <SelectInput label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)} options={state.settings.paymentMethods.map((m) => ({ value: m, label: m }))} />
              <TextInput label="Payment reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} hint="Optional, e.g. EFT reference" />
              <TextInput label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            </div>
          </Card>
          <Card title="Summary" className="totals-card">
            <dl className="totals">
              <div><dt>Subtotal</dt><dd className="num">{money(subtotal)}</dd></div>
              <div><dt>Discount</dt><dd className="num">−{money(discount)}</dd></div>
              <div className="grand"><dt>Total</dt><dd className="num">{money(total)}</dd></div>
              <div><dt>Paid now</dt><dd className="num">{money(paid ?? 0)}</dd></div>
              <div className={balance > 0 ? 'owing' : ''}><dt>Balance owing</dt><dd className="num">{money(Math.max(0, balance))}</dd></div>
            </dl>
            <Button type="submit" variant="primary" className="block" disabled={busy || products.length === 0}>
              {busy ? 'Saving…' : 'Complete sale'}
            </Button>
          </Card>
        </div>
      </form>
    </>
  );
}
