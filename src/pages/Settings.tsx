import { Download, ImagePlus, Plus, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useApp } from '../app/AppContext';
import * as cmd from '../domain/commands';
import type { BusinessSettings, UnitDef } from '../domain/types';
import { isAppState } from '../data/store';
import { Button, Card, ConfirmDialog, ErrorBanner, PageHeader, TextInput, downloadFile } from '../ui/components';

export function SettingsPage() {
  const { state } = useApp();
  const st = state.settings;
  // Re-initialise each form when its stored values change (e.g. after a reset or restore).
  const k = (...v: unknown[]) => JSON.stringify(v);
  return (
    <>
      <PageHeader title="Settings" subtitle="Business details, lists and rules used throughout the app." />
      <div className="settings">
        <ProfileSection key={k(st.businessName, st.address, st.phone, st.email, st.logoDataUrl)} />
        <RegionalSection key={k(st.currency)} />
        <RulesSection key={k(st.defaultLowStockThreshold, st.maxDiscountPercent, st.batchTrackingEnabled)} />
        <ListsSection key={k(st.productCategories, st.expenseCategories, st.paymentMethods, st.units)} />
        <DataSection />
        <AuditSection />
        <Card title="About">
          <p>
            <strong>Chik-Biz</strong> is a poultry business management prototype developed by Auris Nexus Technologies (Pty) Ltd, the technology provider.
            The business name and logo above identify the poultry business using the system.
          </p>
          <p className="muted small">Version 0.1.0 · demonstration build</p>
        </Card>
      </div>
    </>
  );
}

function useSave() {
  const { run } = useApp();
  const [error, setError] = useState<string | null>(null);
  const save = (patch: Partial<BusinessSettings>, message = 'Settings saved.') => {
    const res = run((s, c) => cmd.updateSettings(s, patch, c), message);
    setError(res.ok ? null : res.error);
    return res.ok;
  };
  return { save, error };
}

function ProfileSection() {
  const { state } = useApp();
  const s = state.settings;
  const { save, error } = useSave();
  const [name, setName] = useState(s.businessName);
  const [address, setAddress] = useState(s.address);
  const [phone, setPhone] = useState(s.phone);
  const [email, setEmail] = useState(s.email);
  const [logo, setLogo] = useState(s.logoDataUrl);
  const [logoError, setLogoError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (f: File | undefined) => {
    setLogoError(null);
    if (!f) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml|gif)$/.test(f.type)) return setLogoError('Use a PNG, JPEG, WebP, GIF or SVG image.');
    if (f.size > cmd.MAX_LOGO_BYTES) return setLogoError('Image must be under 300 KB.');
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.onerror = () => setLogoError('Could not read that file.');
    reader.readAsDataURL(f);
  };

  return (
    <Card title="Business profile">
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save({ businessName: name, address, phone, email, logoDataUrl: logo }); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Business name" required value={name} onChange={(e) => setName(e.target.value)} maxLength={80} hint="Shown in the menu and on receipts." />
        <div className="field">
          <span className="label-like">Logo</span>
          <div className="logo-row">
            {logo ? <img src={logo} alt="Current logo" className="logo-preview" /> : <span className="logo-empty">No logo</span>}
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif" hidden onChange={(e) => onFile(e.target.files?.[0])} aria-label="Upload logo" />
            <Button size="sm" icon={<ImagePlus size={14} />} onClick={() => fileRef.current?.click()}>Upload</Button>
            {logo && <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => setLogo(null)}>Remove</Button>}
          </div>
          {logoError ? <p className="field-msg" role="alert">{logoError}</p> : <p className="field-hint">Under 300 KB. Stored in this browser only.</p>}
        </div>
        <TextInput label="Address" value={address} onChange={(e) => setAddress(e.target.value)} className="span-2" maxLength={500} />
        <TextInput label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
        <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} />
        <div className="span-2 form-actions"><Button type="submit" variant="primary">Save profile</Button></div>
      </form>
    </Card>
  );
}

const CURRENCIES = [
  { code: 'ZAR', locale: 'en-ZA', label: 'South African rand (R)' },
  { code: 'BWP', locale: 'en-BW', label: 'Botswana pula (P)' },
  { code: 'NAD', locale: 'en-NA', label: 'Namibian dollar (N$)' },
  { code: 'SZL', locale: 'en-SZ', label: 'Eswatini lilangeni (E)' },
  { code: 'LSL', locale: 'en-LS', label: 'Lesotho loti (L)' },
  { code: 'ZMW', locale: 'en-ZM', label: 'Zambian kwacha (K)' },
  { code: 'KES', locale: 'en-KE', label: 'Kenyan shilling (KSh)' },
  { code: 'NGN', locale: 'en-NG', label: 'Nigerian naira (₦)' },
  { code: 'USD', locale: 'en-US', label: 'US dollar ($)' },
  { code: 'EUR', locale: 'en-IE', label: 'Euro (€)' },
  { code: 'GBP', locale: 'en-GB', label: 'British pound (£)' },
];

