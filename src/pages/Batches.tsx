import { ArrowLeft, Bird, Lock, Minus, Pencil, Plus, Unlock } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import * as cmd from '../domain/commands';
import { parseQty } from '../domain/format';
import { batchSummary } from '../domain/selectors';
import type { Cents, PoultryBatch } from '../domain/types';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  LinkButton,
  Modal,
  MoneyInput,
  PageHeader,
  SelectInput,
  Stat,
  TextArea,
  TextInput,
  currencySymbol,
} from '../ui/components';
import { AdjustStockDialog } from './Inventory';

export function BatchesPage() {
  const { state, date, qty } = useApp();
  const [creating, setCreating] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const batches = useMemo(
    () =>
      state.batches
        .filter((b) => showClosed || b.status === 'active')
        .sort((a, b) => b.startDate.localeCompare(a.startDate))
        .map((b) => ({ b, s: batchSummary(state, b), product: state.products.find((p) => p.id === b.productId) })),
    [state, showClosed],
  );

  return (
    <>
      <PageHeader
        title="Poultry batches"
        subtitle="Optional tracking for groups of birds raised or held together. Batch birds are counted in the linked product’s stock."
        actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setCreating(true)}>New batch</Button>}
      />
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          <span>Show closed batches</span>
        </label>
      </div>
      {batches.length === 0 ? (
        <Card>
          <EmptyState title="No batches to show" icon={<Bird size={28} />} action={<Button variant="primary" onClick={() => setCreating(true)}>Start a batch</Button>}>
            Use batches to track mortality, losses and sales for a group of birds from intake onwards.
          </EmptyState>
        </Card>
      ) : (
        <div className="card-grid">
          {batches.map(({ b, s, product }) => (
            <a key={b.id} href={`#/batches/${b.id}`} className="card batch-card">
              <div className="batch-card-head">
                <span className="batch-ref">{b.reference}</span>
                {b.status === 'active' ? <Badge tone="good">Active</Badge> : <Badge>Closed</Badge>}
              </div>
              <h3>{b.name}</h3>
              <p className="muted">{b.poultryType} · started {date(b.startDate)}</p>
              <div className="batch-figures">
                <div><span className="num big">{qty(s.current)}</span><span className="muted">{product?.unit ?? ''} now</span></div>
                <div><span className="num">{qty(s.deaths)}</span><span className="muted">deaths</span></div>
                <div><span className="num">{qty(s.sold)}</span><span className="muted">sold</span></div>
                <div><span className={`num ${s.mortalityPct >= 5 ? 'neg' : ''}`}>{s.mortalityPct}%</span><span className="muted">mortality</span></div>
              </div>
            </a>
          ))}
        </div>
      )}
      {creating && <BatchForm onClose={() => setCreating(false)} />}
    </>
  );
}

