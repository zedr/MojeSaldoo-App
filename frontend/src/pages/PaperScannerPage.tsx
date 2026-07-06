/**
 * PaperScannerPage — upload / photograph a paper invoice, extract header fields
 * via backend OCR, then create a PZ (goods receipt) from the scanned data.
 *
 * Route: /ksef/scan-paper
 * Module gate: ksef
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Navigate, useNavigate } from 'react-router-dom';
import { authStorage } from '@/services/api';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import { useCreatePzMutation } from '@/query/use-delivery';
import { useAllSuppliersQuery } from '@/query/use-suppliers';
import { useKsefScanPaperMutation } from '@/query/use-invoices';
import { productService } from '@/services/product.service';
import { supplierService } from '@/services/supplier.service';
import { warehouseService } from '@/services/warehouse.service';
import type { PaperScanLine } from '@/services/ksef.service';
import type { Product } from '@/types';

const PAGE_SIZE = 30;
const DEBOUNCE_MS = 300;

/* ── helpers ─────────────────────────────────────────────────────── */

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

function pageFromDrfNext(next: string | null): number | undefined {
  if (!next) return undefined;
  try {
    const u = new URL(next, 'http://localhost');
    const p = u.searchParams.get('page');
    return p ? Number(p) : undefined;
  } catch {
    return undefined;
  }
}

/* ── types ───────────────────────────────────────────────────────── */

interface PzLine {
  product: Product;
  quantity: string;
  unit_cost: string;
}

/** A line parsed from OCR that hasn't been matched to a product yet. */
interface RawOcrLine extends PaperScanLine {
  id: number; // stable index for keying
}

/* ── icons ───────────────────────────────────────────────────────── */

function ChevronLeftIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="17 8 12 3 7 8" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="3" x2="12" y2="15" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
      <polyline points="20 6 9 17 4 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A single unmatched OCR line with an inline product search.
 * When user picks a product it fires onAssign and this row disappears.
 */
