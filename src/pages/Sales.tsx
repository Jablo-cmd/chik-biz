import { Download, Plus, ReceiptText } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { setQuery, useRoute, navigate } from '../app/router';
import { centsToDecimal, salesInRange, salesSummary, toCSV } from '../domain/reports';
import type { PaymentStatus } from '../domain/selectors';
import { Badge, Button, Card, DateRange, EmptyState, LinkButton, PageHeader, SearchBox, downloadFile } from '../ui/components';

export function statusBadge(status: PaymentStatus | 'voided') {
  switch (status) {
    case 'paid':
      return <Badge tone="good">Paid</Badge>;
    case 'partial':
      return <Badge tone="warn">Part paid</Badge>;
    case 'unpaid':
      return <Badge tone="bad">Unpaid</Badge>;
    default:
      return <Badge>Voided</Badge>;
  }
}

export function SalesPage() {
  const { state, money, date } = useApp();
  const { query } = useRoute();
  const [search, setSearch] = useState('');
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';
  const status = query.get('status') ?? '';

  const views = useMemo(() => {
    const q = search.trim().toLowerCase();
    return salesInRange(state, { from, to }).filter((v) => {
      const st = v.sale.status === 'voided' ? 'voided' : v.status;
      if (status && st !== status) return false;
      if (!q) return true;
      return (
        v.sale.number.toLowerCase().includes(q) ||
        v.customerName.toLowerCase().includes(q) ||
        v.sale.lines.some((l) => l.description.toLowerCase().includes(q))
      );
    });
  }, [state, from, to, status, search]);
  const summary = salesSummary(views);

  const exportCsv = () => {
    const rows = views.map((v) => [
      v.sale.number,
      v.sale.date,
      v.customerName,
      v.sale.status,
      v.sale.lines.map((l) => `${l.quantity} ${l.unit} ${l.description}`).join('; '),
      centsToDecimal(v.totals.subtotal),
      centsToDecimal(v.totals.discount),
      centsToDecimal(v.totals.total),
      centsToDecimal(v.paid),
      centsToDecimal(v.sale.status === 'voided' ? 0 : v.balance),
      v.sale.status === 'voided' ? 'voided' : v.status,
    ]);
    downloadFile(
      `sales_${from || 'all'}_${to || 'all'}.csv`,
      toCSV(['Sale', 'Date', 'Customer', 'Record status', 'Items', 'Subtotal', 'Discount', 'Total', 'Paid', 'Balance', 'Payment status'], rows),
    );
  };

  return (
    <>
      <PageHeader
        title="Sales"
        actions={
          <>
            <Button icon={<Download size={16} />} onClick={exportCsv} disabled={views.length === 0}>Export CSV</Button>
            <LinkButton href="#/sales/new" variant="primary" icon={<Plus size={16} />}>New sale</LinkButton>
          </>
        }
      />
      <div className="toolbar">
        <SearchBox value={search} onChange={setSearch} placeholder="Sale no., customer or product…" label="Search sales" />
        <DateRange from={from} to={to} onChange={(f, t) => setQuery({ from: f, to: t })} />
        <select className="input" aria-label="Filter by payment status" value={status} onChange={(e) => setQuery({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="paid">Paid</option>
          <option value="partial">Part paid</option>
          <option value="unpaid">Unpaid</option>
          <option value="voided">Voided</option>
        </select>
        {(from || to || status) && <Button variant="ghost" onClick={() => setQuery({ from: '', to: '', status: '' })}>Clear filters</Button>}
      </div>
      <div className="summary-strip">
        <div><span className="muted">Sales</span><strong className="num">{summary.count}</strong></div>
        <div><span className="muted">Revenue</span><strong className="num">{money(summary.revenue)}</strong></div>
        <div><span className="muted">Paid on these sales</span><strong className="num">{money(summary.collectedOnTheseSales)}</strong></div>
        <div><span className="muted">Still owed</span><strong className="num">{money(summary.outstandingOnTheseSales)}</strong></div>
      </div>
      <Card pad={false}>
        {views.length === 0 ? (
          <EmptyState title={state.sales.length === 0 ? 'No sales recorded yet' : 'No sales match these filters'} icon={<ReceiptText size={28} />} action={state.sales.length === 0 ? <LinkButton href="#/sales/new" variant="primary">Record a sale</LinkButton> : undefined} />
        ) : (
          <div className="table-wrap">
            <table className="table hover">
              <thead>
                <tr><th>Sale</th><th>Date</th><th>Customer</th><th className="r">Total</th><th className="r">Balance</th><th>Status</th></tr>
              </thead>
              <tbody>
                {views.map((v) => (
                  <tr key={v.sale.id} onClick={() => navigate(`/sales/${v.sale.id}`)} className={v.sale.status === 'voided' ? 'voided' : ''}>
                    <td data-label="Sale"><a href={`#/sales/${v.sale.id}`} onClick={(e) => e.stopPropagation()}>{v.sale.number}</a></td>
                    <td data-label="Date">{date(v.sale.date)}</td>
                    <td data-label="Customer">{v.customerName}</td>
                    <td data-label="Total" className="r num">{money(v.totals.total)}</td>
                    <td data-label="Balance" className="r num">{v.sale.status === 'voided' ? '—' : money(v.balance)}</td>
                    <td data-label="Status">{statusBadge(v.sale.status === 'voided' ? 'voided' : v.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
