import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import { useCreatePzMutation } from '@/query/use-delivery';
import { useAllSuppliersQuery } from '@/query/use-suppliers';
import { useKsefInboxParseQuery } from '@/query/use-invoices';
import { ksefService } from '@/services/ksef.service';
import { productService } from '@/services/product.service';
import { supplierService } from '@/services/supplier.service';
import { warehouseService } from '@/services/warehouse.service';
import type { Product } from '@/types';
import type { ParsedInvoiceLine } from '@/services/ksef.service';

const VAT_RATES = ['0', '5', '8', '23', 'zw', 'np'];
const PAGE_SIZE = 30;
const DEBOUNCE_MS = 300;

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

interface PzLine {
  /** Index into the original parsed.lines array — groups splits of the same invoice line */
  ksefLineIdx: number;
  ksefLine: ParsedInvoiceLine;
  product: Product | null;
  quantity: string;
  unit_cost: string;
  warehouseId: string;
  productSearch: string;
  showSearch: boolean;
  quickCreate: boolean;
}

/* ── icons ─────────────────────────────────────────────────────────── */

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

function SplitIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M8 21H3v-5M16 21h5v-5M3 21l7-7M21 21l-7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const plMoney = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plQty = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 3 });

/* ── QuickCreateProduct ─────────────────────────────────────────────── */

