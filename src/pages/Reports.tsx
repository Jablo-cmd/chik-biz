import { Download, Info } from 'lucide-react';
import { useMemo } from 'react';
import { useApp } from '../app/AppContext';
import { setQuery, useRoute } from '../app/router';
import { REASON_LABELS } from '../domain/commands';
import { addDays } from '../domain/format';
import {
  PERFORMANCE_ASSUMPTIONS,
  centsToDecimal,
  expensesByCategory,
  expensesInRange,
  inventoryAsOf,
  lossSummary,
  movementsInRange,
  operatingPerformance,
  paymentsInRange,
  receivablesAsOf,
  salesInRange,
  salesSummary,
  toCSV,
  type DateRange as Range,
} from '../domain/reports';
import { Badge, Button, Card, DateRange, EmptyState, PageHeader, Stat, Tabs, downloadFile } from '../ui/components';

type Tab = 'performance' | 'sales' | 'expenses' | 'payments' | 'receivables' | 'inventory' | 'movements';

export function ReportsPage() {
  const { today } = useApp();
  const { query } = useRoute();
  const tab = (query.get('tab') as Tab) || 'performance';
  const monthStart = today.slice(0, 8) + '01';
  // '-' in the URL means "no limit", so that "All time" survives a reload.
  const read = (k: string, fallback: string) => (query.has(k) ? (query.get(k) === '-' ? '' : query.get(k)!) : fallback);
  const from = read('from', monthStart);
  const to = read('to', today);
  const setRange = (f: string, t: string) => setQuery({ from: f || '-', to: t || '-' });
  const range: Range = { from, to };

  const presets: { label: string; from: string; to: string }[] = [
    { label: 'Today', from: today, to: today },
    { label: 'Last 7 days', from: addDays(today, -6), to: today },
    { label: 'This month', from: monthStart, to: today },
    { label: 'Last 30 days', from: addDays(today, -29), to: today },
    { label: 'All time', from: '', to: '' },
  ];

  return (
    <>
      <PageHeader title="Reports" subtitle="All figures are calculated from recorded transactions for the selected period." />
      <div className="toolbar">
        <DateRange from={from} to={to} onChange={setRange} />
        <div className="presets" role="group" aria-label="Date presets">
          {presets.map((p) => (
            <button key={p.label} type="button" className={`chip ${p.from === from && p.to === to ? 'on' : ''}`} onClick={() => setRange(p.from, p.to)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <Tabs<Tab>
        label="Report"
        value={tab}
        onChange={(t) => setQuery({ tab: t })}
        tabs={[
          { value: 'performance', label: 'Overview' },
          { value: 'sales', label: 'Sales' },
          { value: 'expenses', label: 'Expenses' },
          { value: 'payments', label: 'Payments' },
          { value: 'receivables', label: 'Owed by customers' },
          { value: 'inventory', label: 'Inventory' },
          { value: 'movements', label: 'Stock movements & losses' },
        ]}
      />
      {tab === 'performance' && <Performance range={range} />}
      {tab === 'sales' && <SalesReport range={range} />}
      {tab === 'expenses' && <ExpensesReport range={range} />}
      {tab === 'payments' && <PaymentsReport range={range} />}
      {tab === 'receivables' && <ReceivablesReport range={range} />}
      {tab === 'inventory' && <InventoryReport range={range} />}
      {tab === 'movements' && <MovementsReport range={range} />}
    </>
  );
}

function rangeLabel(r: Range, date: (d: string) => string) {
  if (!r.from && !r.to) return 'All time';
  return `${r.from ? date(r.from) : 'Beginning'} – ${r.to ? date(r.to) : 'today'}`;
}

function fileSuffix(r: Range) {
  return `${r.from || 'start'}_${r.to || 'today'}`;
}

function ExportButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <Button size="sm" icon={<Download size={14} />} onClick={onClick} disabled={disabled}>Export CSV</Button>;
}

function Performance({ range }: { range: Range }) {
  const { state, money, date } = useApp();
  const p = useMemo(() => operatingPerformance(state, range), [state, range.from, range.to]);
  const exportCsv = () =>
    downloadFile(
      `overview_${fileSuffix(range)}.csv`,
      toCSV(['Measure', 'Amount'], [
        ['Period', rangeLabel(range, (d) => d)],
        ['Sales revenue (completed sales)', centsToDecimal(p.revenue)],
        ['Cash collected from customers', centsToDecimal(p.cashIn)],
        ['Expenses recorded', centsToDecimal(p.expenses)],
        ['Stock purchases received', centsToDecimal(p.stockPurchases)],
        ['Batch starting costs', centsToDecimal(p.batchStartingCosts)],
        ['Supplier payments made', centsToDecimal(p.supplierPaymentsOut)],
        ['Estimated operating result', centsToDecimal(p.estimatedOperatingResult)],
        ['Estimated net cash flow', centsToDecimal(p.estimatedNetCashFlow)],
      ]),
    );
  return (
    <>
      <div className="stats-grid">
        <Stat label="Sales revenue" value={money(p.revenue)} hint="Value of completed sales, paid or not" />
        <Stat label="Cash collected" value={money(p.cashIn)} hint="Customer payments received in the period" tone="good" />
        <Stat label="Expenses" value={money(p.expenses)} hint="Recorded operating expenses" />
        <Stat label="Owed by customers" value={money(receivablesAsOf(state, range.to).reduce((a, r) => a + r.outstanding, 0))} hint={`As at ${range.to ? date(range.to) : 'today'}`} tone="warn" />
      </div>
      <div className="two-col">
        <Card title="Estimated operating result" actions={<ExportButton onClick={exportCsv} />}>
          <dl className="totals">
            <div><dt>Sales revenue</dt><dd className="num">{money(p.revenue)}</dd></div>
            <div><dt>less Expenses</dt><dd className="num">−{money(p.expenses)}</dd></div>
            <div><dt>less Stock purchases received</dt><dd className="num">−{money(p.stockPurchases)}</dd></div>
            <div><dt>less Batch starting costs</dt><dd className="num">−{money(p.batchStartingCosts)}</dd></div>
            <div className="grand"><dt>Estimated operating result</dt><dd className={`num ${p.estimatedOperatingResult < 0 ? 'neg' : ''}`}>{money(p.estimatedOperatingResult)}</dd></div>
          </dl>
          <dl className="totals mt">
            <div><dt>Cash collected</dt><dd className="num">{money(p.cashIn)}</dd></div>
            <div><dt>less Expenses</dt><dd className="num">−{money(p.expenses)}</dd></div>
            <div><dt>less Supplier payments</dt><dd className="num">−{money(p.supplierPaymentsOut)}</dd></div>
            <div className="grand"><dt>Estimated net cash flow</dt><dd className={`num ${p.estimatedNetCashFlow < 0 ? 'neg' : ''}`}>{money(p.estimatedNetCashFlow)}</dd></div>
          </dl>
        </Card>
        <Card title={<span className="with-icon"><Info size={16} /> How this is estimated</span>}>
          <p className="muted">This is <strong>not</strong> a net profit figure. It is based on these assumptions:</p>
          <ul className="assumptions">
            {PERFORMANCE_ASSUMPTIONS.map((a) => <li key={a}>{a}</li>)}
          </ul>
        </Card>
      </div>
    </>
  );
}

function SalesReport({ range }: { range: Range }) {
  const { state, money, date } = useApp();
  const views = useMemo(() => salesInRange(state, range), [state, range.from, range.to]);
  const s = salesSummary(views);
  const byProduct = useMemo(() => {
    const m = new Map<string, { name: string; unit: string; qty: number; revenue: number }>();
    for (const v of views) {
      if (v.sale.status !== 'completed') continue;
      for (const l of v.sale.lines) {
        const cur = m.get(l.productId) ?? { name: l.description, unit: l.unit, qty: 0, revenue: 0 };
        cur.qty = Math.round((cur.qty + l.quantity) * 1000) / 1000;
        cur.revenue += Math.round(l.quantity * l.unitPrice) - l.discount;
        m.set(l.productId, cur);
      }
    }
    return [...m.values()].sort((a, b) => b.revenue - a.revenue);
  }, [views]);
  const exportCsv = () =>
    downloadFile(
      `sales_${fileSuffix(range)}.csv`,
      toCSV(
        ['Sale', 'Date', 'Customer', 'Record status', 'Subtotal', 'Discount', 'Total', 'Paid', 'Balance', 'Payment status'],
        views.map((v) => [v.sale.number, v.sale.date, v.customerName, v.sale.status, centsToDecimal(v.totals.subtotal), centsToDecimal(v.totals.discount), centsToDecimal(v.totals.total), centsToDecimal(v.paid), centsToDecimal(v.sale.status === 'voided' ? 0 : v.balance), v.sale.status === 'voided' ? 'voided' : v.status]),
      ),
    );
  return (
    <>
      <div className="stats-grid">
        <Stat label="Completed sales" value={s.count} hint={s.voidedCount ? `${s.voidedCount} voided (excluded)` : undefined} />
        <Stat label="Revenue" value={money(s.revenue)} hint={`after ${money(s.discount)} discounts`} />
        <Stat label="Paid on these sales" value={money(s.collectedOnTheseSales)} hint="Including later payments" />
        <Stat label="Still owed on these sales" value={money(s.outstandingOnTheseSales)} tone={s.outstandingOnTheseSales > 0 ? 'warn' : 'default'} />
      </div>
      <Card title="By product" pad={false}>
        {byProduct.length === 0 ? <EmptyState title="No sales in this period" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Product</th><th className="r">Quantity</th><th className="r">Revenue</th></tr></thead>
            <tbody>{byProduct.map((r) => <tr key={r.name}><td data-label="Product">{r.name}</td><td data-label="Quantity" className="r num">{r.qty} {r.unit}</td><td data-label="Revenue" className="r num">{money(r.revenue)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
      <Card title={`Sales — ${rangeLabel(range, date)}`} pad={false} className="mt" actions={<ExportButton onClick={exportCsv} disabled={views.length === 0} />}>
        {views.length === 0 ? <EmptyState title="No sales in this period" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Sale</th><th>Date</th><th>Customer</th><th className="r">Total</th><th className="r">Paid</th><th className="r">Balance</th></tr></thead>
            <tbody>{views.map((v) => (
              <tr key={v.sale.id} className={v.sale.status === 'voided' ? 'voided' : ''}>
                <td data-label="Sale"><a href={`#/sales/${v.sale.id}`}>{v.sale.number}</a>{v.sale.status === 'voided' && <> <Badge>Voided</Badge></>}</td>
                <td data-label="Date">{date(v.sale.date)}</td>
                <td data-label="Customer">{v.customerName}</td>
                <td data-label="Total" className="r num">{money(v.totals.total)}</td>
                <td data-label="Paid" className="r num">{money(v.paid)}</td>
                <td data-label="Balance" className="r num">{v.sale.status === 'voided' ? '—' : money(v.balance)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

function ExpensesReport({ range }: { range: Range }) {
  const { state, money, date } = useApp();
  const rows = useMemo(() => expensesInRange(state, range), [state, range.from, range.to]);
  const byCat = useMemo(() => expensesByCategory(state, range), [state, range.from, range.to]);
  const total = rows.reduce((a, e) => a + e.amount, 0);
  const exportCsv = () =>
    downloadFile(
      `expenses_${fileSuffix(range)}.csv`,
      toCSV(['Date', 'Category', 'Description', 'Amount', 'Method', 'Reference'], rows.map((e) => [e.date, e.category, e.description, centsToDecimal(e.amount), e.method, e.reference])),
    );
  return (
    <div className="two-col">
      <Card title="By category" pad={false}>
        {byCat.length === 0 ? <EmptyState title="No expenses in this period" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Category</th><th className="r">Entries</th><th className="r">Total</th><th className="r">Share</th></tr></thead>
            <tbody>
              {byCat.map((c) => <tr key={c.category}><td data-label="Category">{c.category}</td><td data-label="Entries" className="r num">{c.count}</td><td data-label="Total" className="r num">{money(c.total)}</td><td data-label="Share" className="r num">{total ? Math.round((c.total / total) * 100) : 0}%</td></tr>)}
              <tr className="total-row"><td>Total</td><td className="r num">{rows.length}</td><td className="r num">{money(total)}</td><td /></tr>
            </tbody>
          </table></div>
        )}
      </Card>
      <Card title={`Expenses — ${rangeLabel(range, date)}`} pad={false} actions={<ExportButton onClick={exportCsv} disabled={rows.length === 0} />}>
        {rows.length === 0 ? <EmptyState title="No expenses in this period" /> : (
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Date</th><th>Description</th><th className="r">Amount</th></tr></thead>
            <tbody>{rows.map((e) => <tr key={e.id}><td data-label="Date">{date(e.date)}</td><td data-label="Description">{e.description}<div className="muted small">{e.category}</div></td><td data-label="Amount" className="r num">{money(e.amount)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}

function PaymentsReport({ range }: { range: Range }) {
  const { state, money, date } = useApp();
  const rows = useMemo(() => paymentsInRange(state, range), [state, range.from, range.to]);
  const inTotal = rows.filter((r) => r.payment.direction === 'in').reduce((a, r) => a + r.payment.amount, 0);
  const outTotal = rows.filter((r) => r.payment.direction === 'out').reduce((a, r) => a + r.payment.amount, 0);
  const byMethod = new Map<string, number>();
  rows.filter((r) => r.payment.direction === 'in').forEach((r) => byMethod.set(r.payment.method, (byMethod.get(r.payment.method) ?? 0) + r.payment.amount));
  const exportCsv = () =>
    downloadFile(
      `payments_${fileSuffix(range)}.csv`,
      toCSV(['Date', 'Direction', 'Description', 'Method', 'Reference', 'Amount'], rows.map((r) => [r.payment.date, r.payment.direction === 'in' ? 'Received' : 'Paid out', r.description, r.payment.method, r.payment.reference, centsToDecimal(r.payment.amount)])),
    );
  return (
    <>
      <div className="stats-grid">
        <Stat label="Received from customers" value={money(inTotal)} tone="good" />
        <Stat label="Paid to suppliers" value={money(outTotal)} hint="Excludes expenses" />
        {[...byMethod.entries()].slice(0, 2).map(([m, v]) => <Stat key={m} label={`Received by ${m}`} value={money(v)} />)}
      </div>
      <Card title={`Payments — ${rangeLabel(range, date)}`} pad={false} actions={<ExportButton onClick={exportCsv} disabled={rows.length === 0} />}>
        {rows.length === 0 ? <EmptyState title="No payments in this period" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Date</th><th>Type</th><th>For</th><th>Method</th><th className="r">Amount</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.payment.id}>
                <td data-label="Date">{date(r.payment.date)}</td>
                <td data-label="Type">{r.payment.direction === 'in' ? <Badge tone="good">Received</Badge> : <Badge tone="info">Paid out</Badge>}</td>
                <td data-label="For">{r.payment.saleId ? <a href={`#/sales/${r.payment.saleId}`}>{r.description}</a> : r.description}</td>
                <td data-label="Method">{r.payment.method}{r.payment.reference && <span className="muted"> · {r.payment.reference}</span>}</td>
                <td data-label="Amount" className={`r num ${r.payment.direction === 'out' ? 'neg' : ''}`}>{r.payment.direction === 'out' ? '−' : ''}{money(r.payment.amount)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}

function ReceivablesReport({ range }: { range: Range }) {
  const { state, money, date } = useApp();
  const rows = useMemo(() => receivablesAsOf(state, range.to), [state, range.to]);
  const total = rows.reduce((a, r) => a + r.outstanding, 0);
  const exportCsv = () =>
    downloadFile(
      `receivables_as_at_${range.to || 'today'}.csv`,
      toCSV(['Customer', 'Total sales', 'Paid', 'Outstanding', 'Open sales', 'Oldest unpaid sale'], rows.map((r) => [r.name, centsToDecimal(r.invoiced), centsToDecimal(r.paid), centsToDecimal(r.outstanding), r.openSales, r.oldestOpenDate ?? ''])),
    );
  return (
    <Card title={`Outstanding customer balances as at ${range.to ? date(range.to) : 'today'}`} pad={false} actions={<ExportButton onClick={exportCsv} disabled={rows.length === 0} />}>
      <p className="card-note">Balances include all credit sales and payments dated up to the end of the selected period. The start date does not apply.</p>
      {rows.length === 0 ? <EmptyState title="Nothing owed" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Customer</th><th className="r">Total sales</th><th className="r">Paid</th><th className="r">Outstanding</th><th>Oldest unpaid</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customerId}>
                <td data-label="Customer"><a href={`#/customers/${r.customerId}`}>{r.name}</a></td>
                <td data-label="Total sales" className="r num">{money(r.invoiced)}</td>
                <td data-label="Paid" className="r num">{money(r.paid)}</td>
                <td data-label="Outstanding" className="r num"><strong>{money(r.outstanding)}</strong></td>
                <td data-label="Oldest unpaid">{r.oldestOpenDate ? date(r.oldestOpenDate) : '—'} <span className="muted small">({r.openSales} open)</span></td>
              </tr>
            ))}
            <tr className="total-row"><td>Total</td><td /><td /><td className="r num">{money(total)}</td><td /></tr>
          </tbody>
        </table></div>
      )}
    </Card>
  );
}

function InventoryReport({ range }: { range: Range }) {
  const { state, money, date, qty } = useApp();
  const rows = useMemo(() => inventoryAsOf(state, range.to).filter((r) => r.product.trackStock), [state, range.to]);
  const value = rows.reduce((a, r) => a + r.valueAtSellingPrice, 0);
  const exportCsv = () =>
    downloadFile(
      `inventory_as_at_${range.to || 'today'}.csv`,
      toCSV(['Product', 'Category', 'Unit', 'Quantity', 'Selling price', 'Value at selling price', 'Status'], rows.map((r) => [r.product.name, r.product.category, r.product.unit, r.quantity, centsToDecimal(r.product.sellingPrice), centsToDecimal(r.valueAtSellingPrice), r.level])),
    );
  return (
    <Card title={`Stock levels as at ${range.to ? date(range.to) : 'today'}`} pad={false} actions={<ExportButton onClick={exportCsv} disabled={rows.length === 0} />}>
      <p className="card-note">Quantities are the sum of all stock movements up to the end of the selected period. Value at selling price is indicative only.</p>
      {rows.length === 0 ? <EmptyState title="No stock-tracked products" /> : (
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Product</th><th>Category</th><th className="r">Quantity</th><th className="r">Value at selling price</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product.id}>
                <td data-label="Product">{r.product.name}</td>
                <td data-label="Category">{r.product.category}</td>
                <td data-label="Quantity" className="r num">{qty(r.quantity)} {r.product.unit}</td>
                <td data-label="Value" className="r num">{money(r.valueAtSellingPrice)}</td>
                <td data-label="Status">{r.level === 'out' ? <Badge tone="bad">Out</Badge> : r.level === 'low' ? <Badge tone="warn">Low</Badge> : <Badge tone="good">OK</Badge>}</td>
              </tr>
            ))}
            <tr className="total-row"><td>Total</td><td /><td /><td className="r num">{money(value)}</td><td /></tr>
          </tbody>
        </table></div>
      )}
    </Card>
  );
}

function MovementsReport({ range }: { range: Range }) {
  const { state, money, date, qty } = useApp();
  const rows = useMemo(() => movementsInRange(state, range), [state, range.from, range.to]);
  const losses = useMemo(() => lossSummary(state, range), [state, range.from, range.to]);
  const products = new Map(state.products.map((p) => [p.id, p]));
  const batches = new Map(state.batches.map((b) => [b.id, b.reference]));
  const exportCsv = () =>
    downloadFile(
      `stock_movements_${fileSuffix(range)}.csv`,
      toCSV(['Date', 'Product', 'Unit', 'Change', 'Reason', 'Batch', 'Note'], rows.map((m) => [m.date, products.get(m.productId)?.name ?? '', products.get(m.productId)?.unit ?? '', m.quantity, REASON_LABELS[m.reason], batches.get(m.batchId ?? '') ?? '', m.note])),
    );
  return (
    <>
      <Card title="Recorded losses" pad={false}>
        <p className="card-note">Estimated value uses each product’s cost price where set, otherwise its selling price.</p>
        {losses.length === 0 ? <EmptyState title="No losses recorded in this period" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Product</th><th>Reason</th><th className="r">Quantity</th><th className="r">Est. value</th></tr></thead>
            <tbody>
              {losses.map((l) => <tr key={`${l.productId}-${l.reason}`}><td data-label="Product">{l.productName}</td><td data-label="Reason">{l.reasonLabel}</td><td data-label="Quantity" className="r num">{qty(l.quantity)}</td><td data-label="Est. value" className="r num">{money(l.estValue)}</td></tr>)}
              <tr className="total-row"><td>Total</td><td /><td /><td className="r num">{money(losses.reduce((a, l) => a + l.estValue, 0))}</td></tr>
            </tbody>
          </table></div>
        )}
      </Card>
      <Card title={`All stock movements — ${rangeLabel(range, date)}`} pad={false} className="mt" actions={<ExportButton onClick={exportCsv} disabled={rows.length === 0} />}>
        {rows.length === 0 ? <EmptyState title="No stock movements in this period" /> : (
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Date</th><th>Product</th><th>Reason</th><th>Note</th><th className="r">Change</th></tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.id}>
                <td data-label="Date">{date(m.date)}</td>
                <td data-label="Product">{products.get(m.productId)?.name}</td>
                <td data-label="Reason">{REASON_LABELS[m.reason]}{m.batchId && <span className="muted"> · {batches.get(m.batchId)}</span>}</td>
                <td data-label="Note">{m.note || <span className="muted">—</span>}</td>
                <td data-label="Change" className={`r num ${m.quantity < 0 ? 'neg' : 'pos'}`}>{m.quantity > 0 ? '+' : ''}{qty(m.quantity)} {products.get(m.productId)?.unit}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
