import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    get: mocks.get,
    post: mocks.post,
    put: mocks.put,
    patch: mocks.patch,
    delete: mocks.delete,
  },
}));

import type { ProductWrite } from '../types';
import { productService } from './product.service';

describe('productService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetchList calls GET /products/ with params', async () => {
    const page = { count: 0, next: null, previous: null, results: [] };
    mocks.get.mockResolvedValue(page);

    const result = await productService.fetchList({ page: 2, search: 'milk', is_active: true });

    expect(result).toBe(page);
    expect(mocks.get).toHaveBeenCalledWith('/products/', {
      params: { page: 2, search: 'milk', is_active: true },
    });
  });

  it('fetchById calls GET /products/:id/', async () => {
    mocks.get.mockResolvedValue({ id: 'p1' });
    await productService.fetchById('p1');
    expect(mocks.get).toHaveBeenCalledWith('/products/p1/');
  });

  it('createItem posts body to /products/', async () => {
    const body: ProductWrite = {
      name: 'X',
      description: null,
      unit: 'szt',
      price_net: '1',
      price_gross: '1.23',
      vat_rate: '23',
      sku: null,
      barcode: null,
      pkwiu: '',
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
    };
    mocks.post.mockResolvedValue({ id: 'new', ...body });
    await productService.createItem(body);
    expect(mocks.post).toHaveBeenCalledWith('/products/', body);
  });

  it('updateItem puts body to /products/:id/', async () => {
    const body = { name: 'Y' } as ProductWrite;
    mocks.put.mockResolvedValue({ id: 'p1' });
    await productService.updateItem('p1', body);
    expect(mocks.put).toHaveBeenCalledWith('/products/p1/', body);
  });

  it('deleteItem sends DELETE /products/:id/', async () => {
    mocks.delete.mockResolvedValue({});
    await productService.deleteItem('p1');
    expect(mocks.delete).toHaveBeenCalledWith('/products/p1/');
  });

  it('partialUpdateItem patches /products/:id/', async () => {
    mocks.patch.mockResolvedValue({ id: 'p1' });
    await productService.partialUpdateItem('p1', { name: 'Z' });
    expect(mocks.patch).toHaveBeenCalledWith('/products/p1/', { name: 'Z' });
  });

  it('updateStock posts to update-stock action', async () => {
    const payload = { quantity_change: '5', warehouse_id: 'w1' };
    mocks.post.mockResolvedValue({ id: 'm1' });
    await productService.updateStock('p1', payload);
    expect(mocks.post).toHaveBeenCalledWith('/products/p1/update-stock/', payload);
  });

  it('fetchStockSnapshot calls GET /products/stock-snapshot/ with warehouse_id param', async () => {
    const snap = {
      warehouse_id: 'w-1',
      warehouse_name: 'Van',
      items: [
        { product_id: 'p1', product_name: 'A', sku: null, unit: 'szt', quantity_available: '3.000' },
      ],
    };
    mocks.get.mockResolvedValue(snap);
    const result = await productService.fetchStockSnapshot('w-1');
    expect(result).toBe(snap);
    expect(mocks.get).toHaveBeenCalledWith('/products/stock-snapshot/', { params: { warehouse_id: 'w-1' } });
  });
});
