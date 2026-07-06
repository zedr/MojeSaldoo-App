/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProductForm, productFormSchema } from './ProductForm';
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

const baseProduct: Product = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  user: 1,
  name: 'Widget',
  description: null,
  unit: 'szt',
  price_net: '10.00',
  price_gross: '12.30',
  vat_rate: '23',
  sku: null,
  barcode: null,
  pkwiu: '',
  track_batches: true,
  min_stock_alert: '0',
  shelf_life_days: 30,
  is_service: false,
  is_resalable: false,
  markup_percent: null,
  avg_cost: null,
  avg_cost_source: null,
  avg_cost_updated_at: null,
  last_cost: null,
  is_active: true,
  created_at: '2025-01-01T00:00:00.000Z',
  updated_at: '2025-01-02T00:00:00.000Z',
};

describe('productFormSchema', () => {
  it('accepts valid defaults', () => {
    const parsed = productFormSchema.parse({
      name: 'X',
      description: '',
      unit: 'szt',
      price_net: '1',
      price_gross: '1.23',
      vat_rate: '23',
      sku: '',
      barcode: '',
      pkwiu: '',
      track_batches: true,
      min_stock_alert: '0',
      shelf_life_days: '',
      is_active: true,
    });
    expect(parsed.name).toBe('X');
  });

  it('rejects invalid decimals', () => {
    expect(() =>
      productFormSchema.parse({
        name: 'X',
        description: '',
        unit: 'szt',
        price_net: '1.234',
        price_gross: '1',
        vat_rate: '23',
        sku: '',
        barcode: '',
        pkwiu: '',
        track_batches: true,
        min_stock_alert: '0',
        shelf_life_days: '',
        is_active: true,
      }),
    ).toThrow();
  });

  it('rejects pkwiu longer than 20 characters', () => {
    const base = {
      name: 'X',
      description: '',
      unit: 'szt',
      price_net: '1',
      price_gross: '1.23',
      vat_rate: '23',
      sku: '',
      barcode: '',
      track_batches: true,
      min_stock_alert: '0',
      shelf_life_days: '',
      is_active: true,
    };
    expect(() =>
      productFormSchema.parse({
        ...base,
        pkwiu: 'x'.repeat(21),
      }),
    ).toThrow();
    const parsed = productFormSchema.parse({
      ...base,
      pkwiu: 'x'.repeat(20),
    });
    expect(parsed.pkwiu).toHaveLength(20);
  });
});

describe('ProductForm', () => {
  it('renders create mode submit', () => {
    render(<ProductForm onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /zapisz produkt/i })).toBeInTheDocument();
  });

  it('renders edit mode title when product is provided', () => {
    render(<ProductForm product={baseProduct} onSubmit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /zapisz zmiany/i })).toBeInTheDocument();
  });

  it('renders Kod PKWiU field with placeholder and KSeF help text', () => {
    render(<ProductForm onSubmit={vi.fn()} />);
    expect(screen.getByRole('textbox', { name: /kod pkwiu/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('np. 10.89.19.0')).toBeInTheDocument();
    expect(screen.getByText('Przydatne przy fakturach KSeF')).toBeInTheDocument();
  });

  it('prefills pkwiu in edit mode', () => {
    render(
      <ProductForm
        product={{ ...baseProduct, pkwiu: '62.01.11.0' }}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('textbox', { name: /kod pkwiu/i })).toHaveValue('62.01.11.0');
  });

  it('shows validation error when name is empty', async () => {
    const user = userEvent.setup();
    const { container } = render(<ProductForm onSubmit={vi.fn()} />);

    const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]');
    expect(nameInput).toBeTruthy();
    await user.clear(nameInput!);

    await user.click(screen.getByRole('button', { name: /zapisz produkt/i }));

    expect(await screen.findByText('Nazwa jest wymagana')).toBeInTheDocument();
  });

  it('submits create payload with normalized nullables', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(<ProductForm onSubmit={onSubmit} />);

    const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    await user.clear(nameInput);
    await user.type(nameInput, 'Mleko 2%');

    await user.click(screen.getByRole('button', { name: /zapisz produkt/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Mleko 2%',
        description: null,
        unit: 'szt',
        price_net: '0',
        price_gross: '0',
        vat_rate: '23',
        sku: null,
        barcode: null,
        pkwiu: '',
        track_batches: true,
        min_stock_alert: '0',
        shelf_life_days: null,
        is_active: true,
      }),
    );
  });

  it('submits create with trimmed pkwiu', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(<ProductForm onSubmit={onSubmit} />);

    const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    await user.clear(nameInput);
    await user.type(nameInput, 'Towar');

    const pkwiuInput = screen.getByRole('textbox', { name: /kod pkwiu/i });
    await user.type(pkwiuInput, '  10.89.19.0  ');

    await user.click(screen.getByRole('button', { name: /zapisz produkt/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Towar',
        pkwiu: '10.89.19.0',
      }),
    );
  });

  it('submits update payload including product id', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(<ProductForm product={baseProduct} onSubmit={onSubmit} />);

    const nameInput = container.querySelector<HTMLInputElement>('input[name="name"]')!;
    await user.clear(nameInput);
    await user.type(nameInput, 'Updated');

    await user.click(screen.getByRole('button', { name: /zapisz zmiany/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: baseProduct.id,
        name: 'Updated',
      }),
    );
  });

  it('calls onCancel when Anuluj is clicked', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<ProductForm onSubmit={vi.fn()} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: /anuluj/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
