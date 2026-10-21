import { ArrowLeft, Ban, Banknote, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from '../app/AppContext';
import { lineGross, lineTotal, saleView } from '../domain/selectors';
import type { Cents } from '../domain/types';
import { newId } from '../data/store';
import { Button, ConfirmDialog, EmptyState, ErrorBanner, LinkButton, Modal, MoneyInput, PageHeader, SelectInput, TextInput, currencySymbol } from '../ui/components';
import { statusBadge } from './Sales';

export function SaleDetailPage({ id, print }: { id: string; print: boolean }) {
  const { state, money, date, qty, run } = useApp();
  const sale = state.sales.find((s) => s.id === id);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [voidError, setVoidError] = useState<string | null>(null);

  useEffect(() => {
    if (print && sale) window.setTimeout(() => window.print(), 300);
  }, [print, sale]);

  if (!sale) return <EmptyState title="Sale not found" action={<LinkButton href="#/sales">Back to sales</LinkButton>} />;
  const v = saleView(state, sale);
  const customer = sale.customerId ? state.customers.find((c) => c.id === sale.customerId) : null;
  const payments = state.payments.filter((p) => p.saleId === sale.id).sort((a, b) => a.date.localeCompare(b.date));
  const voided = sale.status === 'voided';
  const s = state.settings;

  return (
    <>
      <div className="no-print">
        <a href="#/sales" className="back-link"><ArrowLeft size={16} /> Sales</a>
        <PageHeader
          title={`Sale ${sale.number}`}
          subtitle={<>{date(sale.date)} · {customer ? <a href={`#/customers/${customer.id}`}>{customer.name}</a> : v.customerName} · {statusBadge(voided ? 'voided' : v.status)}</>}
          actions={
            <>
              <Button icon={<Printer size={16} />} onClick={() => window.print()}>Print receipt</Button>
              {!voided && v.balance > 0 && <Button variant="primary" icon={<Banknote size={16} />} onClick={() => setPaying(true)}>Record payment</Button>}
              {!voided && <Button variant="ghost" icon={<Ban size={16} />} onClick={() => { setVoidError(null); setVoiding(true); }}>Void</Button>}
            </>
          }
        />
        {voided && <div className="alert alert-info">This sale was voided{sale.voidReason ? `: ${sale.voidReason}` : ''}. Its stock was returned and it is excluded from revenue.</div>}
      </div>

      <article className="receipt card">
        <header className="receipt-head">
          <div className="receipt-biz">
            {s.logoDataUrl && <img src={s.logoDataUrl} alt="" className="receipt-logo" />}
            <div>
              <h2>{s.businessName}</h2>
              {s.address && <p>{s.address}</p>}
              {(s.phone || s.email) && <p>{[s.phone, s.email].filter(Boolean).join(' · ')}</p>}
            </div>
          </div>
          <div className="receipt-meta">
            <p className="receipt-kind">{v.status === 'paid' ? 'Receipt' : 'Invoice'}{voided ? ' — VOID' : ''}</p>
            <p><span className="muted">No.</span> {sale.number}</p>
            <p><span className="muted">Date</span> {date(sale.date)}</p>
          </div>
        </header>
        <div className="receipt-to">
          <span className="muted">Customer</span>
          <strong>{v.customerName}</strong>
          {customer?.businessName && <span>{customer.businessName}</span>}
          {customer?.phone && <span>{customer.phone}</span>}
        </div>
        <div className="table-wrap">
          <table className="table receipt-table">
            <thead><tr><th>Item</th><th className="r">Qty</th><th className="r">Unit price</th><th className="r">Discount</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {sale.lines.map((l, i) => (
                <tr key={i}>
                  <td data-label="Item">{l.description}{l.batchId && <span className="muted"> · {state.batches.find((b) => b.id === l.batchId)?.reference}</span>}</td>
                  <td data-label="Qty" className="r num">{qty(l.quantity)} {l.unit}</td>
                  <td data-label="Unit price" className="r num">{money(l.unitPrice)}</td>
                  <td data-label="Discount" className="r num">{l.discount ? `−${money(l.discount)}` : '—'}</td>
                  <td data-label="Amount" className="r num" title={`Gross ${money(lineGross(l))}`}>{money(lineTotal(l))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="totals receipt-totals">
          <div><dt>Subtotal</dt><dd className="num">{money(v.totals.subtotal)}</dd></div>
          {v.totals.discount > 0 && <div><dt>Discount</dt><dd className="num">−{money(v.totals.discount)}</dd></div>}
          <div className="grand"><dt>Total</dt><dd className="num">{money(v.totals.total)}</dd></div>
          <div><dt>Paid</dt><dd className="num">{money(v.paid)}</dd></div>
          {!voided && <div className={v.balance > 0 ? 'owing' : ''}><dt>Balance due</dt><dd className="num">{money(v.balance)}</dd></div>}
        </dl>
        {payments.length > 0 && (
          <div className="receipt-payments">
            <h3>Payments</h3>
            <ul>
              {payments.map((p) => (
                <li key={p.id}><span>{date(p.date)} · {p.method}{p.reference ? ` · ${p.reference}` : ''}</span><span className="num">{money(p.amount)}</span></li>
              ))}
            </ul>
          </div>
        )}
        {sale.notes && <p className="receipt-notes">{sale.notes}</p>}
        <footer className="receipt-foot">
          Thank you for your business.
          <br />
          <span className="muted">Generated with Chik-Biz (demonstration prototype){state.isSampleData ? ' · contains fictional sample data' : ''}</span>
        </footer>
      </article>

      {paying && <PaymentDialog saleId={sale.id} balance={v.balance} onClose={() => setPaying(false)} />}
      <ConfirmDialog
        open={voiding}
        onClose={() => setVoiding(false)}
        title={`Void sale ${sale.number}?`}
        confirmLabel="Void sale"
        message="Voiding returns the items to stock and removes the sale from revenue. The record is kept for history and cannot be un-voided."
        onConfirm={async () => {
          const res = await run({ type: 'voidSale', saleId: sale.id, reason: voidReason }, 'Sale voided.');
          if (!res.ok) return setVoidError(res.error);
          setVoiding(false);
        }}
      >
        <ErrorBanner message={voidError} />
        <TextInput label="Reason" required value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={200} placeholder="e.g. Entered in error" />
      </ConfirmDialog>
    </>
  );
}

function PaymentDialog({ saleId, balance, onClose }: { saleId: string; balance: Cents; onClose: () => void }) {
  const { state, run, today, money } = useApp();
  const [paymentId] = useState(newId);
  const [amount, setAmount] = useState<Cents | null>(balance);
  const [method, setMethod] = useState(state.settings.paymentMethods[0]);
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy) return;
    if (amount === null || amount <= 0) return setError('Enter an amount greater than zero.');
    setBusy(true);
    const res = await run({ type: 'recordSalePayment', saleId, input: { id: paymentId, amount, method, date, reference } }, 'Payment recorded.');
    if (!res.ok) {
      setBusy(false);
      return setError(res.error);
    }
    onClose();
  };
  return (
    <Modal open onClose={onClose} title="Record payment" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>Save payment</Button></>}>
      <form className="form-grid one" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <MoneyInput label="Amount" required symbol={currencySymbol(state.settings.currency, state.settings.locale)} value={amount} onChange={(c) => setAmount(c)} hint={`Outstanding: ${money(balance)}`} />
        <SelectInput label="Method" value={method} onChange={(e) => setMethod(e.target.value)} options={state.settings.paymentMethods.map((m) => ({ value: m, label: m }))} />
        <TextInput label="Date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <TextInput label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
