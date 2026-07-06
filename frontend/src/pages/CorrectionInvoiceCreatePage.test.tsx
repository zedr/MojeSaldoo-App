/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TestQueryProvider } from '@/test/TestQueryProvider';
import { CorrectionInvoiceCreatePage } from './CorrectionInvoiceCreatePage';
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
    items: [
      {
        id: 'item-1',
        order_item: null,
        product: null,
        product_name: 'Chleb razowy',
        product_unit: 'szt',
        pkwiu: '',
        quantity: '10',
        unit_price_net: '4.07',
        vat_rate: '23',
        line_net: '40.70',
        line_vat: '9.36',
        line_gross: '50.06',
        created_at: '2026-05-15T10:00:00Z',
      },
    ],
    ...over,
  };
}

// ── mocks ─────────────────────────────────────────────────────────────────────

const mockMutateAsync = vi.hoisted(() => vi.fn());
const mockUseInvoiceQuery = vi.hoisted(() => vi.fn());
const mockUseCreateCorrectionMutation = vi.hoisted(() =>
  vi.fn(() => ({ isPending: false, mutateAsync: mockMutateAsync })),
);

vi.mock('@/query/use-invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/query/use-invoices')>();
  return {
    ...actual,
    useInvoiceQuery: (...args: unknown[]) => mockUseInvoiceQuery(...args),
    useCreateCorrectionMutation: () => mockUseCreateCorrectionMutation(),
  };
});

// ── render helper ──────────────────────────────────────────────────────────────

function renderPage(invoiceId = 'inv-1') {
  return render(
    <TestQueryProvider>
      <MemoryRouter initialEntries={[`/invoices/${invoiceId}/correction/new`]}>
        <Routes>
          <Route path="/invoices/:id/correction/new" element={<CorrectionInvoiceCreatePage />} />
          <Route path="/invoices/:id" element={<div data-testid="invoice-detail">Faktura</div>} />
        </Routes>
      </MemoryRouter>
    </TestQueryProvider>,
  );
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('CorrectionInvoiceCreatePage', () => {
  beforeEach(() => {
    mockMutateAsync.mockReset();
    mockUseCreateCorrectionMutation.mockReturnValue({ isPending: false, mutateAsync: mockMutateAsync });
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice(),
      isLoading: false,
    });
  });

  it('renders correction form with original invoice number in heading', () => {
    renderPage();
    expect(screen.getByText(/Korekta do faktury FV\/2026\/0001/)).toBeInTheDocument();
  });

  it('renders item rows from the original invoice', () => {
    renderPage();
    expect(screen.getByText('Chleb razowy')).toBeInTheDocument();
  });

  it('submit button is disabled when correction reason is empty', () => {
    renderPage();
    // Button is disabled via the `disabled` prop when reason is blank
    expect(screen.getByRole('button', { name: /Utwórz korektę FV/ })).toBeDisabled();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('calls create-correction mutation with correct payload on submit', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ id: 'kor-1', corrects_invoice_id: 'inv-1' });
    renderPage();

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Błędna ilość');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: 'inv-1',
        body: expect.objectContaining({ correction_reason: 'Błędna ilość' }),
      });
    });
  });

  it('navigates to the new correction page on successful submit', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ id: 'kor-1', corrects_invoice_id: 'inv-1' });
    renderPage();

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Zwrot towaru');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(screen.getByTestId('invoice-detail')).toBeInTheDocument();
    });
  });

  it('shows an error message when mutation fails', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockRejectedValue(new Error('Błąd serwera'));
    renderPage();

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Korekta');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Błąd serwera');
    });
  });

  it('shows guard message for draft invoice instead of form', () => {
    mockUseInvoiceQuery.mockReturnValue({
      data: makeInvoice({ status: 'draft' }),
      isLoading: false,
    });
    renderPage();
    expect(
      screen.getByText(/Korektę można wystawić tylko do faktury wystawionej, wysłanej lub opłaconej/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Utwórz korektę FV/ })).not.toBeInTheDocument();
  });

  it('remove line — toggles strikethrough and sends remove: true in payload', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ id: 'kor-1', corrects_invoice_id: 'inv-1' });
    renderPage();

    // Click "Usuń" button for the item row
    await user.click(screen.getByRole('button', { name: /Usuń/i }));
    // Product name should have line-through class (row marked removed)
    expect(screen.getByText('Chleb razowy').closest('td')).toHaveClass('line-through');

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Usunięcie pozycji');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: 'inv-1',
        body: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ item_id: 'item-1', remove: true }),
          ]),
        }),
      });
    });
  });

  it('restore line — clicking Przywróć removes strikethrough', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /Usuń/i }));
    expect(screen.getByText('Chleb razowy').closest('td')).toHaveClass('line-through');

    await user.click(screen.getByRole('button', { name: /Przywróć/i }));
    expect(screen.getByText('Chleb razowy').closest('td')).not.toHaveClass('line-through');
  });

  it('add new line — row appears after clicking Dodaj pozycję', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ id: 'kor-1', corrects_invoice_id: 'inv-1' });
    renderPage();

    await user.click(screen.getByRole('button', { name: /Dodaj pozycję/i }));
    expect(screen.getByTestId('new-line-row')).toBeInTheDocument();

    // Fill in the new line
    const nameInput = screen.getByPlaceholderText(/Nazwa produktu/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Nowy produkt');

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Dodanie produktu');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: 'inv-1',
        body: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ product_name: 'Nowy produkt' }),
          ]),
        }),
      });
    });
  });

  it('VAT rate change — sends vat_rate in payload', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ id: 'kor-1', corrects_invoice_id: 'inv-1' });
    renderPage();

    // Change VAT select for the existing item (labeled "Stawka VAT")
    const vatSelects = screen.getAllByRole('combobox', { name: /Stawka VAT/i });
    await user.selectOptions(vatSelects[0], '8');

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Zmiana VAT');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: 'inv-1',
        body: expect.objectContaining({
          items: expect.arrayContaining([
            expect.objectContaining({ item_id: 'item-1', vat_rate: '8' }),
          ]),
        }),
      });
    });
  });

  it('header due_date override — sends due_date in payload when changed', async () => {
    const user = userEvent.setup();
    mockMutateAsync.mockResolvedValue({ id: 'kor-1', corrects_invoice_id: 'inv-1' });
    renderPage();

    // The due_date field is a <input type="date"> — query by type to avoid ambiguity
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
    await user.type(dateInput, '2026-12-31');

    await user.type(screen.getByPlaceholderText(/Wpisz powód korekty/i), 'Korekta terminu');
    await user.click(screen.getByRole('button', { name: /Utwórz korektę FV/ }));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith({
        id: 'inv-1',
        body: expect.objectContaining({ due_date: '2026-12-31' }),
      });
    });
  });
});
