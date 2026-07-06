/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TestQueryProvider } from '@/test/TestQueryProvider';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { authStorage } from '@/services/api';
import type { Invoice } from '@/types';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    company: 'co-1',
    user: 1,
    order: {
      id: 'ord-1',
      customer_id: 'c-1',
      customer_name: 'Klient SA',
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
    },
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

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockUseInvoiceQuery = vi.hoisted(() => vi.fn());
const mockUseInvoicePreviewQuery = vi.hoisted(() => vi.fn());
const mockMutation = vi.hoisted(() => vi.fn(() => ({ isPending: false, mutateAsync: vi.fn() })));
const mockUseKsefSessionQuery = vi.hoisted(() => vi.fn(() => ({ data: null })));
const mockUseMyCompaniesQuery = vi.hoisted(() => vi.fn(() => ({ data: [] })));
const mockUseAuth = vi.hoisted(() => vi.fn(() => ({ user: { current_company: 'co-1' } })));
const mockUsePermission = vi.hoisted(() => vi.fn(() => true));

vi.mock('@/query/use-invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/query/use-invoices')>();
  return {
    ...actual,
    useInvoiceQuery: (...args: unknown[]) => mockUseInvoiceQuery(...args),
    useInvoicePreviewQuery: (...args: unknown[]) => mockUseInvoicePreviewQuery(...args),
    useIssueInvoiceMutation: () => mockMutation(),
    useMarkPaidInvoiceMutation: () => mockMutation(),
    useSendToKsefMutation: () => mockMutation(),
    useKsefAuthenticateMutation: () => mockMutation(),
    useFetchKsefStatusMutation: () => mockMutation(),
    useCreateCorrectionMutation: () => mockMutation(),
    useKsefSessionQuery: () => mockUseKsefSessionQuery(),
  };
});

vi.mock('@/query/use-companies', () => ({
  useMyCompaniesQuery: () => mockUseMyCompaniesQuery(),
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/usePermission', () => ({
  usePermission: () => mockUsePermission(),
}));

vi.mock('@/lib/openInvoicePrintWindow', () => ({
  openInvoicePrintWindow: vi.fn(),
}));

vi.spyOn(authStorage, 'getAccessToken').mockReturnValue('test-token');

// ── render helper ──────────────────────────────────────────────────────────────

function renderDetail(invoiceId = 'inv-1') {
  return render(
    <TestQueryProvider>
      <MemoryRouter initialEntries={[`/invoices/${invoiceId}`]}>
        <Routes>
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/login" element={<div>Logowanie</div>} />
          <Route path="/invoices/:id/correction/new" element={<div>Korekta</div>} />
        </Routes>
      </MemoryRouter>
    </TestQueryProvider>,
  );
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('InvoiceDetailPage — "Utwórz korektę FV" button visibility', () => {
  beforeEach(() => {
    mockUseInvoicePreviewQuery.mockReturnValue({
      data: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
  });

  it('shows button for issued invoice', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'issued' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
    renderDetail();
    expect(screen.getByRole('button', { name: 'Utwórz korektę FV' })).toBeInTheDocument();
  });

  it('shows button for paid invoice', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'paid' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
    renderDetail();
    expect(screen.getByRole('button', { name: 'Utwórz korektę FV' })).toBeInTheDocument();
  });

  it('shows button for sent (KSeF) invoice', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'sent' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
    renderDetail();
    expect(screen.getByRole('button', { name: 'Utwórz korektę FV' })).toBeInTheDocument();
  });

  it('hides button for draft invoice', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'draft' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Utwórz korektę FV' })).not.toBeInTheDocument();
  });

  it('hides button for cancelled invoice', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'cancelled' }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Utwórz korektę FV' })).not.toBeInTheDocument();
  });

  it('hides button when the invoice itself is a correction', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'issued', is_correction: true }),
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isFetching: false,
    });
    renderDetail();
    expect(screen.queryByRole('button', { name: 'Utwórz korektę FV' })).not.toBeInTheDocument();
  });
});
