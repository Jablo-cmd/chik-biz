import { useApp } from './AppContext';
import { Gate } from './Gate';
import { Layout } from './Layout';
import { useRoute } from './router';
import { Dashboard } from '../pages/Dashboard';
import { InventoryPage } from '../pages/Inventory';
import { BatchesPage, BatchDetail } from '../pages/Batches';
import { SalesPage } from '../pages/Sales';
import { NewSalePage } from '../pages/NewSale';
import { SaleDetailPage } from '../pages/SaleDetail';
import { CustomersPage, CustomerDetail } from '../pages/Customers';
import { ExpensesPage } from '../pages/Expenses';
import { SuppliersPage } from '../pages/Suppliers';
import { ReportsPage } from '../pages/Reports';
import { SettingsPage } from '../pages/Settings';
import { EmptyState, LinkButton } from '../ui/components';

function NotFound() {
  return (
    <EmptyState title="Page not found" action={<LinkButton href="#/">Go to dashboard</LinkButton>}>
      The page you were looking for does not exist.
    </EmptyState>
  );
}

function Routes() {
  const { segments, query } = useRoute();
  const { state } = useApp();
  const [section = '', id, sub] = segments;

  let page;
  switch (section) {
    case '':
      page = <Dashboard />;
      break;
    case 'inventory':
      page = <InventoryPage />;
      break;
    case 'batches':
      page = !state.settings.batchTrackingEnabled ? (
        <EmptyState title="Batch tracking is switched off" action={<LinkButton href="#/settings">Open settings</LinkButton>}>
          Enable poultry batch tracking in Settings if this business raises or holds birds in batches.
        </EmptyState>
      ) : id ? (
        <BatchDetail id={id} />
      ) : (
        <BatchesPage />
      );
      break;
    case 'sales':
      page = id === 'new' ? <NewSalePage customerId={query.get('customer')} /> : id ? <SaleDetailPage id={id} print={sub === 'receipt'} /> : <SalesPage />;
      break;
    case 'customers':
      page = id ? <CustomerDetail id={id} /> : <CustomersPage />;
      break;
    case 'expenses':
      page = <ExpensesPage />;
      break;
    case 'suppliers':
      page = <SuppliersPage />;
      break;
    case 'reports':
      page = <ReportsPage />;
      break;
    case 'settings':
      page = <SettingsPage />;
      break;
    default:
      page = <NotFound />;
  }
  return <Layout section={section}>{page}</Layout>;
}

export function App() {
  return (
    <Gate>
      <Routes />
    </Gate>
  );
}