function RawLineRow({
  line,
  companyId,
  onAssign,
  onDismiss,
}: {
  line: RawOcrLine;
  companyId: string;
  onAssign: (product: Product, quantity: string, unitPrice: string) => void;
  onDismiss: (id: number) => void;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const debouncedSearch = useDebouncedValue(search, 300);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { data: pages, isPending } = useInfiniteQuery({
    queryKey: ['products', 'raw-line', companyId, debouncedSearch] as const,
    queryFn: ({ pageParam }) =>
      productService.fetchList({
        page: pageParam as number,
        page_size: 20,
        search: debouncedSearch.trim() || undefined,
        is_active: true,
        ordering: 'name',
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => pageFromDrfNext(last.next),
    enabled: Boolean(companyId) && open,
  });

  const products = useMemo(() => pages?.pages.flatMap((p) => p.results) ?? [], [pages]);

  useEffect(() => {
    setSearch(line.name);
  }, [line.name]);

  const handleCreateNew = async () => {
    setCreating(true);
    try {
      const newProduct = await productService.createItem({
        name: search.trim() || line.name,
        description: null,
        unit: line.unit || 'szt',
        price_net: '0.00',
        price_gross: '0.00',
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
      });
      onAssign(newProduct, line.quantity, line.unit_price);
    } catch {
      // ignore — user can try again
    } finally {
      setCreating(false);
    }
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3">
      {/* OCR name + qty + price */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-medium text-foreground">{line.name}</p>
          <p className="text-xs text-muted-foreground">
            {line.quantity} {line.unit} × {line.unit_price} zł
          </p>
        </div>
        <button
          type="button"
          onClick={() => onDismiss(line.id)}
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="Pomiń tę pozycję"
        >
          <TrashIcon />
        </button>
      </div>

      {/* Product search */}
      <div ref={wrapRef} className="relative">
        <input
          type="text"
          placeholder="Wyszukaj produkt w bazie…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        {open && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
            {isPending && <p className="px-3 py-2 text-sm text-muted-foreground">Ładowanie…</p>}
            {!isPending && products.length === 0 && (
              <p className="px-3 py-2 text-sm text-muted-foreground">Brak wyników</p>
            )}
            {products.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAssign(p, line.quantity, line.unit_price);
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
              >
                <span>{p.name}</span>
                <span className="flex items-center gap-1 text-xs text-primary">
                  <CheckIcon /> przypisz
                </span>
              </button>
            ))}
            {/* Create new product from OCR name */}
            <button
              type="button"
              disabled={creating}
              onClick={() => { setOpen(false); void handleCreateNew(); }}
              className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-60"
            >
              <span className="text-lg leading-none">+</span>
              {creating ? 'Tworzę…' : `Utwórz nowy: „${search.trim() || line.name}"`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── main page ───────────────────────────────────────────────────── */

export function PaperScannerPage() {
  if (!authStorage.getAccessToken()) return <Navigate to="/login" replace />;

  return <PaperScannerPageInner />;
}

function PaperScannerPageInner() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const companyId = user?.current_company ?? '';
  const createPz = useCreatePzMutation();
  const scanMutation = useKsefScanPaperMutation();

  /* ── image state ─────────────────────────────────────────────── */
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* ── extracted / editable header fields ─────────────────────── */
  const todayIso = new Date().toISOString().slice(0, 10);
  const [issueDate, setIssueDate] = useState(todayIso);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [sellerName, setSellerName] = useState('');
  const [sellerNip, setSellerNip] = useState('');
  const [notes, setNotes] = useState('');

  /* ── PZ form state ───────────────────────────────────────────── */
  const [toWarehouseId, setToWarehouseId] = useState('');
  const [fromSupplierId, setFromSupplierId] = useState('');
  const [supplierSearch, setSupplierSearch] = useState('');
  const [supplierOpen, setSupplierOpen] = useState(false);
  const [supplierCreating, setSupplierCreating] = useState(false);
  const supplierRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<PzLine[]>([]);
  const [rawLines, setRawLines] = useState<RawOcrLine[]>([]);
  const [productSearch, setProductSearch] = useState('');
  const [showProductSearch, setShowProductSearch] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  /* show the PZ form only after an image is selected */
  const [formVisible, setFormVisible] = useState(false);

  const searchRef = useRef<HTMLDivElement>(null);
  const productSearchDebounced = useDebouncedValue(productSearch, DEBOUNCE_MS);

  /* warehouses */
  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!companyId) return;
    warehouseService
      .fetchList({ page_size: 100, is_active: true })
      .then((res) => setWarehouses(res.results.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => {});
  }, [companyId]);

  /* suppliers */
  const { data: suppliers = [] } = useAllSuppliersQuery(Boolean(companyId));

  /* products for search */
  const {
    data: productPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: productsLoading,
  } = useInfiniteQuery({
    queryKey: ['products', 'paper-scanner', companyId, productSearchDebounced] as const,
    queryFn: ({ pageParam }) =>
      productService.fetchList({
        page: pageParam as number,
        page_size: PAGE_SIZE,
        search: productSearchDebounced.trim() || undefined,
        is_active: true,
        ordering: 'name',
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => pageFromDrfNext(last.next),
    enabled: Boolean(companyId) && showProductSearch,
  });

  const searchProducts = useMemo(
    () => productPages?.pages.flatMap((p) => p.results) ?? [],
    [productPages],
  );

  /* sentinel for product search infinite scroll */
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '100px' },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  /* close dropdowns on outside click */
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowProductSearch(false);
      }
      if (supplierRef.current && !supplierRef.current.contains(e.target as Node)) {
        setSupplierOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  /* ── image selection ─────────────────────────────────────────── */
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreviewUrl(URL.createObjectURL(file));
    setScanError(null);
    setFormVisible(true);
    // Reset extracted fields when a new image is picked
    setInvoiceNumber('');
    setSellerName('');
    setSellerNip('');
    setIssueDate(todayIso);
    setRawLines([]);
  };

  /* ── OCR scan ────────────────────────────────────────────────── */
  const onScan = async () => {
    if (!imageFile) return;
    setScanError(null);
    try {
      const result = await scanMutation.mutateAsync(imageFile);
      if (result.invoice_number) setInvoiceNumber(result.invoice_number);
      if (result.seller_name) setSellerName(result.seller_name);
      if (result.seller_nip) setSellerNip(result.seller_nip);
      if (result.issue_date) setIssueDate(result.issue_date);
      if (result.invoice_number) setNotes(`Faktura papierowa: ${result.invoice_number}`);
      if (result.seller_name) setSupplierSearch(result.seller_name);
      // Pre-fill raw OCR lines (unmatched yet)
      if (result.lines?.length) {
        setRawLines(result.lines.map((l, i) => ({ ...l, id: i })));
      }
    } catch {
      setScanError('Nie udało się przetworzyć obrazu. Wypełnij pola ręcznie.');
    }
  };

  /* ── line management ─────────────────────────────────────────── */
  const addProduct = (product: Product, quantity = '1', unitCost = '') => {
    setLines((prev) => {
      if (prev.some((l) => l.product.id === product.id)) return prev;
      return [...prev, { product, quantity, unit_cost: unitCost }];
    });
    setProductSearch('');
    setShowProductSearch(false);
  };

  const assignRawLine = (product: Product, quantity: string, unitPrice: string, rawId: number) => {
    addProduct(product, quantity, unitPrice);
    setRawLines((prev) => prev.filter((r) => r.id !== rawId));
  };

  const dismissRawLine = (rawId: number) => {
    setRawLines((prev) => prev.filter((r) => r.id !== rawId));
  };

  const removeLine = (productId: string) => {
    setLines((prev) => prev.filter((l) => l.product.id !== productId));
  };

  const updateLine = (productId: string, field: 'quantity' | 'unit_cost', value: string) => {
    setLines((prev) =>
      prev.map((l) => (l.product.id === productId ? { ...l, [field]: value } : l)),
    );
  };

  /* ── PZ submit ───────────────────────────────────────────────── */
  const onSubmit = async () => {
    setSubmitError(null);
    if (!toWarehouseId) {
      setSubmitError('Wybierz magazyn docelowy.');
      return;
    }
    if (lines.length === 0) {
      setSubmitError('Dodaj co najmniej jeden produkt.');
      return;
    }
    const invalidQty = lines.find((l) => {
      const q = parseFloat(l.quantity);
      return !Number.isFinite(q) || q <= 0;
    });
    if (invalidQty) {
      setSubmitError(`Nieprawidłowa ilość dla: ${invalidQty.product.name}`);
      return;
    }

    try {
      const doc = await createPz.mutateAsync({
        to_warehouse_id: toWarehouseId,
        from_supplier_id: fromSupplierId || null,
        issue_date: issueDate,
        notes: notes.trim() || undefined,
        items: lines.map((l) => ({
          product_id: l.product.id,
          quantity_planned: parseFloat(l.quantity).toFixed(2),
          unit_cost: l.unit_cost ? parseFloat(l.unit_cost).toFixed(4) : undefined,
        })),
      });
      navigate(`/delivery/${doc.id}`);
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === 'object' && e !== null && 'detail' in e
            ? String((e as { detail: unknown }).detail)
            : 'Nie udało się utworzyć PZ.';
      setSubmitError(msg);
    }
  };

  /* ── render ──────────────────────────────────────────────────── */
  return (
    <div className="min-h-screen bg-background pb-32">
      {/* header */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-4 pb-3 pt-10">
          <div className="flex items-center gap-3">
            <motion.button
              whileTap={{ scale: 0.92 }}
              type="button"
              onClick={() => navigate(-1)}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              aria-label="Wróć"
            >
              <ChevronLeftIcon />
            </motion.button>
            <div>
              <h1 className="text-lg font-semibold text-foreground">Skanuj fakturę papierową</h1>
              <p className="text-[13px] text-muted-foreground">Zrób zdjęcie lub wgraj plik — pola zostaną wypełnione automatycznie</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-5">
        {/* ── image upload ────────────────────────────────────────── */}
        <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Zdjęcie faktury</h2>

          {imagePreviewUrl ? (
            <div className="space-y-3">
              <img
                src={imagePreviewUrl}
                alt="Podgląd faktury"
                className="max-h-64 w-full rounded-xl object-contain border border-border bg-muted"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-1 rounded-xl border border-border bg-secondary px-4 py-2 text-sm font-medium text-foreground hover:bg-muted"
                >
                  Zmień zdjęcie
                </button>
                <button
                  type="button"
                  onClick={() => void onScan()}
                  disabled={scanMutation.isPending}
                  className="flex-1 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {scanMutation.isPending ? 'Skanuję…' : 'Odczytaj dane (OCR)'}
                </button>
              </div>
              {scanError && (
                <p className="text-[13px] text-amber-600">{scanError}</p>
              )}
              {scanMutation.isSuccess && (
                <p className="text-[13px] text-green-600">Dane odczytane — sprawdź i uzupełnij poniżej.</p>
              )}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border bg-muted/30 px-6 py-10 text-muted-foreground transition hover:border-primary/50 hover:bg-primary/5"
            >
              <UploadIcon />
              <span className="text-sm font-medium">Kliknij, aby wybrać zdjęcie lub plik PDF</span>
              <span className="text-xs">JPG, PNG, WEBP, PDF</span>
              <span className="mt-1 flex items-center gap-1.5 text-xs text-primary">
                <CameraIcon />
                Na telefonie: aparat uruchomi się automatycznie
              </span>
            </button>
          )}

          {/* hidden file input — no capture so user can choose camera or gallery */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={onFileChange}
            aria-label="Wybierz zdjęcie faktury"
          />
        </section>

        {/* ── extracted header fields ──────────────────────────────── */}
        {formVisible && (
          <>
            {submitError && (
              <p
                className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                {submitError}
              </p>
            )}

            <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
              <h2 className="mb-4 text-[15px] font-semibold text-foreground">Dane dokumentu</h2>

              <div className="space-y-4">
                {/* warehouse */}
                <div>
                  <label htmlFor="to_warehouse" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    Magazyn docelowy <span className="text-destructive">*</span>
                  </label>
                  <select
                    id="to_warehouse"
                    value={toWarehouseId}
                    onChange={(e) => setToWarehouseId(e.target.value)}
                    className={cn(
                      'h-10 w-full rounded-xl border bg-secondary px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30',
                      !toWarehouseId ? 'border-destructive/40' : 'border-border',
                    )}
                  >
                    <option value="">— wybierz magazyn —</option>
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                </div>

                {/* supplier combobox */}
                <div>
                  <label className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    Dostawca
                  </label>
                  <div ref={supplierRef} className="relative">
                    {fromSupplierId ? (
                      // Selected state — show name + clear button
                      <div className="flex h-10 items-center justify-between rounded-xl border border-border bg-secondary px-3">
                        <span className="text-sm text-foreground">
                          {suppliers.find((s) => s.id === fromSupplierId)?.name ?? supplierSearch}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setFromSupplierId(''); setSupplierSearch(''); }}
                          className="text-xs text-muted-foreground hover:text-destructive"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <input
                        type="text"
                        placeholder="Szukaj lub utwórz dostawcę…"
                        value={supplierSearch}
                        onChange={(e) => { setSupplierSearch(e.target.value); setSupplierOpen(true); }}
                        onFocus={() => setSupplierOpen(true)}
                        className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    )}
                    {supplierOpen && !fromSupplierId && (
                      <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-card shadow-lg">
                        <button
                          type="button"
                          onClick={() => { setFromSupplierId(''); setSupplierOpen(false); setSupplierSearch(''); }}
                          className="flex w-full items-center px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
                        >
                          — brak / nieznany —
                        </button>
                        {suppliers
                          .filter((s) => s.name.toLowerCase().includes(supplierSearch.toLowerCase()))
                          .map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              onClick={() => { setFromSupplierId(s.id); setSupplierSearch(s.name); setSupplierOpen(false); }}
                              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <span>{s.name}</span>
                              <CheckIcon />
                            </button>
                          ))}
                        {/* Create new supplier */}
                        {supplierSearch.trim() && (
                          <button
                            type="button"
                            disabled={supplierCreating}
                            onClick={async () => {
                              setSupplierCreating(true);
                              try {
                                const newS = await supplierService.createItem({
                                  name: supplierSearch.trim(),
                                  nip: sellerNip || undefined,
                                });
                                setFromSupplierId(newS.id);
                                setSupplierSearch(newS.name);
                                setSupplierOpen(false);
                              } catch {
                                // ignore
                              } finally {
                                setSupplierCreating(false);
                              }
                            }}
                            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-medium text-primary hover:bg-primary/5 disabled:opacity-60"
                          >
                            <span className="text-lg leading-none">+</span>
                            {supplierCreating ? 'Tworzę…' : `Utwórz: „${supplierSearch.trim()}"`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* issue date */}
                <div>
                  <label htmlFor="issue_date" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    Data wystawienia
                  </label>
                  <input
                    id="issue_date"
                    type="date"
                    value={issueDate}
                    onChange={(e) => setIssueDate(e.target.value)}
                    className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                {/* invoice number (from OCR, editable) */}
                <div>
                  <label htmlFor="invoice_number" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    Numer faktury
                  </label>
                  <input
                    id="invoice_number"
                    type="text"
                    value={invoiceNumber}
                    onChange={(e) => setInvoiceNumber(e.target.value)}
                    placeholder="np. FV/2026/001"
                    className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                {/* seller NIP (from OCR, editable) */}
                <div>
                  <label htmlFor="seller_nip" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    NIP dostawcy
                  </label>
                  <input
                    id="seller_nip"
                    type="text"
                    value={sellerNip}
                    onChange={(e) => setSellerNip(e.target.value)}
                    placeholder="10 cyfr"
                    className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                {/* seller name (from OCR, editable) */}
                <div>
                  <label htmlFor="seller_name" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    Nazwa dostawcy
                  </label>
                  <input
                    id="seller_name"
                    type="text"
                    value={sellerName}
                    onChange={(e) => setSellerName(e.target.value)}
                    placeholder="np. Firma ABC Sp. z o.o."
                    className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>

                {/* notes */}
                <div>
                  <label htmlFor="notes" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                    Notatki
                  </label>
                  <input
                    id="notes"
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Opcjonalnie"
                    className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  />
                </div>
              </div>
            </section>

            {/* ── raw OCR lines ────────────────────────────────────── */}
            {rawLines.length > 0 && (
              <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
                <h2 className="mb-1 text-[15px] font-semibold text-foreground">Pozycje z paragonu</h2>
                <p className="mb-4 text-[12px] text-muted-foreground">
                  Wyszukaj każdą pozycję w bazie produktów. Ilość i cena są wstępnie wypełnione z OCR.
                </p>
                <div className="space-y-3">
                  {rawLines.map((raw) => (
                    <RawLineRow
                      key={raw.id}
                      line={raw}
                      companyId={companyId}
                      onAssign={(product, qty, price) => assignRawLine(product, qty, price, raw.id)}
                      onDismiss={dismissRawLine}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* ── line items ───────────────────────────────────────── */}
            <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
              <h2 className="mb-4 text-[15px] font-semibold text-foreground">Pozycje</h2>

              {/* product search */}
              <div ref={searchRef} className="relative mb-4">
                <input
                  type="text"
                  placeholder="Szukaj i dodaj produkt…"
                  value={productSearch}
                  onChange={(e) => {
                    setProductSearch(e.target.value);
                    setShowProductSearch(true);
                  }}
                  onFocus={() => setShowProductSearch(true)}
                  className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                  aria-label="Szukaj produktu"
                />
                {showProductSearch && (
                  <div
                    ref={scrollAreaRef}
                    className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-card shadow-lg"
                  >
                    {productsLoading && (
                      <p className="px-3 py-2 text-sm text-muted-foreground">Ładowanie…</p>
                    )}
                    {!productsLoading && searchProducts.length === 0 && (
                      <p className="px-3 py-2 text-sm text-muted-foreground">Brak wyników</p>
                    )}
                    {searchProducts.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => addProduct(product)}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                      >
                        <span>{product.name}</span>
                        <span className="text-xs text-muted-foreground">{product.unit}</span>
                      </button>
                    ))}
                    <div ref={sentinelRef} className="h-1" />
                  </div>
                )}
              </div>

              {/* lines table */}
              {lines.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="pb-2 text-left font-medium">Produkt</th>
                        <th className="pb-2 pr-2 text-right font-medium">Ilość</th>
                        <th className="pb-2 pr-2 text-right font-medium">Cena jedn.</th>
                        <th className="pb-2 pr-2 text-right font-medium">Razem</th>
                        <th className="pb-2" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {lines.map((line) => {
                        const qty = parseFloat(line.quantity) || 0;
                        const cost = parseFloat(line.unit_cost) || 0;
                        const lineTotal = qty * cost;
                        return (
                          <tr key={line.product.id}>
                            <td className="py-2 pr-2">
                              <span className="font-medium text-foreground">{line.product.name}</span>
                              <span className="ml-1 text-xs text-muted-foreground">{line.product.unit}</span>
                            </td>
                            <td className="py-2 pr-2">
                              <input
                                type="number"
                                min="0.001"
                                step="0.001"
                                value={line.quantity}
                                onChange={(e) => updateLine(line.product.id, 'quantity', e.target.value)}
                                className="w-20 rounded-lg border border-border bg-secondary px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                aria-label={`Ilość ${line.product.name}`}
                              />
                            </td>
                            <td className="py-2 pr-2">
                              <input
                                type="number"
                                min="0"
                                step="0.01"
                                value={line.unit_cost}
                                onChange={(e) => updateLine(line.product.id, 'unit_cost', e.target.value)}
                                placeholder="—"
                                className="w-24 rounded-lg border border-border bg-secondary px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                                aria-label={`Cena jedn. ${line.product.name}`}
                              />
                            </td>
                            <td className="py-2 pr-2 text-right text-sm tabular-nums text-foreground">
                              {lineTotal > 0 ? lineTotal.toFixed(2) : '—'}
                            </td>
                            <td className="py-2">
                              <button
                                type="button"
                                onClick={() => removeLine(line.product.id)}
                                className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                aria-label={`Usuń ${line.product.name}`}
                              >
                                <TrashIcon />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-border">
                        <td colSpan={3} className="pt-2 text-right text-[13px] font-semibold text-foreground">
                          Suma:
                        </td>
                        <td className="pt-2 pr-2 text-right text-[13px] font-semibold tabular-nums text-foreground">
                          {lines.reduce((sum, l) => {
                            const qty = parseFloat(l.quantity) || 0;
                            const cost = parseFloat(l.unit_cost) || 0;
                            return sum + qty * cost;
                          }, 0).toFixed(2)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ) : (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  Użyj pola powyżej, aby dodać produkty z faktury.
                </p>
              )}
            </section>

            {/* ── submit ───────────────────────────────────────────── */}
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => navigate(-1)}
                className="flex-1 rounded-xl border border-border bg-secondary px-4 py-3 text-sm font-medium text-foreground hover:bg-muted"
              >
                Anuluj
              </button>
              <button
                type="button"
                onClick={() => void onSubmit()}
                disabled={createPz.isPending || lines.length === 0 || !toWarehouseId}
                className="flex-1 rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground shadow-sm disabled:opacity-60"
              >
                {createPz.isPending ? 'Tworzę PZ…' : 'Utwórz PZ'}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
