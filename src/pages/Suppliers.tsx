import { Archive, ArchiveRestore, Banknote, PackageCheck, Pencil, Plus, Trash2, Truck, XCircle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { setQuery, useRoute } from '../app/router';
import * as cmd from '../domain/commands';
import { parseQty } from '../domain/format';
import { purchaseTotal, purchaseView } from '../domain/selectors';
import type { Cents, Purchase, Supplier } from '../domain/types';
import { newId } from '../data/store';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, Modal, MoneyInput, PageHeader, SearchBox, SelectInput, Tabs, TextArea, TextInput, currencySymbol } from '../ui/components';
import { statusBadge } from './Sales';

type Tab = 'suppliers' | 'purchases';

export function SuppliersPage() {
  const { state } = useApp();
  const { query } = useRoute();
  const tab = (query.get('tab') as Tab) || 'suppliers';
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Suppliers & purchases"
        subtitle="Receiving a purchase adds its items to stock exactly once."
        actions={
          tab === 'suppliers' ? (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>Add supplier</Button>
          ) : (
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)} disabled={state.suppliers.filter((s) => !s.archived).length === 0}>New purchase</Button>
          )
        }
      />
      <Tabs<Tab>
        label="Suppliers and purchases"
        value={tab}
        onChange={(t) => setQuery({ tab: t === 'suppliers' ? '' : t })}
        tabs={[
          { value: 'suppliers', label: 'Suppliers', count: state.suppliers.filter((s) => !s.archived).length },
          { value: 'purchases', label: 'Purchases', count: state.purchases.filter((p) => p.status !== 'cancelled').length },
        ]}
      />
      {tab === 'suppliers' ? <SupplierList /> : <PurchaseList />}
      {creating && tab === 'suppliers' && <SupplierForm onClose={() => setCreating(false)} />}
      {creating && tab === 'purchases' && <PurchaseForm onClose={() => setCreating(false)} />}
    </>
  );
}

