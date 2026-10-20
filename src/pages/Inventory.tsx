import { Archive, ArchiveRestore, History, Minus, Package, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { setQuery, useRoute } from '../app/router';
import * as cmd from '../domain/commands';
import { parseQty } from '../domain/format';
import { inventoryAsOf } from '../domain/reports';
import { batchQuantity, lowStockThreshold, stockOnHand } from '../domain/selectors';
import type { Cents, ID, MovementReason, Product } from '../domain/types';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorBanner,
  Modal,
  MoneyInput,
  PageHeader,
  SearchBox,
  SelectInput,
  TextInput,
  currencySymbol,
} from '../ui/components';

export function InventoryPage() {
  const { state, money, qty, run, toast } = useApp();
  const { query } = useRoute();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState<'active' | 'low' | 'archived'>('active');
  const [editing, setEditing] = useState<Product | null>(null);
  const [adjusting, setAdjusting] = useState<{ product: Product; direction: 'in' | 'out' } | null>(null);
  const [history, setHistory] = useState<Product | null>(null);
  const [archiving, setArchiving] = useState<Product | null>(null);
  const creating = query.get('new') === '1';

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return inventoryAsOf(state, '', true).filter((r) => {
      if (status === 'archived' ? !r.product.archived : r.product.archived) return false;
      if (status === 'low' && !(r.level === 'low' || r.level === 'out')) return false;
      if (category && r.product.category !== category) return false;
      return !q || r.product.name.toLowerCase().includes(q) || r.product.category.toLowerCase().includes(q);
    });
  }, [state, search, category, status]);

  const archivedCount = state.products.filter((p) => p.archived).length;

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Stock on hand is calculated from every recorded stock movement."
        actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setQuery({ new: '1' })}>Add product</Button>}
      />
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Search products…" label="Search products" />
        <select className="input" aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {state.settings.productCategories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select className="input" aria-label="Filter by stock status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="active">Active products</option>
          <option value="low">Low or out of stock</option>
          <option value="archived">Archived ({archivedCount})</option>
        </select>
      </div>

      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState
            title={state.products.length === 0 ? 'No products yet' : 'No products match these filters'}
            icon={<Package size={28} />}
            action={state.products.length === 0 ? <Button variant="primary" onClick={() => setQuery({ new: '1' })}>Add your first product</Button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Category</th>
                  <th className="r">Selling price</th>
                  <th className="r">On hand</th>
                  <th>Status</th>
                  <th className="r"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ product: p, quantity, level }) => (
                  <tr key={p.id}>
                    <td data-label="Product"><strong>{p.name}</strong></td>
                    <td data-label="Category">{p.category}</td>
                    <td data-label="Price" className="r num"><span>{money(p.sellingPrice)} <span className="muted">/ {unitSingular(p.unit)}</span></span></td>
                    <td data-label="On hand" className="r num">{p.trackStock ? `${qty(quantity)} ${p.unit}` : <span className="muted">Not tracked</span>}</td>
                    <td data-label="Status">
                      {p.archived ? <Badge>Archived</Badge> : level === 'out' ? <Badge tone="bad">Out of stock</Badge> : level === 'low' ? <Badge tone="warn">Low (≤ {lowStockThreshold(p, state.settings.defaultLowStockThreshold)})</Badge> : level === 'untracked' ? <Badge>—</Badge> : <Badge tone="good">In stock</Badge>}
                    </td>
                    <td className="r actions-cell">
                      {!p.archived && p.trackStock && (
                        <>
                          <Button size="sm" icon={<Plus size={14} />} onClick={() => setAdjusting({ product: p, direction: 'in' })} aria-label={`Add stock to ${p.name}`}>In</Button>
                          <Button size="sm" icon={<Minus size={14} />} onClick={() => setAdjusting({ product: p, direction: 'out' })} aria-label={`Remove stock from ${p.name}`}>Out</Button>
                        </>
                      )}
                      <Button size="sm" variant="ghost" icon={<History size={14} />} onClick={() => setHistory(p)} aria-label={`Stock history for ${p.name}`} title="History" />
                      <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`} title="Edit" />
                      <Button size="sm" variant="ghost" icon={p.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} onClick={() => setArchiving(p)} aria-label={`${p.archived ? 'Restore' : 'Archive'} ${p.name}`} title={p.archived ? 'Restore' : 'Archive'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="footnote">
        Quantities are always recorded in each product’s own unit. Units are not converted automatically — for example, trays of eggs and loose eggs are separate products.
      </p>

      <ProductForm open={creating} onClose={() => setQuery({ new: '' })} />
      <ProductForm open={!!editing} product={editing ?? undefined} onClose={() => setEditing(null)} key={editing?.id ?? 'edit'} />
      {adjusting && <AdjustStockDialog product={adjusting.product} direction={adjusting.direction} onClose={() => setAdjusting(null)} />}
      {history && <MovementHistory product={history} onClose={() => setHistory(null)} />}
      <ConfirmDialog
        open={!!archiving}
        onClose={() => setArchiving(null)}
        title={archiving?.archived ? 'Restore product?' : 'Archive product?'}
        tone={archiving?.archived ? 'primary' : 'danger'}
        confirmLabel={archiving?.archived ? 'Restore' : 'Archive'}
        message={
          archiving?.archived
            ? `"${archiving?.name}" will be available for sales and purchases again.`
            : `"${archiving?.name}" will be hidden from new sales and purchases. Its sales and stock history are kept.${archiving && stockOnHand(state, archiving.id) > 0 ? ` Note: ${stockOnHand(state, archiving.id)} ${archiving.unit} are still recorded as on hand.` : ''}`
        }
        onConfirm={() => {
          if (!archiving) return;
          const res = run((s, c) => cmd.setProductArchived(s, archiving.id, !archiving.archived, c), archiving.archived ? 'Product restored.' : 'Product archived.');
          if (!res.ok) toast('error', res.error);
          setArchiving(null);
        }}
      />
    </>
  );
}

export function unitSingular(unit: string): string {
  const map: Record<string, string> = { birds: 'bird', eggs: 'egg', trays: 'tray', packs: 'pack', bags: 'bag' };
  return map[unit] ?? unit;
}

function ProductForm({ open, onClose, product }: { open: boolean; onClose: () => void; product?: Product }) {
  const { state, run, today, date } = useApp();
  const s = state.settings;
  const [name, setName] = useState(product?.name ?? '');
  const [category, setCategory] = useState(product?.category ?? s.productCategories[0]);
  const [unit, setUnit] = useState(product?.unit ?? s.units[0]?.name ?? '');
  const [price, setPrice] = useState<Cents | null>(product?.sellingPrice ?? null);
  const [cost, setCost] = useState<Cents | null>(product?.costPrice ?? null);
  const [costRaw, setCostRaw] = useState(product?.costPrice != null ? 'x' : '');
  const [threshold, setThreshold] = useState(product?.lowStockThreshold?.toString() ?? '');
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? true);
  const [opening, setOpening] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const symbol = currencySymbol(s.currency, s.locale);
  const hasHistory = product ? state.movements.some((m) => m.productId === product.id) : false;

  const reset = () => {
    setName(''); setPrice(null); setCost(null); setCostRaw(''); setThreshold(''); setOpening(''); setError(null); setTouched(false); setTrackStock(true);
    setCategory(s.productCategories[0]); setUnit(s.units[0]?.name ?? '');
  };
  const close = () => {
    if (!product) reset();
    onClose();
  };

  const submit = () => {
    setTouched(true);
    if (!name.trim() || price === null) return setError('Please fill in the required fields.');
    if (costRaw.trim() && cost === null) return setError('Cost price is not a valid amount.');
    const th = threshold.trim() === '' ? null : Number(threshold);
    if (th !== null && (!Number.isFinite(th) || th < 0)) return setError('Low-stock threshold must be a number of zero or more.');
    const open = opening.trim() === '' ? 0 : parseQty(opening);
    if (open === null || open < 0) return setError('Opening stock must be zero or a positive number.');
    const input: cmd.ProductInput = { name, category, unit, sellingPrice: price, costPrice: costRaw.trim() ? cost : null, lowStockThreshold: th, trackStock };
    const res = product
      ? run((st, c) => cmd.updateProduct(st, product.id, input, c), 'Product updated.')
      : run((st, c) => cmd.createProduct(st, { ...input, openingStock: open, date: today }, c).state, 'Product added.');
    if (!res.ok) return setError(res.error);
    close();
  };

  const unitOptions = s.units.map((u) => ({ value: u.name, label: `${u.name}${u.allowDecimal ? ' (decimals allowed)' : ''}` }));
  if (product && !s.units.some((u) => u.name === product.unit)) unitOptions.push({ value: product.unit, label: product.unit });
  const catOptions = s.productCategories.map((c) => ({ value: c, label: c }));
  if (product && !s.productCategories.includes(product.category)) catOptions.push({ value: product.category, label: product.category });

  return (
    <Modal
      open={open}
      onClose={close}
      title={product ? `Edit ${product.name}` : 'Add product'}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={submit}>{product ? 'Save changes' : 'Add product'}</Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Product name" required value={name} onChange={(e) => setName(e.target.value)} error={touched && !name.trim() ? 'Enter a product name.' : null} className="span-2" maxLength={80} autoFocus />
        <SelectInput label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={catOptions} />
        <SelectInput
          label="Unit"
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          options={unitOptions}
          disabled={hasHistory}
          hint={hasHistory ? 'Locked: stock has been recorded in this unit.' : 'Stock and sales are counted in this unit.'}
        />
        <MoneyInput label={`Selling price per ${unitSingular(unit)}`} required symbol={symbol} value={price} onChange={(c) => setPrice(c)} error={touched && price === null ? 'Enter a valid price.' : null} />
        <MoneyInput label="Cost price (optional)" symbol={symbol} value={cost} onChange={(c, raw) => { setCost(c); setCostRaw(raw); }} hint="Used to estimate the value of losses." />
        <TextInput label="Low-stock alert at" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder={`Default: ${s.defaultLowStockThreshold}`} hint="Leave blank to use the default." />
        {!product && trackStock && (
          <TextInput label={`Opening stock (${unit})`} inputMode="decimal" value={opening} onChange={(e) => setOpening(e.target.value)} placeholder="0" hint={`Recorded as of today (${date(today)}).`} />
        )}
        <label className="check span-2">
          <input type="checkbox" checked={trackStock} onChange={(e) => setTrackStock(e.target.checked)} />
          <span>Track stock quantity for this product</span>
        </label>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function AdjustStockDialog({
  product,
  direction: initialDirection,
  batchId: fixedBatch,
  onClose,
}: {
  product: Product;
  direction: 'in' | 'out';
  batchId?: ID;
  onClose: () => void;
}) {
  const { state, run, today, qty: fq } = useApp();
  const [direction, setDirection] = useState(initialDirection);
  const reasons = direction === 'in' ? cmd.STOCK_IN_REASONS : cmd.STOCK_OUT_REASONS;
  const [reason, setReason] = useState<MovementReason>(reasons[0]);
  const [quantity, setQuantity] = useState('');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [batchId, setBatchId] = useState<string>(fixedBatch ?? '');
  const [error, setError] = useState<string | null>(null);
  const onHand = stockOnHand(state, product.id);
  const batches = state.batches.filter((b) => b.productId === product.id && b.status === 'active');
  const parsed = parseQty(quantity);
  const after = parsed !== null ? onHand + (direction === 'in' ? parsed : -parsed) : null;
  const reasonOptions = reasons
    .filter((r) => r !== 'death' || product.unit === 'birds' || batchId)
    .map((r) => ({ value: r, label: cmd.REASON_LABELS[r] }));

  const submit = () => {
    if (parsed === null || parsed <= 0) return setError('Enter a quantity greater than zero.');
    const res = run(
      (s, c) => cmd.adjustStock(s, { productId: product.id, batchId: batchId || null, direction, quantity: parsed, reason, date, note }, c),
      'Stock updated.',
    );
    if (!res.ok) return setError(res.error);
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${direction === 'in' ? 'Add' : 'Remove'} stock — ${product.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>Record {direction === 'in' ? 'addition' : 'reduction'}</Button>
        </>
      }
    >
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <div className="segmented span-2" role="radiogroup" aria-label="Direction">
          <button type="button" role="radio" aria-checked={direction === 'in'} className={direction === 'in' ? 'on' : ''} onClick={() => { setDirection('in'); setReason(cmd.STOCK_IN_REASONS[0]); }}>
            <Plus size={14} /> Stock in
          </button>
          <button type="button" role="radio" aria-checked={direction === 'out'} className={direction === 'out' ? 'on' : ''} onClick={() => { setDirection('out'); setReason(cmd.STOCK_OUT_REASONS[0]); }}>
            <Minus size={14} /> Stock out
          </button>
        </div>
        <TextInput label={`Quantity (${product.unit})`} inputMode="decimal" required autoFocus value={quantity} onChange={(e) => setQuantity(e.target.value)} hint={`On hand: ${fq(onHand)} ${product.unit}${after !== null ? ` → after: ${fq(after)} ${product.unit}` : ''}`} error={after !== null && after < 0 ? 'This would make stock negative.' : null} />
        <SelectInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value as MovementReason)} options={reasonOptions} />
        {batches.length > 0 && state.settings.batchTrackingEnabled && !fixedBatch && (
          <SelectInput
            label="Poultry batch (optional)"
            value={batchId}
            onChange={(e) => setBatchId(e.target.value)}
            options={[{ value: '', label: 'Not linked to a batch' }, ...batches.map((b) => ({ value: b.id, label: `${b.reference} · ${b.name} (${batchQuantity(state, b.id)} left)` }))]}
          />
        )}
        <TextInput label="Date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
        <TextInput label="Note" value={note} onChange={(e) => setNote(e.target.value)} className="span-2" maxLength={300} hint={reason === 'other' || reason === 'count_correction' ? 'Required for this reason.' : 'Optional'} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function MovementHistory({ product, onClose }: { product: Product; onClose: () => void }) {
  const { state, qty, date } = useApp();
  const movements = state.movements
    .filter((m) => m.productId === product.id)
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt));
  let running = 0;
  const rows = movements.map((m) => {
    running = Math.round((running + m.quantity) * 1000) / 1000;
    return { m, running };
  });
  rows.reverse();
  const batchRef = (id: string | null) => (id ? state.batches.find((b) => b.id === id)?.reference : null);
  return (
    <Modal open onClose={onClose} title={`Stock history — ${product.name}`} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      {rows.length === 0 ? (
        <EmptyState title="No stock movements recorded" />
      ) : (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr><th>Date</th><th>Reason</th><th>Note</th><th className="r">Change</th><th className="r">Balance</th></tr>
            </thead>
            <tbody>
              {rows.map(({ m, running }) => (
                <tr key={m.id}>
                  <td data-label="Date">{date(m.date)}</td>
                  <td data-label="Reason">{cmd.REASON_LABELS[m.reason]}{batchRef(m.batchId) && <span className="muted"> · {batchRef(m.batchId)}</span>}</td>
                  <td data-label="Note">{m.ref?.kind === 'sale' ? <a href={`#/sales/${m.ref.id}`}>{m.note}</a> : m.note || <span className="muted">—</span>}</td>
                  <td data-label="Change" className={`r num ${m.quantity < 0 ? 'neg' : 'pos'}`}>{m.quantity > 0 ? '+' : ''}{qty(m.quantity)}</td>
                  <td data-label="Balance" className="r num">{qty(running)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
