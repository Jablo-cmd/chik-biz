import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Banknote, Info, Package, Plus, ReceiptText, ShoppingBasket, Truck, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApp } from '../app/AppContext';
import { dashboardMetrics, recentActivity } from '../domain/reports';
import { Badge, Card, EmptyState, LinkButton, PageHeader, Stat } from '../ui/components';

export function Dashboard() {
  const { state, money, date, today } = useApp();
  const m = useMemo(() => dashboardMetrics(state, today), [state, today]);
  const activity = useMemo(() => recentActivity(state, 8), [state]);

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={`Today, ${date(today)}`}
        actions={
          <>
            <LinkButton href="#/expenses?new=1" icon={<Wallet size={16} />}>Add expense</LinkButton>
            <LinkButton href="#/sales/new" variant="primary" icon={<Plus size={16} />}>New sale</LinkButton>
          </>
        }
      />

      <div className="stats-grid">
        <Stat
          label="Sales today"
          value={money(m.salesToday)}
          hint={`${m.salesCountToday} sale${m.salesCountToday === 1 ? '' : 's'} · revenue incl. credit`}
          icon={<ReceiptText size={18} />}
        />
        <Stat label="Cash collected today" value={money(m.collectedToday)} hint="All customer payments received" icon={<Banknote size={18} />} tone="good" />
        <Stat label="Expenses today" value={money(m.expensesToday)} hint={<a href="#/expenses">View expenses</a>} icon={<Wallet size={18} />} />
        <Stat
          label="Owed by customers"
          value={money(m.receivables)}
          hint={<a href="#/reports?tab=receivables">Outstanding balances</a>}
          icon={<ArrowDownLeft size={18} />}
          tone={m.receivables > 0 ? 'warn' : 'default'}
        />
      </div>

      <div className="dash-grid">
        <div className="dash-col">
        <Card title="Sales — last 14 days">
          <SalesChart series={m.series} />
        </Card>
        <Card title="Recent transactions" pad={false}>
          {activity.length === 0 ? (
            <EmptyState title="No transactions yet" action={<LinkButton href="#/sales/new" variant="primary">Record a sale</LinkButton>} />
          ) : (
            <ul className="activity">
              {activity.map((a) => (
                <li key={`${a.kind}-${a.id}`}>
                  <a href={a.href} className="activity-row">
                    <span className={`activity-icon act-${a.kind}`} aria-hidden="true">
                      {a.kind === 'sale' ? <ShoppingBasket size={16} /> : a.kind === 'expense' ? <Wallet size={16} /> : a.kind === 'purchase' ? <Truck size={16} /> : a.kind === 'payment_in' ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                    </span>
                    <span className="activity-main">
                      <span className="activity-title">{a.title}</span>
                      <span className="activity-detail">{a.detail} · {date(a.date)}</span>
                    </span>
                    <span className={`activity-amount num ${a.kind === 'expense' || a.kind === 'payment_out' || a.kind === 'purchase' ? 'neg' : ''}`}>
                      {a.kind === 'expense' || a.kind === 'payment_out' || a.kind === 'purchase' ? '−' : ''}
                      {money(a.amount)}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>
        </div>
        <div className="dash-col">
        <Card title="Alerts">
          {m.alerts.length === 0 ? (
            <EmptyState title="All clear" icon={<Info size={24} />}>No stock or payment alerts right now.</EmptyState>
          ) : (
            <ul className="alert-list">
              {m.alerts.map((a, i) => (
                <li key={i}>
                  <a href={a.href} className={`alert-item alert-item-${a.level}`}>
                    {a.level === 'info' ? <Info size={16} /> : <AlertTriangle size={16} />}
                    <span>{a.message}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Inventory" actions={<a href="#/inventory" className="text-link">Open</a>}>
          <dl className="kv">
            <div><dt>Products tracked</dt><dd className="num">{m.inventory.trackedProducts}</dd></div>
            <div><dt>Low stock</dt><dd>{m.inventory.lowCount > 0 ? <Badge tone="warn">{m.inventory.lowCount}</Badge> : <span className="num">0</span>}</dd></div>
            <div><dt>Out of stock</dt><dd>{m.inventory.outCount > 0 ? <Badge tone="bad">{m.inventory.outCount}</Badge> : <span className="num">0</span>}</dd></div>
            <div><dt>Stock value at selling price</dt><dd className="num">{money(m.inventory.valueAtSellingPrice)}</dd></div>
          </dl>
        </Card>

        </div>
      </div>
      {state.products.length === 0 && (
        <Card className="mt">
          <EmptyState title="Start by adding your products" icon={<Package size={28} />} action={<LinkButton href="#/inventory?new=1" variant="primary">Add a product</LinkButton>}>
            Products are what you sell — live birds, dressed chicken, eggs and so on.
          </EmptyState>
        </Card>
      )}
    </>
  );
}

function SalesChart({ series }: { series: { date: string; total: number; collected: number }[] }) {
  const { money, state } = useApp();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...series.map((s) => s.total), ...series.map((s) => s.collected));
  const W = 560;
  const H = 180;
  const pad = { l: 8, r: 8, t: 12, b: 26 };
  const bw = (W - pad.l - pad.r) / series.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const label = (d: string) =>
    new Intl.DateTimeFormat(state.settings.locale, { day: 'numeric', month: 'short' }).format(new Date(d + 'T00:00:00'));
  const total = series.reduce((a, s) => a + s.total, 0);
  const focus = hover !== null ? series[hover] : null;

  return (
    <div className="chart">
      <div className="chart-summary">
        {focus ? (
          <>
            <span className="chart-big num">{money(focus.total)}</span>
            <span className="muted">sales on {label(focus.date)} · {money(focus.collected)} collected</span>
          </>
        ) : (
          <>
            <span className="chart-big num">{money(total)}</span>
            <span className="muted">total sales over 14 days</span>
          </>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bar chart of daily sales for the last 14 days, totalling ${money(total)}`} onMouseLeave={() => setHover(null)}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="chart-axis" />
        {series.map((s, i) => {
          const x = pad.l + i * bw;
          return (
            <g key={s.date} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)} tabIndex={0} aria-label={`${label(s.date)}: ${money(s.total)} sales, ${money(s.collected)} collected`}>
              <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              <rect x={x + bw * 0.18} y={y(s.total)} width={bw * 0.64} height={Math.max(0, y(0) - y(s.total))} rx={3} className={`chart-bar ${hover === i ? 'hover' : ''}`} />
              <line x1={x + bw * 0.12} x2={x + bw * 0.88} y1={y(s.collected)} y2={y(s.collected)} className="chart-collected" />
              {(i % 2 === 1 || series.length <= 7) && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="chart-label">
                  {label(s.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        <span><i className="lg-bar" /> Sales (incl. credit)</span>
        <span><i className="lg-line" /> Cash collected that day</span>
      </div>
    </div>
  );
}
