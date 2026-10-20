import { Download, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { setQuery, useRoute } from '../app/router';
import * as cmd from '../domain/commands';
import { centsToDecimal, expensesByCategory, expensesInRange, toCSV } from '../domain/reports';
import type { Cents, Expense } from '../domain/types';
import { newId } from '../data/store';
import { Button, Card, ConfirmDialog, DateRange, EmptyState, ErrorBanner, Modal, MoneyInput, PageHeader, SearchBox, SelectInput, TextInput, currencySymbol, downloadFile } from '../ui/components';

export function ExpensesPage() {
  const { state, money, date, run, toast } = useApp();
  const { query } = useRoute();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [editing, setEditing] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';
  const suppliers = new Map(state.suppliers.map((s) => [s.id, s.name]));

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return expensesInRange(state, { from, to }).filter(
      (e) =>
        (!category || e.category === category) &&
        (!q || [e.description, e.reference, e.category, suppliers.get(e.supplierId ?? '') ?? ''].some((f) => f.toLowerCase().includes(q))),
    );
  }, [state, from, to, category, search]);
  const total = rows.reduce((a, e) => a + e.amount, 0);
  const byCat = expensesByCategory(state, { from, to });
  const allCategories = [...new Set([...state.settings.expenseCategories, ...state.expenses.map((e) => e.category)])];

  const exportCsv = () =>
    downloadFile(
      `expenses_${from || 'all'}_${to || 'all'}.csv`,
      toCSV(
        ['Date', 'Category', 'Description', 'Amount', 'Payment method', 'Supplier', 'Reference'],
        rows.map((e) => [e.date, e.category, e.description, centsToDecimal(e.amount), e.method, suppliers.get(e.supplierId ?? '') ?? '', e.reference]),
      ),
    );

  return (
    <>
      <PageHeader
        title="Expenses"
        actions={
          <>
            <Button icon={<Download size={16} />} onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>
            <Button variant="primary" icon={<Plus size={16} />} onClick={() => setQuery({ new: '1' })}>Add expense</Button>
          </>
        }
      />
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Description, supplier, reference…" label="Search expenses" />
        <DateRange from={from} to={to} onChange={(f, t) => setQuery({ from: f, to: t })} />
        <select className="input" aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {allCategories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="summary-strip">
        <div><span className="muted">Shown</span><strong className="num">{rows.length}</strong></div>
        <div><span className="muted">Total</span><strong className="num">{money(total)}</strong></div>
        {byCat.slice(0, 3).map((c) => (
          <div key={c.category}><span className="muted">{c.category}{from || to ? '' : ' (all time)'}</span><strong className="num">{money(c.total)}</strong></div>
        ))}
      </div>
      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState title={state.expenses.length === 0 ? 'No expenses recorded yet' : 'No expenses match these filters'} icon={<Wallet size={28} />} action={state.expenses.length === 0 ? <Button variant="primary" onClick={() => setQuery({ new: '1' })}>Add an expense</Button> : undefined} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Method</th><th className="r">Amount</th><th className="r"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td data-label="Date">{date(e.date)}</td>
                    <td data-label="Category">{e.category}</td>
                    <td data-label="Description">{e.description}{(e.supplierId || e.reference) && <div className="muted small">{[suppliers.get(e.supplierId ?? ''), e.reference].filter(Boolean).join(' · ')}</div>}</td>
                    <td data-label="Method">{e.method}</td>
                    <td data-label="Amount" className="r num">{money(e.amount)}</td>
                    <td className="r actions-cell">
                      <Button size="sm" variant="ghost" icon={<Pencil size={14} />} onClick={() => setEditing(e)} aria-label={`Edit ${e.description}`} title="Edit" />
                      <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => setDeleting(e)} aria-label={`Delete ${e.description}`} title="Delete" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {query.get('new') === '1' && <ExpenseForm onClose={() => setQuery({ new: '' })} />}
      {editing && <ExpenseForm expense={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete expense?"
        confirmLabel="Delete"
        message={deleting ? `“${deleting.description}” (${money(deleting.amount)} on ${date(deleting.date)}) will be removed from all totals and reports. The deletion is recorded in the activity log.` : ''}
        onConfirm={() => {
          if (!deleting) return;
          const res = run((s, c) => cmd.deleteExpense(s, deleting.id, c), 'Expense deleted.');
          if (!res.ok) toast('error', res.error);
          setDeleting(null);
        }}
      />
    </>
  );
}

function ExpenseForm({ expense, onClose }: { expense?: Expense; onClose: () => void }) {
  const { state, run, today } = useApp();
  const st = state.settings;
  const [id] = useState(newId);
  const [date, setDate] = useState(expense?.date ?? today);
  const [category, setCategory] = useState(expense?.category ?? st.expenseCategories[0]);
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amount, setAmount] = useState<Cents | null>(expense?.amount ?? null);
  const [method, setMethod] = useState(expense?.method ?? st.paymentMethods[0]);
  const [supplierId, setSupplierId] = useState(expense?.supplierId ?? '');
  const [reference, setReference] = useState(expense?.reference ?? '');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const catOptions = st.expenseCategories.map((c) => ({ value: c, label: c }));
  if (expense && !st.expenseCategories.includes(expense.category)) catOptions.push({ value: expense.category, label: expense.category });

  const submit = () => {
    if (busy) return;
    setTouched(true);
    if (!description.trim() || amount === null || amount <= 0) return setError('Please complete the required fields.');
    setBusy(true);
    const input: cmd.ExpenseInput = { date, category, description, amount, method, supplierId: supplierId || null, reference };
    const res = expense
      ? run((s, c) => cmd.updateExpense(s, expense.id, input, c), 'Expense updated.')
      : run((s, c) => cmd.createExpense(s, { ...input, id }, c).state, 'Expense recorded.');
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onClose();
  };

  return (
    <Modal open onClose={onClose} title={expense ? 'Edit expense' : 'Add expense'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>{expense ? 'Save' : 'Add expense'}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Description" required autoFocus value={description} onChange={(e) => setDescription(e.target.value)} className="span-2" maxLength={160} error={touched && !description.trim() ? 'Enter a description.' : null} />
        <MoneyInput label="Amount" required symbol={currencySymbol(st.currency, st.locale)} value={amount} onChange={(c) => setAmount(c)} error={touched && (amount === null || amount <= 0) ? 'Enter an amount greater than zero.' : null} />
        <TextInput label="Date" type="date" max={today} value={date} onChange={(e) => setDate(e.target.value)} />
        <SelectInput label="Category" value={category} onChange={(e) => setCategory(e.target.value)} options={catOptions} hint={<a href="#/settings">Manage categories</a>} />
        <SelectInput label="Payment method" value={method} onChange={(e) => setMethod(e.target.value)} options={st.paymentMethods.map((m) => ({ value: m, label: m }))} />
        <SelectInput label="Supplier (optional)" value={supplierId} onChange={(e) => setSupplierId(e.target.value)} options={[{ value: '', label: 'None' }, ...state.suppliers.filter((s) => !s.archived || s.id === expense?.supplierId).map((s) => ({ value: s.id, label: s.name }))]} />
        <TextInput label="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} placeholder="Invoice or slip number" />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