function RegionalSection() {
  const { state, money } = useApp();
  const { save, error } = useSave();
  const [currency, setCurrency] = useState(state.settings.currency);
  const known = CURRENCIES.find((c) => c.code === currency);
  return (
    <Card title="Currency">
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save({ currency, locale: known?.locale ?? state.settings.locale }); }}>
        <ErrorBanner message={error} />
        <div className="field">
          <label htmlFor="currency">Currency</label>
          <select id="currency" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            {!known && <option value={currency}>{currency}</option>}
          </select>
          <p className="field-hint">Currently displayed as {money(123456)}. Changing currency only changes how amounts are displayed — it does not convert existing amounts.</p>
        </div>
        <div className="form-actions align-end"><Button type="submit" variant="primary">Save currency</Button></div>
      </form>
    </Card>
  );
}

function RulesSection() {
  const { state } = useApp();
  const s = state.settings;
  const { save, error } = useSave();
  const [threshold, setThreshold] = useState(String(s.defaultLowStockThreshold));
  const [maxDiscount, setMaxDiscount] = useState(String(s.maxDiscountPercent));
  const [batches, setBatches] = useState(s.batchTrackingEnabled);
  return (
    <Card title="Stock & sales rules">
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save({ defaultLowStockThreshold: Number(threshold), maxDiscountPercent: Number(maxDiscount), batchTrackingEnabled: batches }); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Default low-stock threshold" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} hint="Products at or below this quantity are flagged, unless the product has its own threshold." />
        <TextInput label="Maximum discount per sale line (%)" inputMode="numeric" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} hint="Set to 0 to disable discounts." />
        <label className="check span-2">
          <input type="checkbox" checked={batches} onChange={(e) => setBatches(e.target.checked)} />
          <span>Enable poultry batch tracking <span className="muted">(for businesses that raise or hold birds in batches)</span></span>
        </label>
        <div className="span-2 form-actions"><Button type="submit" variant="primary">Save rules</Button></div>
      </form>
    </Card>
  );
}

function ListEditor({ title, items, onChange, hint }: { title: string; items: string[]; onChange: (v: string[]) => void; hint?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || items.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    onChange([...items, v]);
    setDraft('');
  };
  return (
    <div className="list-editor">
      <h3>{title}</h3>
      {hint && <p className="field-hint">{hint}</p>}
      <ul className="chips">
        {items.map((i) => (
          <li key={i} className="chip-item">
            {i}
            <button type="button" aria-label={`Remove ${i}`} onClick={() => onChange(items.filter((x) => x !== i))}><X size={12} /></button>
          </li>
        ))}
      </ul>
      <div className="add-row">
        <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder={`Add ${title.toLowerCase().replace(/s$/, '')}…`} aria-label={`New ${title.toLowerCase()}`} maxLength={40} />
        <Button size="sm" icon={<Plus size={14} />} onClick={add} disabled={!draft.trim()}>Add</Button>
      </div>
    </div>
  );
}

