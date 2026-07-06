/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TestQueryProvider } from '@/test/TestQueryProvider';
import {
  InvoicesPage,
  buildInvoiceListFilters,
  invoiceStatusBadgeClassName,
  invoiceKsefStatusBadgeClassName,
} from './InvoicesPage';
import { authStorage } from '@/services/api';
import type { InvoiceListFilters } from '@/query/use-invoices';
import type { Customer, Invoice, Order } from '@/types';

const useInvoiceListQueryMock = vi.hoisted(() =>
  vi.fn(((_page: number, _filters: InvoiceListFilters) => ({
    data: {
      count: 0,
      next: null,
      previous: null,
      results: [] as Invoice[],
    },
    isFetching: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })) as (page: number, filters: InvoiceListFilters) => {
    data: { count: number; next: null; previous: null; results: Invoice[] };
    isFetching: boolean;
    isError: boolean;
    error: null;
    refetch: ReturnType<typeof vi.fn>;
  }),
);

const useCustomerListQueryMock = vi.hoisted(() =>
  vi.fn((_page: number, _search: string) => ({
    data: { count: 0, next: null, previous: null, results: [] as Customer[] },
    isFetching: false,
  })),
);

vi.mock('@/query/use-invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/query/use-invoices')>();
  return {
    ...actual,
    useInvoiceListQuery: (page: number, filters: InvoiceListFilters) =>
      useInvoiceListQueryMock(page, filters),
  };
});

vi.mock('@/query/use-customers', () => ({
  useCustomerListQuery: (page: number, search: string) =>
    useCustomerListQueryMock(page, search),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => true,
}));

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'ord-1',
    customer_id: 'c-1',
    customer_name: 'Klient testowy',
    company: 'co-1',
    user: null,
    order_number: 'ZAM/2026/0001',
    order_date: '2026-05-01',
    delivery_date: '2026-05-10',
    status: 'delivered',
    subtotal_net: '100',
    subtotal_gross: '123',
    discount_percent: '0',
    discount_amount: '0',
    total_net: '100',
    total_gross: '123',
    customer_notes: '',
    internal_notes: '',
    created_at: '2026-05-01T10:00:00Z',
    updated_at: '2026-05-01T10:00:00Z',
    confirmed_at: null,
    delivered_at: null,
    items: [],
    ...over,
  };
}

function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    company: 'co-1',
    user: 1,
    order: makeOrder(),
    customer: 'c-1',
    delivery_document: null,
    invoice_number: 'FV/2026/0001',
    issue_date: '2026-05-15',
    sale_date: '2026-05-15',
    due_date: '2026-05-29',
    payment_method: 'transfer',
    subtotal_net: '100.00',
    subtotal_gross: '123.00',
    vat_amount: '23.00',
    total_gross: '123.00',
    ksef_reference_number: '',
    ksef_number: '',
    ksef_status: 'not_sent',
    ksef_sent_at: null,
    ksef_error_message: '',
    invoice_hash: '',
    upo_received: false,
    status: 'issued',
    paid_at: null,
    notes: '',
    created_at: '2026-05-15T10:00:00Z',
    updated_at: '2026-05-15T10:00:00Z',
    is_correction: false,
    corrects_invoice_id: null,
    corrects_invoice_number: null,
    correction_reason: '',
    corrections: [],
    items: [],
    ...over,
  };
}

function renderInvoicesRoute() {
  return render(
    <TestQueryProvider>
      <MemoryRouter initialEntries={['/invoices']}>
        <Routes>
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/login" element={<div>Logowanie</div>} />
          <Route path="/orders/:id" element={<div>Zamówienie</div>} />
        </Routes>
      </MemoryRouter>
    </TestQueryProvider>,
  );
}

describe('buildInvoiceListFilters + badge helpers', () => {
  it('passes optional status, ksef_status, customer, issue date range', () => {
    expect(buildInvoiceListFilters('', '', '', '', '')).toEqual({});
    expect(
      buildInvoiceListFilters('draft', 'pending', 'cust-1', '2026-04-01', '2026-04-30'),
    ).toEqual({
      status: 'draft',
      ksef_status: 'pending',
      customer: 'cust-1',
      issue_date_after: '2026-04-01',
      issue_date_before: '2026-04-30',
    });
  });

  it('includes is_correction when provided', () => {
    expect(buildInvoiceListFilters('', '', '', '', '', true)).toMatchObject({ is_correction: true });
    expect(buildInvoiceListFilters('', '', '', '', '', false)).toMatchObject({ is_correction: false });
    expect(buildInvoiceListFilters('', '', '', '', '', undefined)).not.toHaveProperty('is_correction');
  });

  it('invoice status badge classes', () => {
    expect(invoiceStatusBadgeClassName('draft')).toContain('surface-container');
    expect(invoiceStatusBadgeClassName('paid')).toContain('green');
    expect(invoiceStatusBadgeClassName('cancelled')).toContain('red');
  });

  it('KSeF status badge classes', () => {
    expect(invoiceKsefStatusBadgeClassName('not_sent')).toContain('surface-container');
    expect(invoiceKsefStatusBadgeClassName('accepted')).toContain('green');
    expect(invoiceKsefStatusBadgeClassName('rejected')).toContain('red');
  });
});