function BatchForm({ onClose, batch }: { onClose: () => void; batch?: PoultryBatch }) {
  const { state, run, today } = useApp();
  const eligible = state.products.filter((p) => !p.archived && p.trackStock && !state.settings.units.find((u) => u.name === p.unit)?.allowDecimal);
  const [name, setName] = useState(batch?.name ?? '');
  const [poultryType, setPoultryType] = useState(batch?.poultryType ?? 'Broiler');
  const [productId, setProductId] = useState(batch?.productId ?? eligible.find((p) => p.unit === 'birds')?.id ?? eligible[0]?.id ?? '');
  const [startDate, setStartDate] = useState(batch?.startDate ?? today);
  const [initial, setInitial] = useState(batch?.initialQuantity.toString() ?? '');
  const [cost, setCost] = useState<Cents | null>(batch?.startingCost ?? 0);
  const [notes, setNotes] = useState(batch?.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const symbol = currencySymbol(state.settings.currency, state.settings.locale);

  if (!batch && eligible.length === 0) {
    return (
      <Modal open onClose={onClose} title="New batch" footer={<Button onClick={onClose}>Close</Button>}>
        <EmptyState title="No suitable product" action={<LinkButton href="#/inventory?new=1" variant="primary">Add a product</LinkButton>}>
          A batch needs a stock-tracked product counted in whole units, such as “Live broiler chicken” in birds.
        </EmptyState>
      </Modal>
    );
  }

  const submit = () => {
    if (cost === null) return setError('Starting cost is not a valid amount.');
    if (batch) {
      const res = run((s, c) => cmd.updateBatch(s, batch.id, { name, poultryType, startingCost: cost, notes }, c), 'Batch updated.');
      if (!res.ok) return setError(res.error);
      return onClose();
    }
    const q = parseQty(initial);
    if (q === null) return setError('Enter the initial number of birds.');
    const res = run(
      (s, c) => cmd.createBatch(s, { name, poultryType, productId, startDate, initialQuantity: q, startingCost: cost, notes }, c).state,
      'Batch started.',
    );
    if (!res.ok) return setError(res.error);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={batch ? `Edit ${batch.reference}` : 'Start a new batch'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>{batch ? 'Save' : 'Start batch'}</Button></>}
    >
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Batch name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Broilers – cycle 2" maxLength={80} />
        <TextInput label="Poultry type" required value={poultryType} onChange={(e) => setPoultryType(e.target.value)} placeholder="e.g. Broiler, Layer, Indigenous" maxLength={60} />
        {!batch && (
          <>
            <SelectInput label="Counted as product" value={productId} onChange={(e) => setProductId(e.target.value)} options={eligible.map((p) => ({ value: p.id, label: `${p.name} (${p.unit})` }))} hint="The batch’s birds are added to this product’s stock." />
            <TextInput label="Initial quantity" required inputMode="numeric" value={initial} onChange={(e) => setInitial(e.target.value)} />
            <TextInput label="Start date" type="date" max={today} value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </>
        )}
        <MoneyInput label="Purchase / starting cost" symbol={symbol} value={cost} onChange={(c) => setCost(c)} hint="e.g. cost of day-old chicks. Counted in operating estimates." />
        <TextArea label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function BatchDetail({ id }: { id: string }) {
  const { state, date, qty, money, run, toast } = useApp();
  const batch = state.batches.find((b) => b.id === id);
  const [editing, setEditing] = useState(false);
  const [event, setEvent] = useState<'in' | 'out' | null>(null);
  const [toggling, setToggling] = useState(false);
  if (!batch) {
    return <EmptyState title="Batch not found" action={<LinkButton href="#/batches">Back to batches</LinkButton>} />;
  }
  const product = state.products.find((p) => p.id === batch.productId)!;
  const s = batchSummary(state, batch);
  const movements = state.movements
    .filter((m) => m.batchId === batch.id)
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  const active = batch.status === 'active';

  return (
    <>
      <a href="#/batches" className="back-link"><ArrowLeft size={16} /> All batches</a>
      <PageHeader
        title={`${batch.reference} · ${batch.name}`}
        subtitle={<>{batch.poultryType} · started {date(batch.startDate)} · counted as “{product.name}” · {active ? <Badge tone="good">Active</Badge> : <Badge>Closed</Badge>}</>}
        actions={
          <>
            {active && <Button icon={<Minus size={16} />} onClick={() => setEvent('out')}>Record death / loss</Button>}
            {active && <Button icon={<Plus size={16} />} onClick={() => setEvent('in')}>Add birds</Button>}
            <Button variant="ghost" icon={<Pencil size={16} />} onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="ghost" icon={active ? <Lock size={16} /> : <Unlock size={16} />} onClick={() => setToggling(true)}>{active ? 'Close batch' : 'Reopen'}</Button>
          </>
        }
      />
      <div className="stats-grid">
        <Stat label="Current birds" value={qty(s.current)} hint={`of ${qty(s.added)} received`} />
        <Stat label="Deaths" value={qty(s.deaths)} hint={`${s.mortalityPct}% mortality`} tone={s.mortalityPct >= 5 ? 'bad' : 'default'} />
        <Stat label="Other losses" value={qty(s.losses)} hint="Lost, stolen or damaged" />
        <Stat label="Sold" value={qty(s.sold)} hint={`Starting cost ${money(batch.startingCost)}`} />
      </div>
      {batch.notes && <Card title="Notes"><p>{batch.notes}</p></Card>}
      <Card title="Batch history" pad={false} className="mt">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Date</th><th>Event</th><th>Note</th><th className="r">Change</th></tr></thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.id}>
                  <td data-label="Date">{date(m.date)}</td>
                  <td data-label="Event">{cmd.REASON_LABELS[m.reason]}</td>
                  <td data-label="Note">{m.ref?.kind === 'sale' ? <a href={`#/sales/${m.ref.id}`}>{m.note}</a> : m.note || <span className="muted">—</span>}</td>
                  <td data-label="Change" className={`r num ${m.quantity < 0 ? 'neg' : 'pos'}`}>{m.quantity > 0 ? '+' : ''}{qty(m.quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {editing && <BatchForm batch={batch} onClose={() => setEditing(false)} />}
      {event && <AdjustStockDialog product={product} direction={event} batchId={batch.id} onClose={() => setEvent(null)} />}
      <ConfirmDialog
        open={toggling}
        onClose={() => setToggling(false)}
        title={active ? 'Close this batch?' : 'Reopen this batch?'}
        tone="primary"
        confirmLabel={active ? 'Close batch' : 'Reopen batch'}
        message={
          active
            ? `Closed batches cannot receive new events or sales. ${s.current > 0 ? `${s.current} birds are still recorded in this batch; they remain in “${product.name}” stock.` : ''}`
            : 'The batch will accept events and sales again.'
        }
        onConfirm={() => {
          const res = run((st, c) => cmd.setBatchStatus(st, batch.id, active ? 'closed' : 'active', c), active ? 'Batch closed.' : 'Batch reopened.');
          if (!res.ok) toast('error', res.error);
          setToggling(false);
        }}
      />
    </>
  );
}
