import {
  BarChart3,
  Bird,
  CheckCircle2,
  Info,
  LayoutDashboard,
  Menu,
  Package,
  Plus,
  ReceiptText,
  Settings,
  Truck,
  Users,
  Wallet,
  X,
  XCircle,
  FlaskConical,
  Database,
} from 'lucide-react';
import { supabaseConfigured } from '../data/supabase';
import { useEffect, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../ui/components';
import { useApp } from './AppContext';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  match: string;
}

export function useNavItems(): NavItem[] {
  const { state } = useApp();
  const items: NavItem[] = [
    { href: '#/', label: 'Dashboard', icon: <LayoutDashboard size={18} />, match: '' },
    { href: '#/sales', label: 'Sales', icon: <ReceiptText size={18} />, match: 'sales' },
    { href: '#/inventory', label: 'Inventory', icon: <Package size={18} />, match: 'inventory' },
  ];
  if (state.settings.batchTrackingEnabled) {
    items.push({ href: '#/batches', label: 'Poultry batches', icon: <Bird size={18} />, match: 'batches' });
  }
  items.push(
    { href: '#/customers', label: 'Customers', icon: <Users size={18} />, match: 'customers' },
    { href: '#/expenses', label: 'Expenses', icon: <Wallet size={18} />, match: 'expenses' },
    { href: '#/suppliers', label: 'Suppliers & purchases', icon: <Truck size={18} />, match: 'suppliers' },
    { href: '#/reports', label: 'Reports', icon: <BarChart3 size={18} />, match: 'reports' },
    { href: '#/settings', label: 'Settings', icon: <Settings size={18} />, match: 'settings' },
  );
  return items;
}

function Brand() {
  const { state } = useApp();
  const { logoDataUrl, businessName } = state.settings;
  return (
    <a href="#/" className="brand">
      {logoDataUrl ? (
        <img src={logoDataUrl} alt="" className="brand-logo" />
      ) : (
        <span className="brand-mark" aria-hidden="true">
          <Bird size={18} />
        </span>
      )}
      <span className="brand-text">
        <span className="brand-name">{businessName}</span>
        <span className="brand-sub">Chik-Biz</span>
      </span>
    </a>
  );
}

function NavList({ section, onNavigate }: { section: string; onNavigate?: () => void }) {
  const items = useNavItems();
  return (
    <nav aria-label="Main">
      <ul className="nav-list">
        {items.map((i) => {
          const active = i.match === section;
          return (
            <li key={i.href}>
              <a href={i.href} className={`nav-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onNavigate}>
                {i.icon}
                <span>{i.label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function LiveBanner() {
  const { live, switchMode } = useApp();
  if (!live) return null;
  return (
    <div className="demo-banner live-banner" role="note">
      <Database size={16} aria-hidden="true" />
      <p>
        <strong>Live data.</strong> Signed in as {live.email} ({live.role}). Changes are saved to the business database.
      </p>
      <button type="button" className="demo-banner-btn" onClick={() => void live.signOut().then(switchMode)}>
        Sign out
      </button>
    </div>
  );
}

function DemoBanner() {
  const { state, demoStore: store, toast, switchMode } = useApp();
  const [confirm, setConfirm] = useState(false);
  if (!store) return <LiveBanner />;
  return (
    <div className="demo-banner" role="note">
      <FlaskConical size={16} aria-hidden="true" />
      <p>
        <strong>Demonstration mode.</strong>{' '}
        {state.isSampleData ? 'Figures are fictional sample data. ' : ''}
        Data is stored only in this browser and is not a secure or shared database.
      </p>
      <button type="button" className="demo-banner-btn" onClick={() => setConfirm(true)}>
        Reset sample data
      </button>
      {supabaseConfigured && (
        <button type="button" className="demo-banner-btn" onClick={switchMode}>
          Leave demo
        </button>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Reset sample data?"
        message="This replaces everything stored in this browser — including any records you have added — with fresh fictional sample data. This cannot be undone."
        confirmLabel="Reset data"
        onConfirm={() => {
          store.resetToSample();
          setConfirm(false);
          toast('success', 'Sample data has been reset.');
          window.location.hash = '/';
        }}
      />
    </div>
  );
}

function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'success' ? <CheckCircle2 size={18} /> : t.kind === 'error' ? <XCircle size={18} /> : <Info size={18} />}
          <span>{t.message}</span>
          <button type="button" className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Layout({ section, children }: { section: string; children: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer]);

  return (
    <div className="shell">
      <a href="#main" className="skip-link" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>
        Skip to content
      </a>
      <aside className="sidebar">
        <Brand />
        <NavList section={section} />
        <p className="sidebar-foot">
          Chik-Biz prototype · technology by Auris Nexus Technologies
        </p>
      </aside>

      <div className="topbar">
        <button type="button" className="icon-btn" onClick={() => setDrawer(true)} aria-label="Open menu" aria-expanded={drawer}>
          <Menu size={22} />
        </button>
        <Brand />
        <a href="#/sales/new" className="btn btn-primary btn-sm" aria-label="New sale">
          <Plus size={16} />
          <span>Sale</span>
        </a>
      </div>

      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <div className="drawer" role="dialog" aria-modal="true" aria-label="Menu" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-head">
              <Brand />
              <button type="button" className="icon-btn" onClick={() => setDrawer(false)} aria-label="Close menu" autoFocus>
                <X size={20} />
              </button>
            </div>
            <NavList section={section} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <div className="main-col">
        <DemoBanner />
        <main id="main" tabIndex={-1} className="main">
          {children}
        </main>
        <footer className="app-foot">
          Chik-Biz demonstration prototype · Technology provider: Auris Nexus Technologies (Pty) Ltd
        </footer>
      </div>

      <nav className="bottom-nav" aria-label="Quick">
        <a href="#/" className={section === '' ? 'active' : ''}><LayoutDashboard size={20} /><span>Home</span></a>
        <a href="#/sales" className={section === 'sales' ? 'active' : ''}><ReceiptText size={20} /><span>Sales</span></a>
        <a href="#/inventory" className={section === 'inventory' ? 'active' : ''}><Package size={20} /><span>Stock</span></a>
        <a href="#/expenses" className={section === 'expenses' ? 'active' : ''}><Wallet size={20} /><span>Expenses</span></a>
        <button type="button" onClick={() => setDrawer(true)}><Menu size={20} /><span>More</span></button>
      </nav>
      <Toasts />
    </div>
  );
}
