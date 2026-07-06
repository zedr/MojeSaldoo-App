import type { DeliveryListParams } from '@/services/delivery.service';
import type { InvoiceListParams } from '@/services/invoice.service';
import type { OrderListParams } from '@/services/order.service';

export const inventoryKeys = {
  all: ['inventory'] as const,
  lists: () => [...inventoryKeys.all, 'list'] as const,
  list: (page: number) => [...inventoryKeys.lists(), page] as const,
  details: () => [...inventoryKeys.all, 'detail'] as const,
  detail: (id: string) => [...inventoryKeys.details(), id] as const,
};

export const customerPriceKeys = {
  all: ['customer-product-prices'] as const,
  byCustomer: (customerId: string) => [...customerPriceKeys.all, 'by-customer', customerId] as const,
};

export const customerKeys = {
  all: ['customers'] as const,
  lists: () => [...customerKeys.all, 'list'] as const,
  /** `companyId` isolates cache per active company (after switch / new org). */
  list: (params: { page: number; search: string; companyId: string }) => [...customerKeys.lists(), params] as const,
  details: () => [...customerKeys.all, 'detail'] as const,
  detail: (id: string) => [...customerKeys.details(), id] as const,
};

export const productKeys = {
  all: ['products'] as const,
  lists: () => [...productKeys.all, 'list'] as const,
  list: (params: { page: number; sku: string; isService?: boolean }) => [...productKeys.lists(), params] as const,
  details: () => [...productKeys.all, 'detail'] as const,
  detail: (id: string) => [...productKeys.details(), id] as const,
};

/** List cache key — include filter fields so main/mobile (and `companyId`) do not clash. */
export type WarehouseListKeyParams = {
  page: number;
  companyId?: string;
  page_size?: number;
  warehouse_type?: string;
  is_active?: boolean;
  ordering?: string;
};

export const warehouseKeys = {
  all: ['warehouses'] as const,
  lists: () => [...warehouseKeys.all, 'list'] as const,
  list: (params: WarehouseListKeyParams) => [...warehouseKeys.lists(), params] as const,
  details: () => [...warehouseKeys.all, 'detail'] as const,
  detail: (id: string) => [...warehouseKeys.details(), id] as const,
};

export const companyKeys = {
  all: ['companies'] as const,
  me: () => [...companyKeys.all, 'me'] as const,
  modules: (companyId: string) => [...companyKeys.all, 'modules', companyId] as const,
  workflowSettings: (companyId: string) => [...companyKeys.all, 'workflow-settings', companyId] as const,
  ksefCertificateStatus: (companyId: string) =>
    [...companyKeys.all, 'ksef-certificate', 'status', companyId] as const,
  roles: (companyId: string) => [...companyKeys.all, 'roles', companyId] as const,
  members: (companyId: string) => [...companyKeys.all, 'members', companyId] as const,
};

/** List cache key: page + active company + filter fields (after `page` is stripped from `OrderListParams`). */
export type OrderListKeyParams = Omit<OrderListParams, 'page'> & { page: number; companyId: string };

export const orderKeys = {
  all: ['orders'] as const,
  lists: () => [...orderKeys.all, 'list'] as const,
  list: (params: OrderListKeyParams) => [...orderKeys.lists(), params] as const,
  byDate: (date: string, companyId: string) =>
    [...orderKeys.lists(), { delivery_date: date, companyId }] as const,
  details: () => [...orderKeys.all, 'detail'] as const,
  detail: (id: string) => [...orderKeys.details(), id] as const,
  changelog: (id: string) => [...orderKeys.details(), id, 'changelog'] as const,
};

/** List cache key: page + active company + filter fields (after `page` is stripped from `DeliveryListParams`). */
export type DeliveryListKeyParams = Omit<DeliveryListParams, 'page'> & { page: number; companyId: string };

export const deliveryKeys = {
  all: ['delivery-documents'] as const,
  lists: () => [...deliveryKeys.all, 'list'] as const,
  list: (params: DeliveryListKeyParams) => [...deliveryKeys.lists(), params] as const,
  details: () => [...deliveryKeys.all, 'detail'] as const,
  detail: (id: string) => [...deliveryKeys.details(), id] as const,
  previews: () => [...deliveryKeys.all, 'preview'] as const,
  preview: (id: string) => [...deliveryKeys.previews(), id] as const,
};

/** List cache key: page + active company (and future filters from `InvoiceListParams`). */
export type InvoiceListKeyParams = Omit<InvoiceListParams, 'page'> & {
  page: number;
  companyId: string;
};

