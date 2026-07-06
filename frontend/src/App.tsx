import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { RequireCompanyForApp } from '@/components/auth/RequireCompanyForApp';
import { AppLayout } from '@/components/layout/AppLayout';
import { ModuleRouteGate } from '@/components/layout/ModuleRoute';
import { EnsureCurrentCompany } from '@/components/auth/EnsureCurrentCompany';
import { AuthProvider } from '@/context/AuthContext';

const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })));
const LoginPage = lazy(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage })));
const ForgotPasswordPage = lazy(() => import('./pages/ForgotPasswordPage').then((m) => ({ default: m.ForgotPasswordPage })));
const ResetPasswordPage = lazy(() => import('./pages/ResetPasswordPage').then((m) => ({ default: m.ResetPasswordPage })));
const RegisterPage = lazy(() => import('./pages/RegisterPage').then((m) => ({ default: m.RegisterPage })));
const CustomersPage = lazy(() =>
  import('./pages/CustomersPage').then((m) => ({ default: m.CustomersPage })),
);
const CustomerCreatePage = lazy(() =>
  import('./pages/CustomerCreatePage').then((m) => ({ default: m.CustomerCreatePage })),
);
const CustomerEditPage = lazy(() =>
  import('./pages/CustomerEditPage').then((m) => ({ default: m.CustomerEditPage })),
);
const CustomerDetailPage = lazy(() =>
  import('./pages/CustomerDetailPage').then((m) => ({ default: m.CustomerDetailPage })),
);
const ProductsPage = lazy(() => import('./pages/ProductsPage').then((m) => ({ default: m.ProductsPage })));
const ProductCreatePage = lazy(() =>
  import('./pages/ProductCreatePage').then((m) => ({ default: m.ProductCreatePage })),
);
const ProductEditPage = lazy(() =>
  import('./pages/ProductEditPage').then((m) => ({ default: m.ProductEditPage })),
);
const ProductAdjustStockPage = lazy(() =>
  import('./pages/ProductAdjustStockPage').then((m) => ({ default: m.ProductAdjustStockPage })),
);
const ProductMovementsPage = lazy(() =>
  import('./pages/ProductMovementsPage').then((m) => ({ default: m.ProductMovementsPage })),
);
const WarehousesPage = lazy(() =>
  import('./pages/WarehousesPage').then((m) => ({ default: m.WarehousesPage })),
);
const WarehouseDetailPage = lazy(() =>
  import('./pages/WarehouseDetailPage').then((m) => ({ default: m.WarehouseDetailPage })),
);
const WarehouseCreatePage = lazy(() =>
  import('./pages/WarehouseCreatePage').then((m) => ({ default: m.WarehouseCreatePage })),
);
const OnboardingPage = lazy(() =>
  import('./pages/OnboardingPage').then((m) => ({ default: m.OnboardingPage })),
);
const CompanySettingsPage = lazy(() =>
  import('./pages/CompanySettingsPage').then((m) => ({ default: m.CompanySettingsPage })),
);
const CompanyDataPage = lazy(() =>
  import('./pages/CompanyDataPage').then((m) => ({ default: m.CompanyDataPage })),
);
const CertificateUploadPage = lazy(() =>
  import('./pages/CertificateUploadPage').then((m) => ({ default: m.CertificateUploadPage })),
);
const OrdersPage = lazy(() => import('./pages/OrdersPage').then((m) => ({ default: m.OrdersPage })));
const OrderCreatePage = lazy(() =>
  import('./pages/OrderCreatePage').then((m) => ({ default: m.OrderCreatePage })),
);
const OrderDetailPage = lazy(() =>
  import('./pages/OrderDetailPage').then((m) => ({ default: m.OrderDetailPage })),
);
const DeliveryDocumentsPage = lazy(() =>
  import('./pages/DeliveryDocumentsPage').then((m) => ({ default: m.DeliveryDocumentsPage })),
);
const DeliveryCreatePage = lazy(() =>
  import('./pages/DeliveryCreatePage').then((m) => ({ default: m.DeliveryCreatePage })),
);
const VanReconciliationPage = lazy(() =>
  import('./pages/VanReconciliationPage').then((m) => ({ default: m.VanReconciliationPage })),
);
const VanRoutesPage = lazy(() =>
  import('./pages/VanRoutesPage').then((m) => ({ default: m.VanRoutesPage })),
);
const NewVanRoutePage = lazy(() =>
  import('./pages/NewVanRoutePage').then((m) => ({ default: m.NewVanRoutePage })),
);
const VanRouteLoadPage = lazy(() =>
  import('./pages/VanRouteLoadPage').then((m) => ({ default: m.VanRouteLoadPage })),
);
const VanRouteDashboardPage = lazy(() =>
  import('./pages/VanRouteDashboardPage').then((m) => ({ default: m.VanRouteDashboardPage })),
);
const DeliveryDocumentDetailPage = lazy(() =>
  import('./pages/DeliveryDocumentDetailPage').then((m) => ({ default: m.DeliveryDocumentDetailPage })),
);
const PZCreatePage = lazy(() =>
  import('./pages/PZCreatePage').then((m) => ({ default: m.PZCreatePage })),
);
const SuppliersPage = lazy(() =>
  import('./pages/SuppliersPage').then((m) => ({ default: m.SuppliersPage })),
);
const SupplierCreatePage = lazy(() =>
  import('./pages/SupplierCreatePage').then((m) => ({ default: m.SupplierCreatePage })),
);
const InvoicesPage = lazy(() => import('./pages/InvoicesPage').then((m) => ({ default: m.InvoicesPage })));
const InvoiceCreatePage = lazy(() =>
  import('./pages/InvoiceCreatePage').then((m) => ({ default: m.InvoiceCreatePage })),
);
const InvoiceDetailPage = lazy(() =>
  import('./pages/InvoiceDetailPage').then((m) => ({ default: m.InvoiceDetailPage })),
);
const CorrectionInvoiceCreatePage = lazy(() =>
  import('./pages/CorrectionInvoiceCreatePage').then((m) => ({ default: m.CorrectionInvoiceCreatePage })),
);
const WzCorrectionCreatePage = lazy(() =>
  import('./pages/WzCorrectionCreatePage').then((m) => ({ default: m.WzCorrectionCreatePage })),
);
const ReportsPage = lazy(() =>
  import('./pages/ReportsPage').then((m) => ({ default: m.ReportsPage })),
);
const KSeFInboxPage = lazy(() =>
  import('./pages/KSeFInboxPage').then((m) => ({ default: m.KSeFInboxPage })),
);
const KSeFInboxPZPage = lazy(() =>
  import('./pages/KSeFInboxPZPage').then((m) => ({ default: m.KSeFInboxPZPage })),
);
const KSeFInboxKorPage = lazy(() =>
  import('./pages/KSeFInboxKorPage').then((m) => ({ default: m.KSeFInboxKorPage })),
);
const PaperScannerPage = lazy(() =>
  import('./pages/PaperScannerPage').then((m) => ({ default: m.PaperScannerPage })),
);
const CostProjectsPage = lazy(() =>
  import('./pages/CostProjectsPage').then((m) => ({ default: m.CostProjectsPage })),
);
const ProfitLossPage = lazy(() =>
  import('./pages/ProfitLossPage').then((m) => ({ default: m.ProfitLossPage })),
);
const ProductMarginPage = lazy(() =>
  import('./pages/ProductMarginPage').then((m) => ({ default: m.ProductMarginPage })),
);
const PaymentAgingPage = lazy(() =>
  import('./pages/PaymentAgingPage').then((m) => ({ default: m.PaymentAgingPage })),
);
const SupplierCostsPage = lazy(() =>
  import('./pages/SupplierCostsPage').then((m) => ({ default: m.SupplierCostsPage })),
);
const InventoryReportPage = lazy(() =>
  import('./pages/InventoryReportPage').then((m) => ({ default: m.InventoryReportPage })),
);
const CustomerMarginPage = lazy(() =>
  import('./pages/CustomerMarginPage').then((m) => ({ default: m.CustomerMarginPage })),
);
const RecipesPage = lazy(() =>
  import('./pages/RecipesPage').then((m) => ({ default: m.RecipesPage })),
);
const ProductionOrdersPage = lazy(() =>
  import('./pages/ProductionOrdersPage').then((m) => ({ default: m.ProductionOrdersPage })),
);
const InventoryPage = lazy(() =>
  import('./pages/InventoryPage').then((m) => ({ default: m.InventoryPage })),
);

