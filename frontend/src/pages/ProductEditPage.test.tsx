/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProductEditPage } from './ProductEditPage';
import { TestQueryProvider } from '@/test/TestQueryProvider';
import { productService } from '@/services/product.service';
import { authStorage } from '@/services/api';
import type { Product } from '@/types';

vi.mock('framer-motion', () => {
  function passthrough(Tag: 'section') {
    return function MotionMock({
      children,
      ...rest
    }: React.PropsWithChildren<Record<string, unknown>>) {
      const { variants: _v, initial: _i, animate: _a, transition: _t, ...domProps } = rest;
      return React.createElement(Tag, domProps as Record<string, unknown>, children);
    };
  }
  return {
    motion: {
      section: passthrough('section'),
    },
  };
});

vi.mock('@/services/product.service', () => ({
  productService: {
    fetchList: vi.fn(),
    fetchById: vi.fn(),
    createItem: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    partialUpdateItem: vi.fn(),
    updateStock: vi.fn(),
    fetchStockSnapshot: vi.fn(),
  },
}));

const PRODUCT_ID = '550e8400-e29b-41d4-a716-446655440000';

function baseProduct(over: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    user: 1,
    name: 'Widget',
    description: null,
    unit: 'szt',
    price_net: '10.00',
    price_gross: '12.30',
    vat_rate: '23',
    sku: 'SKU-1',
    barcode: null,
    pkwiu: '10.11.12.0',
    track_batches: false,
    min_stock_alert: '0',
    shelf_life_days: null,
    is_service: false,
    is_resalable: false,
    markup_percent: null,
    avg_cost: null,
    avg_cost_source: null,
    avg_cost_updated_at: null,
    last_cost: null,
    is_active: true,
    stock_total: '5',
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

function renderEdit(initialPath = `/products/${PRODUCT_ID}/edit`) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <TestQueryProvider>
        <Routes>
          <Route path="/login" element={<h1>Logowanie</h1>} />
          <Route path="/products" element={<h1>Lista produktów</h1>} />
          <Route path="/products/:id/edit" element={<ProductEditPage />} />
        </Routes>
      </TestQueryProvider>
    </MemoryRouter>,
  );
}

describe('ProductEditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(authStorage, 'getAccessToken').mockReturnValue('test-token');
    vi.mocked(productService.fetchById).mockResolvedValue(baseProduct());
    vi.mocked(productService.updateItem).mockImplementation(async (id, body) => ({
      ...baseProduct(),
      ...body,
      id,
      updated_at: '2025-01-02T00:00:00.000Z',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects to login when there is no access token', async () => {
    vi.spyOn(authStorage, 'getAccessToken').mockReturnValue(null);
    renderEdit();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Logowanie' })).toBeInTheDocument();
    });
  });

  it('loads product, shows edit heading, stock correction link, and save', async () => {
    renderEdit();

    expect(await screen.findByRole('heading', { name: /edytuj produkt/i })).toBeInTheDocument();
    expect(await screen.findByText('Widget')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /zapisz zmiany/i })).toBeInTheDocument();

    const stockLink = await screen.findByRole('link', { name: /korekta stanów magazynowych/i });
    expect(stockLink).toHaveAttribute('href', `/products/${PRODUCT_ID}/adjust-stock`);

    expect(productService.fetchById).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('shows error and retries fetchById', async () => {
    vi.mocked(productService.fetchById)
      .mockRejectedValueOnce(new Error('Server error'))
      .mockResolvedValueOnce(baseProduct());

    renderEdit();

    expect(await screen.findByRole('alert')).toHaveTextContent('Server error');
    await userEvent.click(screen.getByRole('button', { name: /spróbuj ponownie/i }));

    await waitFor(() => {
      expect(productService.fetchById).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByRole('button', { name: /zapisz zmiany/i })).toBeInTheDocument();
  });

  it('submits update and navigates to product list', async () => {
    const user = userEvent.setup();
    renderEdit();

    await screen.findByRole('button', { name: /zapisz zmiany/i });

    const nameField = screen.getByRole('textbox', { name: /^nazwa$/i });
    await user.clear(nameField);
    await user.type(nameField, 'Widget Plus');

    await user.click(screen.getByRole('button', { name: /zapisz zmiany/i }));

    await waitFor(() => {
      expect(productService.updateItem).toHaveBeenCalled();
    });
    const putCall = vi.mocked(productService.updateItem).mock.calls[0];
    expect(putCall?.[0]).toBe(PRODUCT_ID);
    expect(putCall?.[1]).toMatchObject({ name: 'Widget Plus' });

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Lista produktów' })).toBeInTheDocument();
    });
  });
});