describe('InvoicesPage', () => {
  const getToken = vi.spyOn(authStorage, 'getAccessToken');

  beforeEach(() => {
    getToken.mockReturnValue('test-access-token');
    useInvoiceListQueryMock.mockReset();
    useInvoiceListQueryMock.mockImplementation(() => ({
      data: { count: 0, next: null, previous: null, results: [] },
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }));
    useCustomerListQueryMock.mockReset();
    useCustomerListQueryMock.mockImplementation(() => ({
      data: { count: 0, next: null, previous: null, results: [] },
      isFetching: false,
    }));
  });

  afterEach(() => {
    getToken.mockReset();
  });

  it('redirects to login when there is no access token', () => {
    getToken.mockReturnValue(null);
    renderInvoicesRoute();
    expect(screen.getByText('Logowanie')).toBeInTheDocument();
  });

  it('renders title and invoice table headers', () => {
    renderInvoicesRoute();
    expect(screen.getByRole('heading', { name: 'Faktury' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Lista faktur' });
    expect(within(table).getByRole('columnheader', { name: 'Nr faktury' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Klient' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Data wystawienia' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Termin płatności' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Wartość brutto' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Status KSeF' })).toBeInTheDocument();
  });

  it('shows invoice number, client, dates, gross, and status labels', () => {
    const inv = makeInvoice();
    useInvoiceListQueryMock.mockReturnValue({
      data: { count: 1, next: null, previous: null, results: [inv] },
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    renderInvoicesRoute();
    const table = screen.getByRole('table', { name: 'Lista faktur' });
    expect(
      within(table).getByRole('link', { name: 'FV/2026/0001' }),
    ).toHaveAttribute('href', '/invoices/inv-1');
    expect(within(table).getByText('Klient testowy')).toBeInTheDocument();
    expect(within(table).getByText('Wystawiona')).toBeInTheDocument();
    expect(within(table).getByText('Nie wysłana')).toBeInTheDocument();
  });

  it('applies status and ksef filters to the list query', async () => {
    const user = userEvent.setup();
    renderInvoicesRoute();
    await user.selectOptions(screen.getByLabelText('Filtruj po statusie faktury'), 'paid');
    await user.selectOptions(screen.getByLabelText('Filtruj po statusie KSeF'), 'accepted');
    const last = useInvoiceListQueryMock.mock.calls.at(-1);
    expect(last?.[0]).toBe(1);
    expect(last?.[1]).toMatchObject({
      status: 'paid',
      ksef_status: 'accepted',
    });
  });

  it('sends issue date range in list query params', async () => {
    const user = userEvent.setup();
    renderInvoicesRoute();
    await user.clear(screen.getByLabelText('Data wystawienia od'));
    await user.type(screen.getByLabelText('Data wystawienia od'), '2026-06-01');
    await user.clear(screen.getByLabelText('Data wystawienia do'));
    await user.type(screen.getByLabelText('Data wystawienia do'), '2026-06-15');
    const last = useInvoiceListQueryMock.mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({
      issue_date_after: '2026-06-01',
      issue_date_before: '2026-06-15',
    });
  });

  it('applies customer id filter when selected from dropdown', async () => {
    const user = userEvent.setup();
    useCustomerListQueryMock.mockImplementation(() => ({
      data: {
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 'cust-x',
            user: null,
            name: 'Acme',
            company_name: 'Acme SA',
            nip: '1234567890',
            email: null,
            phone: null,
            street: null,
            city: null,
            postal_code: null,
            country: 'PL',
            distance_km: null,
            delivery_days: null,
            payment_terms: 14,
            credit_limit: '0',
            is_active: true,
            created_at: '',
            updated_at: '',
          },
        ] as Customer[],
      },
      isFetching: false,
    }));
    renderInvoicesRoute();
    const custSelect = screen.getByLabelText('Filtruj po kliencie');
    await user.selectOptions(custSelect, 'cust-x');
    const last = useInvoiceListQueryMock.mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({ customer: 'cust-x' });
  });

  it('shows KOR badge and "Koryguje" link for correction invoices', () => {
    const kor = makeInvoice({
      id: 'kor-1',
      invoice_number: 'FV-KOR/2026/0001',
      is_correction: true,
      corrects_invoice_id: 'inv-orig',
      corrects_invoice_number: 'FV/2026/0001',
    });
    useInvoiceListQueryMock.mockReturnValue({
      data: { count: 1, next: null, previous: null, results: [kor] },
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    renderInvoicesRoute();
    // Badge appears in both desktop table and mobile list
    expect(screen.getAllByText('KOR').length).toBeGreaterThan(0);
    const koryguje = screen.getAllByRole('link', { name: /Koryguje: FV\/2026\/0001/ })[0];
    expect(koryguje).toHaveAttribute('href', '/invoices/inv-orig');
  });

  it('does not show KOR badge for regular invoices', () => {
    const inv = makeInvoice({ is_correction: false });
    useInvoiceListQueryMock.mockReturnValue({
      data: { count: 1, next: null, previous: null, results: [inv] },
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    });
    renderInvoicesRoute();
    expect(screen.queryByText('KOR')).not.toBeInTheDocument();
  });

  it('correction filter button "Korekty FV-KOR" sends is_correction=true in query', async () => {
    const user = userEvent.setup();
    renderInvoicesRoute();
    await user.click(screen.getByRole('button', { name: 'Korekty FV-KOR' }));
    const last = useInvoiceListQueryMock.mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({ is_correction: true });
  });

  it('correction filter button "Tylko zwykłe" sends is_correction=false in query', async () => {
    const user = userEvent.setup();
    renderInvoicesRoute();
    await user.click(screen.getByRole('button', { name: 'Tylko zwykłe' }));
    const last = useInvoiceListQueryMock.mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({ is_correction: false });
  });

  it('correction filter "Wszystkie" clears is_correction from query', async () => {
    const user = userEvent.setup();
    renderInvoicesRoute();
    await user.click(screen.getByRole('button', { name: 'Korekty FV-KOR' }));
    await user.click(screen.getByRole('button', { name: 'Wszystkie' }));
    const last = useInvoiceListQueryMock.mock.calls.at(-1);
    expect(last?.[1]).not.toHaveProperty('is_correction');
  });
});
