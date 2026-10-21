import { Archive, ArchiveRestore, ArrowLeft, Pencil, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { navigate, setQuery, useRoute } from '../app/router';
import * as cmd from '../domain/commands';
import { allSaleViews, customerBalance } from '../domain/selectors';
import type { Customer } from '../domain/types';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBanner, LinkButton, Modal, PageHeader, SearchBox, Stat, TextArea, TextInput, useSingleFlight } from '../ui/components';
import { newId } from '../data/store';
import { statusBadge } from './Sales';

export function CustomersPage() {
  const { state, money } = useApp();
  const { query } = useRoute();
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [owingOnly, setOwingOnly] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return state.customers
      .filter((c) => (showArchived ? c.archived : !c.archived))
      .filter((c) => !q || [c.name, c.businessName, c.phone, c.email].some((f) => f.toLowerCase().includes(q)))
      .map((c) => {
        const sales = state.sales.filter((s) => s.customerId === c.id && s.status === 'completed');
        return { c, balance: customerBalance(state, c.id), salesCount: sales.length, lastSale: sales.map((s) => s.date).sort().pop() };
      })
      .filter((r) => !owingOnly || r.balance > 0)
      .sort((a, b) => a.c.name.localeCompare(b.c.name));
  }, [state, search, showArchived, owingOnly]);

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Balances are calculated from each customer’s sales and payments."
        actions={<Button variant="primary" icon={<Plus size={16} />} onClick={() => setQuery({ new: '1' })}>Add customer</Button>}
      />
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Name, business, phone…" label="Search customers" />
        <label className="check"><input type="checkbox" checked={owingOnly} onChange={(e) => setOwingOnly(e.target.checked)} /><span>Owing only</span></label>
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /><span>Archived</span></label>
      </div>
      <Card pad={false}>
        {rows.length === 0 ? (
          <EmptyState title={state.customers.length === 0 ? 'No customers yet' : 'No customers match'} icon={<Users size={28} />} action={state.customers.length === 0 ? <Button variant="primary" onClick={() => setQuery({ new: '1' })}>Add a customer</Button> : undefined}>
            Walk-in sales do not need a customer record. Add regular and credit customers here.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table hover">
              <thead><tr><th>Name</th><th>Contact</th><th className="r">Sales</th><th>Last sale</th><th className="r">Balance owed</th></tr></thead>
              <tbody>
                {rows.map(({ c, balance, salesCount, lastSale }) => (
                  <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)}>
                    <td data-label="Name"><a href={`#/customers/${c.id}`} onClick={(e) => e.stopPropagation()}><strong>{c.name}</strong></a>{c.businessName && <div className="muted small">{c.businessName}</div>}</td>
                    <td data-label="Contact">{c.phone || c.email || <span className="muted">—</span>}</td>
                    <td data-label="Sales" className="r num">{salesCount}</td>
                    <td data-label="Last sale">{lastSale ?? <span className="muted">—</span>}</td>
                    <td data-label="Balance" className="r num">{balance > 0 ? <Badge tone="warn">{money(balance)}</Badge> : money(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {query.get('new') === '1' && <CustomerForm onClose={() => setQuery({ new: '' })} />}
    </>
  );
}

function CustomerForm({ customer, onClose }: { customer?: Customer; onClose: () => void }) {
  const { run } = useApp();
  const [f, setF] = useState<cmd.CustomerInput>({
    name: customer?.name ?? '',
    businessName: customer?.businessName ?? '',
    phone: customer?.phone ?? '',
    email: customer?.email ?? '',
    address: customer?.address ?? '',
    notes: customer?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const set = (k: keyof cmd.CustomerInput) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { busy, guard } = useSingleFlight();
  const submit = () => guard(async () => {
    setTouched(true);
    const res = customer
      ? await run({ type: 'updateCustomer', id: customer.id, input: f }, 'Customer updated.')
      : await run({ type: 'createCustomer', input: { ...f, id: newId() } }, 'Customer added.');
    if (!res.ok) return setError(res.error);
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={customer ? `Edit ${customer.name}` : 'Add customer'} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={busy}>{customer ? 'Save' : 'Add customer'}</Button></>}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <ErrorBanner message={error} />
        <TextInput label="Name" required autoFocus value={f.name} onChange={set('name')} maxLength={80} error={touched && !f.name.trim() ? 'Enter a name.' : null} />
        <TextInput label="Business name" value={f.businessName} onChange={set('businessName')} maxLength={80} hint="Optional" />
        <TextInput label="Phone" type="tel" value={f.phone} onChange={set('phone')} maxLength={40} />
        <TextInput label="Email" type="email" value={f.email} onChange={set('email')} maxLength={120} />
        <TextInput label="Address" value={f.address} onChange={set('address')} className="span-2" maxLength={500} />
        <div className="span-2"><TextArea label="Notes" value={f.notes} onChange={set('notes')} maxLength={500} /></div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function CustomerDetail({ id }: { id: string }) {
  const { state, money, date, run, toast } = useApp();
  const customer = state.customers.find((c) => c.id === id);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  if (!customer) return <EmptyState title="Customer not found" action={<LinkButton href="#/customers">Back to customers</LinkButton>} />;
  const views = allSaleViews(state)
    .filter((v) => v.sale.customerId === id)
    .sort((a, b) => b.sale.date.localeCompare(a.sale.date) || b.sale.number.localeCompare(a.sale.number));
  const completed = views.filter((v) => v.sale.status === 'completed');
  const balance = customerBalance(state, id);
  const totalBought = completed.reduce((a, v) => a + v.totals.total, 0);
  const totalPaid = completed.reduce((a, v) => a + v.paid, 0);

  return (
    <>
      <a href="#/customers" className="back-link"><ArrowLeft size={16} /> Customers</a>
      <PageHeader
        title={customer.name}
        subtitle={<>{customer.businessName && <>{customer.businessName} · </>}{[customer.phone, customer.email].filter(Boolean).join(' · ') || 'No contact details'}{customer.archived && <> · <Badge>Archived</Badge></>}</>}
        actions={
          <>
            {!customer.archived && <LinkButton href={`#/sales/new?customer=${customer.id}`} variant="primary" icon={<Plus size={16} />}>New sale</LinkButton>}
            <Button variant="ghost" icon={<Pencil size={16} />} onClick={() => setEditing(true)}>Edit</Button>
            <Button variant="ghost" icon={customer.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />} onClick={() => setArchiving(true)}>{customer.archived ? 'Restore' : 'Archive'}</Button>
          </>
        }
      />
      <div className="stats-grid three">
        <Stat label="Balance owed" value={money(balance)} tone={balance > 0 ? 'warn' : 'good'} />
        <Stat label="Total purchases" value={money(totalBought)} hint={`${completed.length} sale${completed.length === 1 ? '' : 's'}`} />
        <Stat label="Total paid" value={money(totalPaid)} />
      </div>
      {(customer.address || customer.notes) && (
        <Card title="Details" className="mb">
          {customer.address && <p><span className="muted">Address:</span> {customer.address}</p>}
          {customer.notes && <p><span className="muted">Notes:</span> {customer.notes}</p>}
        </Card>
      )}
      <Card title="Sales history" pad={false}>
        {views.length === 0 ? (
          <EmptyState title="No sales yet for this customer" />
        ) : (
          <div className="table-wrap">
            <table className="table hover">
              <thead><tr><th>Sale</th><th>Date</th><th className="r">Total</th><th className="r">Paid</th><th className="r">Balance</th><th>Status</th></tr></thead>
              <tbody>
                {views.map((v) => (
                  <tr key={v.sale.id} onClick={() => navigate(`/sales/${v.sale.id}`)} className={v.sale.status === 'voided' ? 'voided' : ''}>
                    <td data-label="Sale"><a href={`#/sales/${v.sale.id}`} onClick={(e) => e.stopPropagation()}>{v.sale.number}</a></td>
                    <td data-label="Date">{date(v.sale.date)}</td>
                    <td data-label="Total" className="r num">{money(v.totals.total)}</td>
                    <td data-label="Paid" className="r num">{money(v.paid)}</td>
                    <td data-label="Balance" className="r num">{v.sale.status === 'voided' ? '—' : money(v.balance)}</td>
                    <td data-label="Status">{statusBadge(v.sale.status === 'voided' ? 'voided' : v.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing && <CustomerForm customer={customer} onClose={() => setEditing(false)} />}
      <ConfirmDialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={customer.archived ? 'Restore customer?' : 'Archive customer?'}
        tone={customer.archived ? 'primary' : 'danger'}
        confirmLabel={customer.archived ? 'Restore' : 'Archive'}
        message={
          customer.archived
            ? 'The customer will be available for new sales again.'
            : `The customer will be hidden from new sales. Their sales history${balance > 0 ? ` and outstanding balance of ${money(balance)}` : ''} will be kept, and payments can still be recorded against existing sales.`
        }
        onConfirm={async () => {
          const res = await run({ type: 'setCustomerArchived', id: customer.id, archived: !customer.archived }, customer.archived ? 'Customer restored.' : 'Customer archived.');
          if (!res.ok) toast('error', res.error);
          setArchiving(false);
        }}
      />
    </>
  );
}