function QuickCreateProduct({
  defaultName,
  defaultUnit,
  defaultVatRate,
  onCreated,
  onCancel,
}: {
  defaultName: string;
  defaultUnit: string;
  defaultVatRate: string;
  onCreated: (product: Product) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [unit, setUnit] = useState(defaultUnit || 'szt.');
  const [vatRate, setVatRate] = useState(() => {
    const num = parseFloat(defaultVatRate);
    return VAT_RATES.includes(defaultVatRate) ? defaultVatRate : Number.isFinite(num) ? String(num) : '23';
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!name.trim()) { setError('Podaj nazwę produktu.'); return; }
    setSaving(true);
    setError(null);
    try {
      const product = await productService.createItem({
        name: name.trim(),
        unit: unit.trim() || 'szt.',
        vat_rate: parseFloat(vatRate) || 23,
        price_net: 0,
        price_gross: 0,
        description: null,
        sku: null,
        barcode: null,
        pkwiu: '',
        track_batches: false,
        min_stock_alert: 0,
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
      onCreated(product);
    } catch {
      setError('Nie udało się utworzyć produktu.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
      <p className="text-[12px] font-semibold uppercase tracking-wide text-primary">Nowy produkt</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="space-y-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Nazwa produktu"
          className="h-8 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <div className="grid grid-cols-2 gap-2">
          <input
            type="text"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="Jednostka"
            className="h-8 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <select
            value={vatRate}
            onChange={(e) => setVatRate(e.target.value)}
            className="h-8 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            {VAT_RATES.map((r) => (
              <option key={r} value={r}>{r === 'zw' ? 'zw.' : r === 'np' ? 'np.' : `${r}%`}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleSave()}
          className="h-8 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {saving ? 'Tworzenie…' : 'Utwórz'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-lg border border-border px-4 text-sm text-muted-foreground hover:bg-muted"
        >
          Anuluj
        </button>
      </div>
    </div>
  );
}

/* ── ProductSearchField ─────────────────────────────────────────────── */

function ProductSearchField({
  lineIndex,
  currentProduct,
  search,
  showSearch,
  companyId,
  onSearchChange,
  onShowChange,
  onSelect,
}: {
  lineIndex: number;
  currentProduct: Product | null;
  search: string;
  showSearch: boolean;
  companyId: string;
  onSearchChange: (val: string) => void;
  onShowChange: (val: boolean) => void;
  onSelect: (product: Product | null) => void;
}) {
  const searchDebounced = useDebouncedValue(search, DEBOUNCE_MS);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: productPages, isPending } = useInfiniteQuery({
    queryKey: ['products', 'ksef-pz', companyId, searchDebounced, lineIndex] as const,
    queryFn: ({ pageParam }) =>
      productService.fetchList({
        page: pageParam as number,
        page_size: PAGE_SIZE,
        search: searchDebounced.trim() || undefined,
        is_active: true,
        ordering: 'name',
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => pageFromDrfNext(last.next),
    enabled: Boolean(companyId) && showSearch,
  });

  const products = useMemo(
    () => productPages?.pages.flatMap((p) => p.results) ?? [],
    [productPages],
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onShowChange(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onShowChange]);

  return (
    <div ref={containerRef} className="relative">
      <input
        type="search"
        placeholder={currentProduct ? currentProduct.name : '— wybierz produkt —'}
        value={currentProduct ? currentProduct.name : search}
        onChange={(e) => {
          onSearchChange(e.target.value);
          onShowChange(true);
          if (currentProduct) onSelect(null);
        }}
        onFocus={() => onShowChange(true)}
        className={cn(
          'h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30',
          currentProduct ? 'border-primary/50' : 'border-border',
        )}
        aria-label="Wyszukaj produkt"
      />
      {showSearch && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-auto rounded-xl border border-border bg-card shadow-lg">
          <button
            type="button"
            onClick={() => { onSelect(null); onShowChange(false); onSearchChange(''); }}
            className="flex w-full items-center px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted"
          >
            — bez przypisania —
          </button>
          {isPending && <p className="px-3 py-2 text-sm text-muted-foreground">Ładowanie…</p>}
          {!isPending && products.length === 0 && (
            <p className="px-3 py-2 text-sm text-muted-foreground">Brak wyników</p>
          )}
          {products.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => { onSelect(p); onShowChange(false); onSearchChange(''); }}
              className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-muted"
            >
              <span className="font-medium text-foreground">{p.name}</span>
              <span className="text-xs text-muted-foreground">{p.unit || 'szt.'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────── */

export function KSeFInboxPZPage() {
  const { ksefNumber } = useParams<{ ksefNumber: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const companyId = user?.current_company ?? '';
  const createPz = useCreatePzMutation();

  const { data: parsed, isPending: parsePending, isError: parseError } = useKsefInboxParseQuery(
    ksefNumber ?? '',
    Boolean(ksefNumber),
  );

  const todayIso = new Date().toISOString().slice(0, 10);
  const [issueDate, setIssueDate] = useState(todayIso);
  const [notes, setNotes] = useState('');
  const [defaultWarehouseId, setDefaultWarehouseId] = useState('');
  const [fromSupplierId, setFromSupplierId] = useState('');
  const [lines, setLines] = useState<PzLine[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [warehouses, setWarehouses] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!companyId) return;
    warehouseService
      .fetchList({ page_size: 100, is_active: true })
      .then((res) => setWarehouses(res.results.map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => {});
  }, [companyId]);

  const { data: suppliers = [] } = useAllSuppliersQuery(Boolean(companyId));

  // When parsed invoice data arrives, initialise form state
  useEffect(() => {
    if (!parsed || lines !== null) return;

    if (parsed.suggested_supplier_id) setFromSupplierId(parsed.suggested_supplier_id);
    if (parsed.issue_date) setIssueDate(parsed.issue_date.slice(0, 10));
    if (parsed.invoice_number) setNotes(`KSeF: ${parsed.invoice_number}`);

    const buildLines = async () => {
      const resolvedLines: PzLine[] = await Promise.all(
        parsed.lines.map(async (kl, idx) => {
          let product: Product | null = null;
          if (kl.suggested_product_id) {
            try { product = await productService.fetchById(kl.suggested_product_id); }
            catch { product = null; }
          }
          return {
            ksefLineIdx: idx,
            ksefLine: kl,
            product,
            quantity: String(kl.quantity),
            unit_cost: kl.unit_net_price ? String(kl.unit_net_price) : '',
            warehouseId: '',
            productSearch: '',
            showSearch: false,
            quickCreate: false,
          };
        }),
      );
      setLines(resolvedLines);
    };

    void buildLines();
  }, [parsed, lines]);

  // When user changes the default warehouse, pre-fill all lines that have no warehouse yet
  const handleDefaultWarehouseChange = (whId: string) => {
    setDefaultWarehouseId(whId);
    if (whId) {
      setLines((prev) =>
        prev ? prev.map((l) => (l.warehouseId ? l : { ...l, warehouseId: whId })) : prev,
      );
    }
  };

  const updateLine = (idx: number, patch: Partial<PzLine>) => {
    setLines((prev) => prev ? prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)) : prev);
  };

  const removeLine = (idx: number) => {
    setLines((prev) => prev ? prev.filter((_, i) => i !== idx) : prev);
  };

  /** Split a line: insert a new entry after idx with remaining qty from invoice */
  const splitLine = (idx: number) => {
    setLines((prev) => {
      if (!prev) return prev;
      const line = prev[idx];
      // Compute already-assigned qty for this ksefLineIdx
      const invoiceQty = line.ksefLine.quantity;
      const assigned = prev
        .filter((l) => l.ksefLineIdx === line.ksefLineIdx)
        .reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0);
      const remaining = Math.max(0, invoiceQty - assigned);

      const newLine: PzLine = {
        ...line,
        quantity: remaining > 0 ? String(remaining) : '0',
        warehouseId: line.warehouseId || defaultWarehouseId,
        productSearch: '',
        showSearch: false,
        quickCreate: false,
      };
      const next = [...prev];
      next.splice(idx + 1, 0, newLine);
      return next;
    });
  };

  const mappedLines = lines?.filter((l) => l.product !== null) ?? [];

  /** Compute accepted qty vs. invoice qty for a given ksefLineIdx */
  const acceptedQtyFor = (ksefLineIdx: number): number =>
    (lines ?? [])
      .filter((l) => l.ksefLineIdx === ksefLineIdx && l.product !== null)
      .reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0);

  const onSubmit = async () => {
    setSubmitError(null);
    if (mappedLines.length === 0) {
      setSubmitError('Co najmniej jedna pozycja musi mieć przypisany produkt.');
      return;
    }
    const noWarehouse = mappedLines.find((l) => !l.warehouseId);
    if (noWarehouse) {
      setSubmitError(`Wybierz magazyn dla: ${noWarehouse.product?.name}`);
      return;
    }
    const badQty = mappedLines.find((l) => {
      const q = parseFloat(l.quantity);
      return !Number.isFinite(q) || q <= 0;
    });
    if (badQty) { setSubmitError(`Nieprawidłowa ilość dla: ${badQty.product?.name}`); return; }

    // Sync supplier: create if missing, patch if exists — using all data from the invoice
    let resolvedSupplierId = fromSupplierId || null;
    if (parsed?.seller_name || parsed?.seller_nip) {
      const sellerData = {
        name: parsed!.seller_name,
        nip: parsed!.seller_nip,
        street: parsed!.seller_address_l1 || undefined,
        city: parsed!.seller_address_l2 || undefined,
        country: parsed!.seller_country || 'Polska',
      };
      try {
        if (resolvedSupplierId) {
          // Update existing supplier with latest invoice data
          await supplierService.patchItem(resolvedSupplierId, sellerData);
        } else {
          // Create new supplier
          const newSupplier = await supplierService.createItem(sellerData);
          resolvedSupplierId = newSupplier.id;
          setFromSupplierId(newSupplier.id);
        }
      } catch {
        // Non-fatal — proceed without supplier sync
      }
    }

    // Group by warehouseId — create one PZ per warehouse
    const byWarehouse = new Map<string, PzLine[]>();
    for (const l of mappedLines) {
      const group = byWarehouse.get(l.warehouseId) ?? [];
      group.push(l);
      byWarehouse.set(l.warehouseId, group);
    }

    try {
      const docs = await Promise.all(
        [...byWarehouse.entries()].map(([whId, whLines]) =>
          createPz.mutateAsync({
            to_warehouse_id: whId,
            from_supplier_id: resolvedSupplierId,
            issue_date: issueDate,
            notes: notes.trim() || undefined,
            ksef_number: ksefNumber,
            items: whLines.map((l) => ({
              product_id: l.product!.id,
              quantity_planned: parseFloat(l.quantity).toFixed(2),
              unit_cost: l.unit_cost ? parseFloat(l.unit_cost).toFixed(4) : undefined,
              ksef_line_position: l.ksefLineIdx,
            })),
          }),
        ),
      );

      // Save product mappings for future imports from this seller
      if (parsed?.seller_nip) {
        const mappingsToSave = mappedLines
          .filter((l) => l.product !== null)
          .map((l) => ({ invoice_line_name: l.ksefLine.name, product_id: l.product!.id }));
        if (mappingsToSave.length > 0) {
          ksefService.saveProductMappings(parsed.seller_nip, mappingsToSave).catch(() => {});
        }
      }

      // Navigate to first created PZ
      navigate(`/delivery/${docs[0].id}`);
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

  /* ── loading / error states ── */

  if (parsePending) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Pobieranie faktury z KSeF…
      </div>
    );
  }

  if (parseError || !parsed) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">Nie udało się pobrać lub przetworzyć faktury KSeF.</p>
        <button type="button" onClick={() => navigate(-1)} className="mt-3 text-sm underline">Wróć</button>
      </div>
    );
  }

  const unmappedCount = (lines?.filter((l) => l.product === null) ?? []).length;
  const warehouseCount = new Set(mappedLines.map((l) => l.warehouseId).filter(Boolean)).size;

  /* ── unique ksefLineIdx values (for group headers) ── */
  const ksefLineIndices = lines
    ? [...new Set(lines.map((l) => l.ksefLineIdx))]
    : [];

  return (
    <div className="min-h-screen bg-background pb-32">
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
              <h1 className="text-lg font-semibold text-foreground">Nowe PZ z KSeF</h1>
              <p className="text-[13px] text-muted-foreground">
                {parsed.invoice_number || ksefNumber}
                {parsed.seller_name && ` · ${parsed.seller_name}`}
              </p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-5">
        {submitError && (
          <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
            {submitError}
          </p>
        )}

        {(parsed.pz_documents ?? []).filter((p) => p.status !== 'cancelled').length > 0 && (
          <div className="rounded-xl border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
            <p className="font-semibold mb-1">Ta faktura ma już dokument PZ</p>
            <div className="flex flex-wrap gap-2">
              {parsed.pz_documents.filter((p) => p.status !== 'cancelled').map((pz) => (
                <a
                  key={pz.id}
                  href={`/delivery/${pz.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center rounded px-2 py-0.5 font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 hover:underline"
                >
                  {pz.documentNumber}
                </a>
              ))}
            </div>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Upewnij się, że nie duplikujesz pozycji.</p>
          </div>
        )}

        {/* Invoice header */}
        <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
          <h2 className="mb-3 text-[15px] font-semibold text-foreground">Faktura KSeF</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Nr faktury</dt>
            <dd className="font-medium">{parsed.invoice_number || '—'}</dd>
            <dt className="text-muted-foreground">Data wystawienia</dt>
            <dd>{parsed.issue_date || '—'}</dd>
            <dt className="text-muted-foreground">Wystawca</dt>
            <dd>
              {parsed.seller_name || '—'}
              {parsed.seller_nip && <span className="ml-1 text-xs text-muted-foreground">({parsed.seller_nip})</span>}
            </dd>
          </dl>
        </section>

        {/* Document fields */}
        <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
          <h2 className="mb-4 text-[15px] font-semibold text-foreground">Dane dokumentu PZ</h2>
          <div className="space-y-4">
            {/* Default warehouse — pre-fills all lines */}
            <div>
              <label htmlFor="default_warehouse" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                Magazyn domyślny
                <span className="ml-1 font-normal text-muted-foreground/70">(uzupełni wszystkie pozycje)</span>
              </label>
              <select
                id="default_warehouse"
                value={defaultWarehouseId}
                onChange={(e) => handleDefaultWarehouseChange(e.target.value)}
                className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">— wybierz —</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            </div>

            <div>
              <p className="mb-1.5 text-[13px] font-medium text-muted-foreground">Dostawca</p>

              {parsed.seller_name || parsed.seller_nip ? (
                <div className="rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-sm space-y-0.5">
                  {parsed.seller_name && (
                    <p className="font-semibold text-foreground">{parsed.seller_name}</p>
                  )}
                  {parsed.seller_nip && (
                    <p className="text-xs text-muted-foreground">NIP: {parsed.seller_nip}</p>
                  )}
                  {parsed.seller_address_l1 && (
                    <p className="text-xs text-muted-foreground">{parsed.seller_address_l1}</p>
                  )}
                  {parsed.seller_address_l2 && (
                    <p className="text-xs text-muted-foreground">{parsed.seller_address_l2}</p>
                  )}
                  {parsed.seller_country && parsed.seller_country !== 'PL' && (
                    <p className="text-xs text-muted-foreground">{parsed.seller_country}</p>
                  )}

                  <div className="pt-1 border-t border-border/50 mt-1">
                    {fromSupplierId ? (
                      <p className="text-xs text-green-600 dark:text-green-400">
                        ✓ Dostawca istnieje w systemie — dane zostaną zaktualizowane.
                      </p>
                    ) : (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        Brak dostawcy z tym NIP — zostanie automatycznie dodany przy tworzeniu PZ.
                      </p>
                    )}
                  </div>
                </div>
              ) : (
                /* No seller info in invoice — show manual dropdown */
                <select
                  id="from_supplier"
                  value={fromSupplierId}
                  onChange={(e) => setFromSupplierId(e.target.value)}
                  className="h-10 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">— brak / nieznany —</option>
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
            </div>

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

            <div>
              <label htmlFor="notes" className="mb-1.5 block text-[13px] font-medium text-muted-foreground">
                Uwagi
              </label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full resize-none rounded-xl border border-border bg-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
        </section>

        {/* Line items */}
        <section className="rounded-2xl bg-card p-5 shadow-[0_2px_12px_rgba(26,28,31,0.07)]">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-foreground">
              Pozycje faktury
            </h2>
            {warehouseCount > 1 && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                {warehouseCount} PZ
              </span>
            )}
          </div>
          {unmappedCount > 0 && (
            <p className="mb-3 text-xs text-amber-600 dark:text-amber-400">
              {unmappedCount} pozycj{unmappedCount === 1 ? 'a nie ma' : unmappedCount < 5 ? 'e nie mają' : ' nie ma'} przypisanego produktu i zostan{unmappedCount === 1 ? 'ie' : 'ą'} pominięt{unmappedCount === 1 ? 'a' : 'e'}.
            </p>
          )}

          {lines === null && (
            <p className="py-6 text-center text-sm text-muted-foreground">Ładowanie pozycji…</p>
          )}
          {lines !== null && lines.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">Brak pozycji w tej fakturze.</p>
          )}

          {lines !== null && lines.length > 0 && (
            <div className="space-y-5">
              {ksefLineIndices.map((ksefIdx) => {
                const groupLines = lines.filter((l) => l.ksefLineIdx === ksefIdx);
                const firstLine = groupLines[0];
                const invoiceQty = firstLine.ksefLine.quantity;
                const acceptedQty = acceptedQtyFor(ksefIdx);
                const isOver = acceptedQty > invoiceQty * 1.0001;
                const isPartial = acceptedQty > 0 && acceptedQty < invoiceQty - 0.0001;

                return (
                  <div key={ksefIdx}>
                    {/* Invoice line header */}
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-semibold text-foreground truncate">
                          {firstLine.ksefLine.name}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Faktura: {plQty.format(invoiceQty)} {firstLine.ksefLine.unit || 'szt.'}
                          {' · '}{plMoney.format(firstLine.ksefLine.unit_net_price)} zł/jm
                          {' · '}VAT {firstLine.ksefLine.vat_rate}%
                          {acceptedQty > 0 && (
                            <span className={cn(
                              'ml-2 font-medium',
                              isOver ? 'text-destructive' : isPartial ? 'text-amber-600 dark:text-amber-400' : 'text-green-600 dark:text-green-400',
                            )}>
                              Przyjęto: {plQty.format(acceptedQty)}
                              {isOver && ' ⚠ powyżej faktury'}
                              {isPartial && ' (częściowo)'}
                            </span>
                          )}
                        </p>
                        {(firstLine.ksefLine.existing_pz_documents ?? []).filter((p) => p.status !== 'cancelled').length > 0 && (
                          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400 flex flex-wrap items-center gap-1">
                            <span>Już w PZ:</span>
                            {firstLine.ksefLine.existing_pz_documents.filter((p) => p.status !== 'cancelled').map((pz) => (
                              <a
                                key={pz.id}
                                href={`/delivery/${pz.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center rounded px-1.5 py-0.5 font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 hover:underline whitespace-nowrap"
                              >
                                {pz.documentNumber}
                              </a>
                            ))}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Split rows */}
                    <div className="space-y-3 pl-1">
                      {groupLines.map((line) => {
                        const lineIdx = lines.indexOf(line);
                        return (
                          <div key={lineIdx} className="rounded-xl border border-border bg-secondary/30 p-3 space-y-3">
                            {/* Product selector */}
                            <div>
                              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                Produkt w magazynie
                              </label>
                              {line.quickCreate ? (
                                <QuickCreateProduct
                                  defaultName={line.ksefLine.name}
                                  defaultUnit={line.ksefLine.unit}
                                  defaultVatRate={line.ksefLine.vat_rate}
                                  onCreated={(p) => updateLine(lineIdx, { product: p, quickCreate: false })}
                                  onCancel={() => updateLine(lineIdx, { quickCreate: false })}
                                />
                              ) : (
                                <>
                                  <ProductSearchField
                                    lineIndex={lineIdx}
                                    currentProduct={line.product}
                                    search={line.productSearch}
                                    showSearch={line.showSearch}
                                    companyId={companyId}
                                    onSearchChange={(val) => updateLine(lineIdx, { productSearch: val })}
                                    onShowChange={(val) => updateLine(lineIdx, { showSearch: val })}
                                    onSelect={(p) => updateLine(lineIdx, { product: p })}
                                  />
                                  {!line.product && (
                                    <button
                                      type="button"
                                      onClick={() => updateLine(lineIdx, { quickCreate: true })}
                                      className="mt-1.5 text-xs text-primary hover:underline"
                                    >
                                      + Utwórz nowy produkt
                                    </button>
                                  )}
                                </>
                              )}
                            </div>

                            {/* Qty + unit cost + warehouse */}
                            {line.product && (
                              <div className="grid grid-cols-2 gap-3">
                                <div>
                                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Ilość
                                  </label>
                                  <input
                                    type="number"
                                    min="0.01"
                                    step="1"
                                    value={line.quantity}
                                    onChange={(e) => updateLine(lineIdx, { quantity: e.target.value })}
                                    className="h-9 w-full rounded-lg border border-border bg-background px-2 text-right text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/30"
                                  />
                                </div>
                                <div>
                                  <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                    Cena netto / jm
                                  </label>
                                  <input
                                    type="number"
                                    min="0"
                                    step="1"
                                    value={line.unit_cost}
                                    onChange={(e) => updateLine(lineIdx, { unit_cost: e.target.value })}
                                    placeholder="—"
                                    className={cn(
                                      'h-9 w-full rounded-lg border bg-background px-2 text-right text-sm tabular-nums placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30',
                                      line.unit_cost &&
                                      line.ksefLine.unit_net_price &&
                                      Math.abs(parseFloat(line.unit_cost) - line.ksefLine.unit_net_price) > 0.001
                                        ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-950/20'
                                        : 'border-border',
                                    )}
                                  />
                                  {line.unit_cost &&
                                    line.ksefLine.unit_net_price &&
                                    Math.abs(parseFloat(line.unit_cost) - line.ksefLine.unit_net_price) > 0.001 && (
                                      <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                                        Faktura: {plMoney.format(line.ksefLine.unit_net_price)} zł
                                      </p>
                                    )}
                                </div>
                              </div>
                            )}

                            {/* Warehouse per line */}
                            {line.product && (
                              <div>
                                <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                                  Magazyn
                                </label>
                                <select
                                  value={line.warehouseId}
                                  onChange={(e) => updateLine(lineIdx, { warehouseId: e.target.value })}
                                  className={cn(
                                    'h-9 w-full rounded-lg border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30',
                                    !line.warehouseId ? 'border-destructive/40' : 'border-border',
                                  )}
                                >
                                  <option value="">— wybierz magazyn —</option>
                                  {warehouses.map((w) => (
                                    <option key={w.id} value={w.id}>{w.name}</option>
                                  ))}
                                </select>
                              </div>
                            )}

                            {/* Actions row */}
                            <div className="flex items-center justify-between pt-0.5">
                              <button
                                type="button"
                                onClick={() => splitLine(lineIdx)}
                                title="Podziel na dwa wpisy (np. dwa magazyny)"
                                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                              >
                                <SplitIcon />
                                Podziel
                              </button>
                              {groupLines.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => removeLine(lineIdx)}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20"
                                  aria-label="Usuń wpis"
                                >
                                  <TrashIcon />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </main>

      <div
        className={cn(
          'fixed left-0 right-0 z-40 border-t border-border/60 bg-background/95 px-4 py-3 backdrop-blur-xl',
          'bottom-[calc(83px+env(safe-area-inset-bottom))] md:bottom-0',
        )}
      >
        <div className="mx-auto max-w-3xl">
          <motion.button
            whileTap={{ scale: 0.98 }}
            type="button"
            onClick={() => void onSubmit()}
            disabled={createPz.isPending || mappedLines.length === 0}
            className="w-full rounded-xl bg-primary py-3.5 text-[16px] font-semibold text-primary-foreground disabled:opacity-50"
          >
            {createPz.isPending
              ? 'Tworzenie PZ…'
              : warehouseCount > 1
                ? `Utwórz ${warehouseCount} PZ (${mappedLines.length} poz.)`
                : `Utwórz PZ (${mappedLines.length} poz.)`}
          </motion.button>
        </div>
      </div>
    </div>
  );
}