function SupplierList() {
  const { state, money, run, toast } = useApp();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [archiving, setArchiving] = useState<Supplier | null>(null);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.suppliers
      .filter((s) => (showArchived ? s.archived : !s.archived))
      .filter((s) => !q || [s.name, s.contactPerson, s.phone, s.email].some((f) => f.toLowerCase().includes(q)))
      .map((s) => {
        const purchases = state.purchases.filter((p) => p.supplierId === s.id && p.status === 'confirmed').map((p) => purchaseView(state, p));
        const expenses = state.expenses.filter((e) => e.supplierId === s.id).reduce((a, e) => a + e.amount, 0);
        return { s, owed: purchases.reduce((a, p) => a + p.balance, 0), purchased: purchases.reduce((a, p) => a + p.total, 0), expenses };
      })
      .sort((a, b) => a.s.name.localeCompare(b.s.name));
  }, [state, search, showArchived]);

  return (
    <>
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search suppliers…" label="Search suppliers" />
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /><span>Archived</span></label>
      </div>
      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState title="No suppliers to show" icon={<Truck size={28} />} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Supplier</th><th>Contact</th><th className="r">Stock purchased</th><th className="r">Linked expenses</th><th className="r">We owe</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map(({ s, owed, purchased, expenses }) => (
                  <tr key={s.id}>
                    <td data-label="Supplier"><strong>{s.name}</strong>{s.notes && <div className="muted small">{s.notes}</div>}</td>
                    <td data-label="Contact">{[s.contactPerson, s.phone, s.email].filter(Boolean).join(' · ') || <span className="muted">—</span>}</td>
                    <td data-label="Purchased" className="r num">{money(purchased)}</td>
                    <td data-label="Expenses" className="r num">{money(expenses)}</td>
                    <td data-label="We owe" className="r num">{owed > 0 ? <Badge tone="warn">{money(owed)}</Badge> : money(0)}</td>
                    <td className="r actions-cell">
                      <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`} title="Edit" />
                      <Button size="sm" variant="ghost" icon={s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} onClick={() => setArchiving(s)} aria-label={`${s.archived ? 'Restore' : 'Archive'} ${s.name}`} title={s.archived ? 'Restore' : 'Archive'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <SupplierForm supplier={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title={archiving?.archived ? 'Restore supplier?' : 'Archive supplier?'}
        tone={archiving?.archived ? 'primary' : 'danger'}
        confirmLabel={archiving?.archived ? 'Restore' : 'Archive'}
        message={archiving?.archived ? 'The supplier will be available for new purchases again.' : 'The supplier will be hidden from new purchases. Existing purchases and expenses keep their link.'}
        onConfirm={() => {
          if (!archiving) return;
          const res = run((s, c) => cmd.setSupplierArchived(s, archiving.id, !archiving.archived, c), archiving.archived ? 'Supplier restored.' : 'Supplier archived.');
          if (!res.ok) toast('error', res.error);
          setArchiving(null);
        }}
      />
    </>
  );
}

function SupplierForm({ supplier, onClose }: { supplier?: Supplier; onClose: () => void }) {
  const { run } = useApp();
  const [f, setF] = useState<cmd.SupplierInput>({
    name: supplier?.name ?? '',
    contactPerson: supplier?.contactPerson ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    notes: supplier?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof cmd.SupplierInput) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const submit = () => {
    const res = supplier
      ? run((s, c) => cmd.updateSupplier(s, supplier.id, f, c), 'Supplier updated.')
      : run((s, c) => cmd.createSupplier(s, f, c).state, 'Supplier added.');
    if (!res.ok) return setError(res.error);
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={supplier ? `Edit ${supplier.name}` : 'Add supplier'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{supplier ? 'Save' : 'Add supplier'}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Supplier name" required autoFocus value={f.name} onChange={set('name')} maxLength={80} />
        <TextInput label="Contact person" value={f.contactPerson} onChange={set('contactPerson')} maxLength={80} />
        <TextInput label="Phone" type="tel" value={f.phone} onChange={set('phone')} maxLength={40} />
        <TextInput label="Email" type="email" value={f.email} onChange={set('email')} maxLength={120} />
        <div className="span-2"><TextArea label="Notes" value={f.notes} onChange={set('notes')} maxLength={500} /></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function PurchaseList() {
  const { state, money, date, qty, run, toast } = useApp();
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<Purchase | null>(null);
  const [receiving, setReceiving] = useState<Purchase | null>(null);
  const [cancelling, setCancelling] = useState<Purchase | null>(null);
  const [paying, setPaying] = useState<Purchase | null>(null);
  const suppliers = new Map(state.suppliers.map((s) => [s.id, s.name]));
  const rows = state.purchases
    .filter((p) => !status || p.status === status)
    .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number))
    .map((p) => purchaseView(state, p));

  return (
    <>
      <div className="toolbar">
        <select className="input" aria-label="Filter purchases by status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All purchases</option>
          <option value="draft">Drafts (not yet received)</option>
          <option value="confirmed">Received</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>
      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState title="No purchases to show" icon={<Truck size={28} />}>Record stock bought from suppliers. Drafts do not affect stock until received.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Purchase</th><th>Date</th><th>Supplier</th><th>Items</th><th className="r">Total</th><th>Status</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map(({ purchase: p, total, balance, status: payStatus }) => (
                  <tr key={p.id} className={p.status === 'cancelled' ? 'voided' : ''}>
                    <td data-label="Purchase"><strong>{p.number}</strong>{p.reference && <div className="muted small">{p.reference}</div>}</td>
                    <td data-label="Date">{date(p.date)}</td>
                    <td data-label="Supplier">{suppliers.get(p.supplierId)}</td>
                    <td data-label="Items">{p.lines.map((l) => `${qty(l.quantity)} ${l.unit} ${l.description}`).join('; ')}</td>
                    <td data-label="Total" className="r num">{money(total)}{p.status === 'confirmed' && balance > 0 && <div className="muted small">owe {money(balance)}</div>}</td>
                    <td data-label="Status">
                      {p.status === 'draft' ? <Badge tone="info">Draft</Badge> : p.status === 'cancelled' ? <Badge>Cancelled</Badge> : <span className="badge-row"><Badge tone="good">Received</Badge>{statusBadge(payStatus)}</span>}
                    </td>
                    <td className="r actions-cell">
                      {p.status === 'draft' && (
                        <>
                          <Button size="sm" variant="primary" icon={<PackageCheck size={14} />} onClick={() => setReceiving(p)}>Receive</Button>
                          <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(p)} aria-label={`Edit ${p.number}`} title="Edit" />
                          <Button size="sm" variant="ghost" icon={<XCircle size={14} />} onClick={() => setCancelling(p)} aria-label={`Cancel ${p.number}`} title="Cancel purchase" />
                        </>
                      )}
                      {p.status === 'confirmed' && balance > 0 && <Button size="sm" icon={<Banknote size={14} />} onClick={() => setPaying(p)}>Pay</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <PurchaseForm purchase={editing} onClose={() => setEditing(null)} />}
      {paying && <SupplierPaymentDialog purchase={paying} onClose={() => setPaying(null)} />}
      <ConfirmDialog
        open={!!receiving}
        onClose={() => setReceiving(null)}
        title={`Receive ${receiving?.number} into stock?`}
        tone="primary"
        confirmLabel="Receive into stock"
        message={receiving ? <>This adds {receiving.lines.map((l) => `${qty(l.quantity)} ${l.unit} of ${l.description}`).join(', ')} to stock. A purchase can only be received once.</> : ''}
        onConfirm={() => {
          if (!receiving) return;
          const res = run((s, c) => cmd.confirmPurchase(s, receiving.id, c), 'Purchase received into stock.');
          if (!res.ok) toast('error', res.error);
          setReceiving(null);
        }}
      />
      <ConfirmDialog
        open={!!cancelling}
        onClose={() => setCancelling(null)}
        title={`Cancel ${cancelling?.number}?`}
        confirmLabel="Cancel purchase"
        message="The draft will be marked as cancelled and kept for reference. Stock is not affected."
        onConfirm={() => {
          if (!cancelling) return;
          const res = run((s, c) => cmd.cancelPurchase(s, cancelling.id, c), 'Purchase cancelled.');
          if (!res.ok) toast('error', res.error);
          setCancelling(null);
        }}
      />
    </>
  );
}

interface PLine {
  key: string;
  productId: string;
  quantity: string;
  unitCost: Cents | null;
}

function PurchaseForm({ purchase, onClose }: { purchase?: Purchase; onClose: () => void }) {
  const { state, run, today, money } = useApp();
  const [id] = useState(() => purchase?.id ?? newId());
  const suppliers = state.suppliers.filter((s) => !s.archived || s.id === purchase?.supplierId);
  const products = state.products.filter((p) => !p.archived && p.trackStock);
  const [supplierId, setSupplierId] = useState(purchase?.supplierId ?? suppliers[0]?.id ?? '');
  const [date, setDate] = useState(purchase?.date ?? today);
  const [reference, setReference] = useState(purchase?.reference ?? '');
  const [notes, setNotes] = useState(purchase?.notes ?? '');
  const [receiveNow, setReceiveNow] = useState(false);
  const [lines, setLines] = useState<PLine[]>(
    purchase?.lines.map((l) => ({ key: newId(), productId: l.productId, quantity: String(l.quantity), unitCost: l.unitCost })) ?? [
      { key: newId(), productId: '', quantity: '', unitCost: null },
    ],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const symbol = currencySymbol(state.settings.currency, state.settings.locale);
  const update = (key: string, patch: Partial<PLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const parsed = lines.map((l) => ({ productId: l.productId, quantity: parseQty(l.quantity), unitCost: l.unitCost }));
  const total = purchaseTotal(parsed.map((l) => ({ quantity: l.quantity ?? 0, unitCost: l.unitCost ?? 0 })));

  const submit = () => {
    if (busy) return;
    if (parsed.some((l) => !l.productId || l.quantity === null || l.unitCost === null)) {
      return setError('Every line needs a product, quantity and unit cost.');
    }
    setBusy(true);
    const input: cmd.PurchaseInput = {
      id,
      supplierId,
      date,
      reference,
      notes,
      lines: parsed.map((l) => ({ productId: l.productId, quantity: l.quantity!, unitCost: l.unitCost! })),
    };
    const res = purchase
      ? run((s, c) => cmd.updatePurchase(s, input, c), 'Purchase updated.')
      : run((s, c) => {
          const r = cmd.createPurchase(s, input, c);
          return receiveNow && !r.duplicate ? cmd.confirmPurchase(r.state, r.id, c) : r.state;
        }, receiveNow ? 'Purchase recorded and received into stock.' : 'Purchase saved as draft.');
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onClose();
  };

  return (
    <Modal open onClose={onClose} size="lg" title={purchase ? `Edit ${purchase.number}` : 'New purchase'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>{purchase ? 'Save draft' : receiveNow ? 'Save & receive' : 'Save draft'}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <SelectInput label="Supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} options={suppliers.map((s) => ({ value: s.id, label: s.name }))} />
        <TextInput label="Date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <div className="span-2 lines">
          {lines.map((l, i) => {
            const p = products.find((x) => x.id === l.productId);
            return (
              <fieldset key={l.key} className="line pline">
                <legend className="sr-only">Line {i + 1}</legend>
                <SelectInput label="Product" className="line-product" value={l.productId} onChange={(e) => update(l.key, { productId: e.target.value, unitCost: products.find((x) => x.id === e.target.value)?.costPrice ?? l.unitCost })} options={[{ value: '', label: 'Choose…' }, ...products.map((x) => ({ value: x.id, label: `${x.name} (${x.unit})` }))]} />
                <TextInput label={`Qty${p ? ` (${p.unit})` : ''}`} className="line-qty" inputMode="decimal" value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
                <MoneyInput label="Unit cost" className="line-price" symbol={symbol} value={l.unitCost} onChange={(c) => update(l.key, { unitCost: c })} />
                <button type="button" className="icon-btn line-remove" aria-label={`Remove line ${i + 1}`} onClick={() => setLines((ls) => (ls.length === 1 ? ls : ls.filter((x) => x.key !== l.key)))}><Trash2 size={16} /></button>
              </fieldset>
            );
          })}
          <div className="lines-foot">
            <Button size="sm" icon={<Plus size={14} />} onClick={() => setLines((ls) => [...ls, { key: newId(), productId: '', quantity: '', unitCost: null }])}>Add line</Button>
            <span>Total <strong className="num">{money(total)}</strong></span>
          </div>
        </div>
        <TextInput label="Supplier invoice / reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
        <TextInput label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        {!purchase && (
          <label className="check span-2">
            <input type="checkbox" checked={receiveNow} onChange={(e) => setReceiveNow(e.target.checked)} />
            <span>Goods already received — add to stock now</span>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function SupplierPaymentDialog({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) {
  const { state, run, today, money } = useApp();
  const v = purchaseView(state, purchase);
  const [id] = useState(newId);
  const [amount, setAmount] = useState<Cents | null>(v.balance);
  const [method, setMethod] = useState(state.settings.paymentMethods[0]);
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = () => {
    if (amount === null || amount <= 0) return setError('Enter an amount greater than zero.');
    const res = run((s, c) => cmd.recordPurchasePayment(s, purchase.id, { id, amount, method, date, reference }, c).state, 'Supplier payment recorded.');
    if (!res.ok) return setError(res.error);
    onClose();
  };
  return (
    <Modal open onClose={onClose} size="sm" title={`Pay supplier — ${purchase.number}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Save payment</Button></>}>
      <form className="form-grid one" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <MoneyInput label="Amount" symbol={currencySymbol(state.settings.currency, state.settings.locale)} value={amount} onChange={(c) => setAmount(c)} hint={`Outstanding: ${money(v.balance)}`} />
        <SelectInput label="Method" value={method} onChange={(e) => setMethod(e.target.value)} options={state.settings.paymentMethods.map((m) => ({ value: m, label: m }))} />
        <TextInput label="Date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <TextInput label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