export const invoiceKeys = {
  all: ['invoices'] as const,
  lists: () => [...invoiceKeys.all, 'list'] as const,
  list: (params: InvoiceListKeyParams) => [...invoiceKeys.lists(), params] as const,
  details: () => [...invoiceKeys.all, 'detail'] as const,
  detail: (id: string) => [...invoiceKeys.details(), id] as const,
  previews: () => [...invoiceKeys.all, 'preview'] as const,
  preview: (id: string) => [...invoiceKeys.previews(), id] as const,
};

export type ReportRangeKeyParams = {
  companyId: string;
  dateFrom: string;
  dateTo: string;
};

/** Cache key for `GET /reports/invoices/` — empty strings mean “no filter” for stable keys. */
export type ReportingInvoicesListKeyParams = {
  companyId: string;
  page: number;
  dateFrom: string;
  dateTo: string;
  status: string;
};

export const reportKeys = {
  all: ['reports'] as const,
  salesSummary: (p: ReportRangeKeyParams) => [...reportKeys.all, 'sales-summary', p] as const,
  topProducts: (p: ReportRangeKeyParams & { limit: number }) =>
    [...reportKeys.all, 'top-products', p] as const,
  topCustomers: (p: ReportRangeKeyParams & { limit: number }) =>
    [...reportKeys.all, 'top-customers', p] as const,
  ksefStatus: (companyId: string) => [...reportKeys.all, 'ksef-status', companyId] as const,
  reportingInvoices: (p: ReportingInvoicesListKeyParams) =>
    [...reportKeys.all, 'invoices', p] as const,
  inventory: (companyId: string) => [...reportKeys.all, 'inventory', companyId] as const,
  dashboard: (companyId: string) => [...reportKeys.all, 'dashboard', companyId] as const,
  profitLoss: (p: ReportRangeKeyParams) => [...reportKeys.all, 'profit-loss', p] as const,
  productMargin: (p: ReportRangeKeyParams & { limit: number }) =>
    [...reportKeys.all, 'product-margin', p] as const,
  paymentAging: (companyId: string) => [...reportKeys.all, 'payment-aging', companyId] as const,
  supplierCosts: (p: ReportRangeKeyParams) => [...reportKeys.all, 'supplier-costs', p] as const,
  supplierCostsDetail: (p: { companyId: string; supplierId: string | null; dateFrom: string; dateTo: string }) =>
    [...reportKeys.all, 'supplier-costs-detail', p] as const,
  expiryAlerts: (companyId: string, days: number) =>
    [...reportKeys.all, 'expiry-alerts', companyId, days] as const,
  customerMargin: (p: ReportRangeKeyParams & { limit: number }) =>
    [...reportKeys.all, 'customer-margin', p] as const,
};

export const vanRouteKeys = {
  all: ['van-routes'] as const,
  lists: () => [...vanRouteKeys.all, 'list'] as const,
  list: (companyId: string) => [...vanRouteKeys.lists(), companyId] as const,
  details: () => [...vanRouteKeys.all, 'detail'] as const,
  detail: (id: string) => [...vanRouteKeys.details(), id] as const,
};

export const stockSnapshotKeys = {
  all: ['stock-snapshot'] as const,
  byWarehouse: (warehouseId: string) => [...stockSnapshotKeys.all, warehouseId] as const,
};

export const warehouseStockKeys = {
  all: ['warehouse-stock'] as const,
  byWarehouse: (warehouseId: string, params?: object) =>
    [...warehouseStockKeys.all, warehouseId, params ?? {}] as const,
};

export type StockMovementParams = {
  product?: string;
  warehouse?: string;
  type?: string;
  date_from?: string;
  date_to?: string;
  page?: number;
  page_size?: number;
};

export const stockMovementKeys = {
  all: ['stock-movements'] as const,
  list: (params: StockMovementParams) => [...stockMovementKeys.all, 'list', params] as const,
};

export type SupplierListKeyParams = {
  page: number;
  companyId: string;
  search?: string;
  ordering?: string;
};

export const supplierKeys = {
  all: ['suppliers'] as const,
  lists: () => [...supplierKeys.all, 'list'] as const,
  list: (params: SupplierListKeyParams) => [...supplierKeys.lists(), params] as const,
  /** Stable key for full dropdown list (no pagination, no filters). */
  all_active: (companyId: string) => [...supplierKeys.lists(), { companyId, page_size: 500 }] as const,
  details: () => [...supplierKeys.all, 'detail'] as const,
  detail: (id: string) => [...supplierKeys.details(), id] as const,
};