function ListsSection() {
  const { state } = useApp();
  const s = state.settings;
  const { save, error } = useSave();
  const [productCategories, setPC] = useState(s.productCategories);
  const [expenseCategories, setEC] = useState(s.expenseCategories);
  const [paymentMethods, setPM] = useState(s.paymentMethods);
  const [units, setUnits] = useState<UnitDef[]>(s.units);
  const [unitDraft, setUnitDraft] = useState('');
  const [unitDecimal, setUnitDecimal] = useState(false);
  const dirty =
    JSON.stringify([productCategories, expenseCategories, paymentMethods, units]) !==
    JSON.stringify([s.productCategories, s.expenseCategories, s.paymentMethods, s.units]);

  return (
    <Card title="Categories, units & payment methods">
      <ErrorBanner message={error} />
      <div className="lists-grid">
        <ListEditor title="Product categories" items={productCategories} onChange={setPC} />
        <ListEditor title="Expense categories" items={expenseCategories} onChange={setEC} hint="Past expenses keep their category even if it is removed." />
        <ListEditor title="Payment methods" items={paymentMethods} onChange={setPM} />
        <div className="list-editor">
          <h3>Units of measurement</h3>
          <p className="field-hint">Units are never converted automatically. A unit used by a product cannot be removed.</p>
          <ul className="chips">
            {units.map((u) => (
              <li key={u.name} className="chip-item">
                {u.name}{u.allowDecimal && <span className="muted"> · decimals</span>}
                <button type="button" aria-label={`Remove unit ${u.name}`} onClick={() => setUnits(units.filter((x) => x.name !== u.name))}><X size={12} /></button>
              </li>
            ))}
          </ul>
          <div className="add-row">
            <input className="input" value={unitDraft} onChange={(e) => setUnitDraft(e.target.value)} placeholder="e.g. bags" aria-label="New unit" maxLength={20} />
            <label className="check small"><input type="checkbox" checked={unitDecimal} onChange={(e) => setUnitDecimal(e.target.checked)} /><span>Decimals</span></label>
            <Button
              size="sm"
              icon={<Plus size={14} />}
              disabled={!unitDraft.trim()}
              onClick={() => {
                const n = unitDraft.trim();
                if (units.some((u) => u.name.toLowerCase() === n.toLowerCase())) return;
                setUnits([...units, { name: n, allowDecimal: unitDecimal }]);
                setUnitDraft('');
                setUnitDecimal(false);
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
      <div className="form-actions mt">
        <Button disabled={!dirty} onClick={() => { setPC(s.productCategories); setEC(s.expenseCategories); setPM(s.paymentMethods); setUnits(s.units); }}>Discard changes</Button>
        <Button variant="primary" disabled={!dirty} onClick={() => save({ productCategories, expenseCategories, paymentMethods, units }, 'Lists saved.')}>Save lists</Button>
      </div>
    </Card>
  );
}

function DataSection() {
  const { state, store, toast } = useApp();
  const [confirm, setConfirm] = useState<'reset' | 'clear' | 'import' | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const counts = `${state.products.length} products, ${state.sales.length} sales, ${state.expenses.length} expenses, ${state.customers.length} customers`;

  const onImport = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5_000_000) return toast('error', 'Backup file is too large.');
    f.text().then((t) => {
      try {
        const parsed: unknown = JSON.parse(t);
        if (!isAppState(parsed)) throw new Error('bad');
        setPending(t);
        setConfirm('import');
      } catch {
        toast('error', 'That file is not a valid Chik-Biz backup.');
      }
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <Card title="Data">
      <div className="alert alert-info">
        This prototype stores data in this browser’s local storage only. It is not shared between devices or users, is not backed up automatically, and is lost if browser data is cleared. Do not enter sensitive personal information.
      </div>
      <p className="muted">Currently stored: {counts}{state.isSampleData ? ' (includes fictional sample data)' : ''}.</p>
      <div className="button-row">
        <Button icon={<Download size={16} />} onClick={() => downloadFile(`chik-biz-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(state, null, 2), 'application/json')}>Download backup</Button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => onImport(e.target.files?.[0])} aria-label="Restore from backup file" />
        <Button icon={<Upload size={16} />} onClick={() => fileRef.current?.click()}>Restore backup…</Button>
        <Button icon={<RotateCcw size={16} />} onClick={() => setConfirm('reset')}>Reset sample data</Button>
        <Button variant="danger" icon={<Trash2 size={16} />} onClick={() => setConfirm('clear')}>Start with empty data</Button>
      </div>
      <ConfirmDialog
        open={confirm === 'reset'}
        onClose={() => setConfirm(null)}
        title="Reset sample data?"
        confirmLabel="Reset data"
        message="All records in this browser — including anything you have added — will be replaced with fresh fictional sample data."
        onConfirm={() => { store.resetToSample(); setConfirm(null); toast('success', 'Sample data has been reset.'); }}
      />
      <ConfirmDialog
        open={confirm === 'clear'}
        onClose={() => setConfirm(null)}
        title="Delete all records?"
        confirmLabel="Delete everything"
        message="All products, sales, customers, expenses, suppliers, batches and stock history in this browser will be permanently deleted. Your settings (business name, lists, currency) are kept."
        onConfirm={() => { store.clearAll(); setConfirm(null); toast('success', 'All records deleted. You are starting fresh.'); }}
      />
      <ConfirmDialog
        open={confirm === 'import'}
        onClose={() => { setConfirm(null); setPending(null); }}
        title="Restore this backup?"
        confirmLabel="Replace current data"
        message="Everything currently stored in this browser will be replaced by the contents of the backup file."
        onConfirm={() => {
          if (pending) store.replace(JSON.parse(pending));
          setPending(null);
          setConfirm(null);
          toast('success', 'Backup restored.');
        }}
      />
    </Card>
  );
}

function AuditSection() {
  const { state } = useApp();
  const [all, setAll] = useState(false);
  const entries = all ? state.audit : state.audit.slice(0, 15);
  return (
    <Card title="Activity log" pad={false}>
      <p className="card-note">Changes made in this browser since the data was last reset. Stock movements and payments also keep their own history.</p>
      {entries.length === 0 ? (
        <p className="card-note muted">No changes recorded yet.</p>
      ) : (
        <ul className="audit">
          {entries.map((e) => (
            <li key={e.id}>
              <time dateTime={e.at}>{new Date(e.at).toLocaleString(state.settings.locale, { dateStyle: 'medium', timeStyle: 'short' })}</time>
              <span>{e.summary}</span>
            </li>
          ))}
        </ul>
      )}
      {state.audit.length > 15 && (
        <div className="card-note"><Button size="sm" variant="ghost" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${state.audit.length}`}</Button></div>
      )}
    </Card>
  );
}