const RWCreatePage = lazy(() =>
  import('./pages/RWCreatePage').then((m) => ({ default: m.RWCreatePage })),
);
const TeamPage = lazy(() =>
  import('./pages/TeamPage').then((m) => ({ default: m.TeamPage })),
);
const FixedCostsPage = lazy(() =>
  import('./pages/FixedCostsPage').then((m) => ({ default: m.FixedCostsPage })),
);
const ActivityPage = lazy(() =>
  import('./pages/ActivityPage').then((m) => ({ default: m.ActivityPage })),
);

function RouteFallback() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
      Ładowanie…
    </div>
  );
}

function AppPlaceholderPage({ title }: { title: string }) {
  return (
    <div className="max-w-2xl p-6">
      <h1 className="text-[1.5rem] font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">Ta sekcja nie jest jeszcze zaimplementowana.</p>
    </div>
  );
}

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID ?? ''} locale="pl">
    <BrowserRouter>
      <AuthProvider>
        <EnsureCurrentCompany />
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password/:uid/:token" element={<ResetPasswordPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route element={<RequireCompanyForApp />}>
              <Route element={<AppLayout />}>
                <Route path="/" element={<Home />} />
                <Route
                  path="/customers"
                  element={
                    <ModuleRouteGate module="customers">
                      <CustomersPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/customers/new"
                  element={
                    <ModuleRouteGate module="customers">
                      <CustomerCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/customers/:id/edit"
                  element={
                    <ModuleRouteGate module="customers">
                      <CustomerEditPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/customers/:id"
                  element={
                    <ModuleRouteGate module="customers">
                      <CustomerDetailPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/products"
                  element={
                    <ModuleRouteGate module="products">
                      <ProductsPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/products/new"
                  element={
                    <ModuleRouteGate module="products">
                      <ProductCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/products/:id/edit"
                  element={
                    <ModuleRouteGate module="products">
                      <ProductEditPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/products/:id/adjust-stock"
                  element={
                    <ModuleRouteGate module="products">
                      <ProductAdjustStockPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/products/:id/movements"
                  element={
                    <ModuleRouteGate module="products">
                      <ProductMovementsPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/warehouses"
                  element={
                    <ModuleRouteGate module="warehouses">
                      <WarehousesPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/warehouses/new"
                  element={
                    <ModuleRouteGate module="warehouses">
                      <WarehouseCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/warehouses/:id"
                  element={
                    <ModuleRouteGate module="warehouses">
                      <WarehouseDetailPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/orders"
                  element={
                    <ModuleRouteGate module="orders">
                      <OrdersPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/orders/new"
                  element={
                    <ModuleRouteGate module="orders">
                      <OrderCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/orders/:id"
                  element={
                    <ModuleRouteGate module="orders">
                      <OrderDetailPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery"
                  element={
                    <ModuleRouteGate module="delivery">
                      <DeliveryDocumentsPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery/new"
                  element={
                    <ModuleRouteGate module="delivery">
                      <DeliveryCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery/new-pz"
                  element={
                    <ModuleRouteGate module="purchasing">
                      <PZCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery/new-rw"
                  element={
                    <ModuleRouteGate module="warehouses">
                      <RWCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery/van-reconciliation"
                  element={
                    <ModuleRouteGate module="delivery">
                      <VanReconciliationPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/van-routes"
                  element={
                    <ModuleRouteGate module="delivery">
                      <VanRoutesPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/van-routes/new"
                  element={
                    <ModuleRouteGate module="delivery">
                      <NewVanRoutePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/van-routes/:routeId/load"
                  element={
                    <ModuleRouteGate module="delivery">
                      <VanRouteLoadPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/van-routes/:routeId"
                  element={
                    <ModuleRouteGate module="delivery">
                      <VanRouteDashboardPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery/:id/wz-correction/new"
                  element={
                    <ModuleRouteGate module="delivery">
                      <WzCorrectionCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/delivery/:id"
                  element={
                    <ModuleRouteGate module="delivery">
                      <DeliveryDocumentDetailPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/suppliers"
                  element={
                    <ModuleRouteGate module="purchasing">
                      <SuppliersPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/suppliers/new"
                  element={
                    <ModuleRouteGate module="purchasing">
                      <SupplierCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/invoices"
                  element={
                    <ModuleRouteGate module="invoicing">
                      <InvoicesPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/invoices/new"
                  element={
                    <ModuleRouteGate module="invoicing">
                      <InvoiceCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/invoices/:id/correction/new"
                  element={
                    <ModuleRouteGate module="invoicing">
                      <CorrectionInvoiceCreatePage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/invoices/:id"
                  element={
                    <ModuleRouteGate module="invoicing">
                      <InvoiceDetailPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports"
                  element={
                    <ModuleRouteGate module="reporting">
                      <ReportsPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports/profit-loss"
                  element={
                    <ModuleRouteGate module="reporting">
                      <ProfitLossPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports/product-margin"
                  element={
                    <ModuleRouteGate module="reporting">
                      <ModuleRouteGate module="purchasing">
                        <ProductMarginPage />
                      </ModuleRouteGate>
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports/payment-aging"
                  element={
                    <ModuleRouteGate module="reporting">
                      <PaymentAgingPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports/supplier-costs"
                  element={
                    <ModuleRouteGate module="reporting">
                      <ModuleRouteGate module="purchasing">
                        <SupplierCostsPage />
                      </ModuleRouteGate>
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports/inventory"
                  element={
                    <ModuleRouteGate module="reporting">
                      <ModuleRouteGate module="warehouses">
                        <InventoryReportPage />
                      </ModuleRouteGate>
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/reports/customer-margin"
                  element={
                    <ModuleRouteGate module="reporting">
                      <ModuleRouteGate module="purchasing">
                        <CustomerMarginPage />
                      </ModuleRouteGate>
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/production/recipes"
                  element={
                    <ModuleRouteGate module="production">
                      <RecipesPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/production/orders"
                  element={
                    <ModuleRouteGate module="production">
                      <ProductionOrdersPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/inventory"
                  element={
                    <ModuleRouteGate module="warehouses">
                      <InventoryPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/ksef"
                  element={
                    <ModuleRouteGate module="ksef">
                      <AppPlaceholderPage title="KSeF" />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/ksef/inbox"
                  element={
                    <ModuleRouteGate module="ksef">
                      <KSeFInboxPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/ksef/inbox/:ksefNumber/pz"
                  element={
                    <ModuleRouteGate module="ksef">
                      <KSeFInboxPZPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/ksef/inbox/:ksefNumber/pz-kor"
                  element={
                    <ModuleRouteGate module="ksef">
                      <KSeFInboxKorPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/ksef/scan-paper"
                  element={
                    <ModuleRouteGate module="ksef">
                      <PaperScannerPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/cost-allocation"
                  element={
                    <ModuleRouteGate module="cost_allocation">
                      <CostProjectsPage />
                    </ModuleRouteGate>
                  }
                />
                <Route
                  path="/fixed-costs"
                  element={<FixedCostsPage />}
                />
                <Route path="/activity" element={<ActivityPage />} />
                <Route path="/settings/company" element={<CompanySettingsPage />} />
                <Route path="/settings/company-data" element={<CompanyDataPage />} />
                <Route path="/settings/team" element={<TeamPage />} />
                <Route
                  path="/settings/certificate"
                  element={
                    <ModuleRouteGate module="ksef">
                      <CertificateUploadPage />
                    </ModuleRouteGate>
                  }
                />
              </Route>
            </Route>
          </Route>
        </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
    </GoogleOAuthProvider>
  );
}

export default App;
