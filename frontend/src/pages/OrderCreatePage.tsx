import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { NumPad } from '@/components/ui/NumPad';
import { useAuth } from '@/context/AuthContext';
import {
  lineTotalGross,
  lineTotalNet,
  parseDecimalInput,
  sumLines,
  toApiDecimalString,
  unitGrossFromNet,
} from '@/lib/order-form-math';
import { formatDeliveryDate } from '@/lib/order-utils';
import { cn } from '@/lib/utils';
import { useCreateOrderMutation, useConfirmOrderMutation, useOrdersByCustomerQuery } from '@/query/use-orders';
import { useOfflineOrderCreate, OfflineQueuedError } from '@/query/use-offline-mutations';
import { useCustomerQuery, useCustomerListQuery, useCustomerPricesQuery } from '@/query/use-customers';
import { authStorage } from '@/services/api';
import { productService } from '@/services/product.service';
import type { Product } from '@/types';
import type { OrderCreate, OrderItemWrite } from '@/types';
import type { Order, OrderItem } from '@/types/order.types';

const DEBOUNCE_MS = 300;
const PAGE_SIZE = 30;
const pln = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN' });

type SelectedCustomer = { id: string; name: string };

export type OrderDraftLine = {
  key: string;
  product: Product;
  quantity: string;
  unitPriceNet: string;
  discountPercent: string;
};

function formatGrossPln(n: number): string {
  return Number.isFinite(n) ? pln.format(n) : pln.format(0);
}

function grossPerUnit(product: Product): number {
  const net = parseDecimalInput(String(product.price_net));
  const vat = parseDecimalInput(String(product.vat_rate)) ?? 0;
  if (net == null) return 0;
  return unitGrossFromNet(net, vat);
}

function stockDisplay(product: Product): string | null {
  const s = product.stock_total;
  if (s == null) return null;
  const n = typeof s === 'string' ? parseFloat(s) : s;
  if (!Number.isFinite(n)) return null;
  return `Stan: ${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

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

/* ── Checkout view ───────────────────────────────────────────────── */

interface CheckoutViewProps {
  lines: OrderDraftLine[];
  setLines: React.Dispatch<React.SetStateAction<OrderDraftLine[]>>;
  customerName: string;
  onBack: () => void;
  onSubmit: () => Promise<void>;
  isPending: boolean;
  submitError: string | null;
}

function TrashIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckoutView({ lines, setLines, customerName, onBack, onSubmit, isPending, submitError }: CheckoutViewProps) {
  const getLineGross = (l: OrderDraftLine) => {
    const q = parseDecimalInput(l.quantity) ?? 0;
    const netU = parseDecimalInput(l.unitPriceNet);
    if (netU == null) return 0;
    const vat = parseDecimalInput(String(l.product.vat_rate)) ?? 0;
    const disc = parseDecimalInput(l.discountPercent) ?? 0;
    return lineTotalGross(q, netU, vat, disc);
  };

  const getLineGrossNoDiscount = (l: OrderDraftLine) => {
    const q = parseDecimalInput(l.quantity) ?? 0;
    const netU = parseDecimalInput(l.unitPriceNet);
    if (netU == null) return 0;
    const vat = parseDecimalInput(String(l.product.vat_rate)) ?? 0;
    return unitGrossFromNet(netU, vat) * q;
  };

  const total = lines.reduce((s, l) => s + getLineGross(l), 0);
  const subtotal = lines.reduce((s, l) => s + getLineGrossNoDiscount(l), 0);
  const totalDiscount = subtotal - total;

  const updateQty = (productId: string, delta: number) => {
    setLines((prev) =>
      prev
        .map((l) => {
          if (l.product.id !== productId) return l;
          const cur = parseDecimalInput(l.quantity) ?? 0;
          return { ...l, quantity: String(Math.max(0, cur + delta)) };
        })
        .filter((l) => (parseDecimalInput(l.quantity) ?? 0) > 0),
    );
  };

  const removeLine = (productId: string) => {
    setLines((prev) => prev.filter((l) => l.product.id !== productId));
  };

  const itemCount = lines.reduce((s, l) => s + (parseDecimalInput(l.quantity) ?? 0), 0);
  const countLabel = () => {
    const n = Math.round(itemCount);
    if (n === 1) return '1 pozycja';
    if (n >= 2 && n <= 4) return `${n} pozycje`;
    return `${n} pozycji`;
  };

  return (
    <div className="flex min-h-screen flex-col bg-background pb-[calc(83px+14rem+env(safe-area-inset-bottom))] md:pb-56">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-5 pb-4 pt-10">
          <div className="flex items-center gap-4">
            <motion.button
              whileTap={{ scale: 0.94 }}
              type="button"
              onClick={onBack}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              aria-label="Wróć do listy produktów"
            >
              <ChevronLeftIcon />
            </motion.button>
            <div>
              <h1 className="text-[17px] font-semibold text-foreground">
                {customerName ? `Zamówienie — ${customerName}` : 'Zamówienie'}
              </h1>
              <p className="mt-0.5 text-[13px] text-muted-foreground">{countLabel()}</p>
            </div>
          </div>
        </div>
      </header>

      {/* Cart items */}
      <section className="mx-auto w-full max-w-3xl space-y-3 px-5 py-4">
        {submitError && (
          <p className="rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {submitError}
          </p>
        )}

        {lines.map((line, index) => {
          const qty = parseDecimalInput(line.quantity) ?? 0;
          const unit = line.product.unit || 'szt.';
          const gross = grossPerUnit(line.product);
          const lineTotal = getLineGross(line);
          const lineTotalRaw = getLineGrossNoDiscount(line);
          const discPct = parseDecimalInput(line.discountPercent) ?? 0;
          const hasDiscount = discPct > 0;

          return (
            <motion.div
              key={line.product.id}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.04 }}
              className="rounded-2xl bg-card p-4 shadow-[0_2px_12px_rgba(26,28,31,0.07)]"
            >
              <div className="flex items-start gap-3">
                {/* Avatar */}
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-base font-semibold text-primary" aria-hidden>
                  {line.product.name.charAt(0).toUpperCase()}
                </div>

                {/* Name + price */}
                <div className="min-w-0 flex-1">
                  <h4 className="truncate text-[15px] font-medium text-foreground">{line.product.name}</h4>
                  <p className="text-[13px] text-muted-foreground">
                    {formatGrossPln(gross)} / {unit}
                  </p>
                  {hasDiscount && (
                    <p className="mt-0.5 text-[12px] text-primary">Rabat: {discPct}%</p>
                  )}
                </div>

                {/* Line total */}
                <div className="shrink-0 text-right">
                  <p className="text-[15px] font-semibold text-foreground">{formatGrossPln(lineTotal)}</p>
                  {hasDiscount && (
                    <p className="text-[12px] text-muted-foreground line-through">{formatGrossPln(lineTotalRaw)}</p>
                  )}
                </div>
              </div>

              {/* Qty controls + trash */}
              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3">
                <motion.button
                  whileTap={{ scale: 0.9 }}
                  type="button"
                  aria-label={`Usuń ${line.product.name}`}
                  onClick={() => removeLine(line.product.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-lg bg-destructive/10 text-destructive"
                >
                  <TrashIcon />
                </motion.button>

                <div className="flex items-center gap-3">
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    type="button"
                    aria-label="Zmniejsz ilość"
                    onClick={() => updateQty(line.product.id, -1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
                  >
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                      <path d="M5 12h14" strokeLinecap="round" />
                    </svg>
                  </motion.button>
                  <span className="min-w-[2rem] text-center text-[15px] font-semibold tabular-nums text-foreground">
                    {Number.isInteger(qty) ? qty : qty.toFixed(2)}
                  </span>
                  <motion.button
                    whileTap={{ scale: 0.9 }}
                    type="button"
                    aria-label="Zwiększ ilość"
                    onClick={() => updateQty(line.product.id, 1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground"
                  >
                    <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                    </svg>
                  </motion.button>
                </div>
              </div>
            </motion.div>
          );
        })}

        {lines.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">Koszyk jest pusty.</p>
        )}
      </section>

      {typeof document !== 'undefined'
        ? createPortal(
            <motion.div
              initial={{ y: 80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className={cn(
                'fixed z-40 left-0 right-0 pointer-events-none',
                'bottom-[calc(83px+0.75rem+env(safe-area-inset-bottom))]',
                'md:bottom-[max(0.75rem,env(safe-area-inset-bottom))]',
              )}
            >
              <div className="mx-auto w-full max-w-3xl px-4 pointer-events-auto">
                <div className="rounded-2xl bg-card p-5 shadow-[0_-4px_32px_rgba(0,0,0,0.10)]">
                  <div className="mb-4 space-y-2">
                    <div className="flex justify-between text-[14px]">
                      <span className="text-muted-foreground">Suma pozycji</span>
                      <span className="tabular-nums text-foreground">{formatGrossPln(subtotal)}</span>
                    </div>
                    {totalDiscount > 0.001 && (
                      <div className="flex justify-between text-[14px]">
                        <span className="text-primary">Rabaty</span>
                        <span className="tabular-nums text-primary">−{formatGrossPln(totalDiscount)}</span>
                      </div>
                    )}
                    <div className="flex items-baseline justify-between border-t border-border/60 pt-2">
                      <span className="text-[17px] font-semibold text-foreground">Do zapłaty</span>
                      <span className="text-[22px] font-bold tabular-nums text-foreground">{formatGrossPln(total)}</span>
                    </div>
                  </div>

                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    type="button"
                    onClick={() => void onSubmit()}
                    disabled={isPending || lines.length === 0}
                    className="w-full rounded-xl bg-primary py-4 text-[17px] font-semibold text-primary-foreground disabled:opacity-60"
                  >
                    {isPending ? 'Tworzenie…' : 'Utwórz zamówienie'}
                  </motion.button>
                </div>
              </div>
            </motion.div>,
            document.body,
          )
        : null}
    </div>
  );
}

function normalizeQty(raw: string): string {
  const n = parseDecimalInput(raw);
  if (n == null || n === 0) return '0';
  return raw.replace(',', '.').trim();
}

/* ── Icons ──────────────────────────────────────────────────────── */

function ChevronLeftIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function PlusIcon({ small }: { small?: boolean }) {
  const sz = small ? 'h-3.5 w-3.5' : 'h-[18px] w-[18px]';
  return (
    <svg className={sz} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function MinusIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
      <path d="M5 12h14" strokeLinecap="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Product card ────────────────────────────────────────────────── */

interface ProductCardProps {
  product: Product;
  quantity: number;
  customPriceNet?: string;
  onTap: () => void;
  onAdd: () => void;
  onRemove: () => void;
}

function ProductCard({ product, quantity, customPriceNet, onTap, onAdd, onRemove }: ProductCardProps) {
  const initial = product.name.trim().charAt(0).toUpperCase();
  const stock = stockDisplay(product);
  const unit = product.unit || 'szt.';

  return (
    <motion.div
      whileTap={{ scale: 0.99 }}
      className="flex cursor-pointer items-center gap-4 rounded-xl bg-card p-3.5 shadow-[0_2px_8px_rgba(26,28,31,0.06)]"
      onClick={onTap}
      role="button"
      tabIndex={0}
      aria-label={`Produkt ${product.name}, ${formatGrossPln(grossPerUnit(product))} / ${unit}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTap(); } }}
    >
      {/* Avatar */}
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-lg font-semibold text-primary" aria-hidden>
        {initial}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <h4 className="truncate text-[15px] font-medium text-foreground">{product.name}</h4>
        <p className="text-[13px] text-muted-foreground">
          {customPriceNet
            ? <>{formatGrossPln(unitGrossFromNet(parseDecimalInput(customPriceNet) ?? 0, parseDecimalInput(String(product.vat_rate)) ?? 0))} <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px] font-semibold text-primary">cena indyw.</span></>
            : <>{formatGrossPln(grossPerUnit(product))}</>
          } / {unit}
        </p>
        {stock && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{stock}</p>
        )}
      </div>

      {/* Quantity controls */}
      {quantity > 0 ? (
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <motion.button
            whileTap={{ scale: 0.88 }}
            type="button"
            aria-label={`Zmniejsz ilość ${product.name}`}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground"
          >
            <MinusIcon />
          </motion.button>
          <span className="min-w-[1.5rem] text-center text-[15px] font-semibold tabular-nums text-foreground">
            {quantity}
          </span>
          <motion.button
            whileTap={{ scale: 0.88 }}
            type="button"
            aria-label={`Zwiększ ilość ${product.name}`}
            onClick={(e) => { e.stopPropagation(); onAdd(); }}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground"
          >
            <PlusIcon small />
          </motion.button>
        </div>
      ) : (
        <motion.button
          whileTap={{ scale: 0.88 }}
          type="button"
          aria-label={`Dodaj ${product.name}`}
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <PlusIcon />
        </motion.button>
      )}
    </motion.div>
  );
}

/* ── Customer selector dropdown (compact, for manual change) ─────── */

interface CustomerDropdownProps {
  value: string;
  onChange: (v: string) => void;
  onSelect: (c: SelectedCustomer) => void;
  customers: SelectedCustomer[];
  loading: boolean;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  containerRef: React.RefObject<HTMLDivElement>;
}

function CustomerDropdown({ value, onChange, onSelect, customers, loading, open, onOpenChange, containerRef }: CustomerDropdownProps) {
  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        autoComplete="off"
        value={value}
        placeholder="Zmień klienta…"
        className="h-9 w-full rounded-xl border border-border bg-secondary px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
        onChange={(e) => { onChange(e.target.value); onOpenChange(true); }}
        onFocus={() => onOpenChange(true)}
        aria-label="Wyszukaj klienta"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-auto rounded-xl border border-border bg-card py-1 text-sm shadow-lg"
        >
          {loading && <li className="px-3 py-2 text-muted-foreground">Ładowanie…</li>}
          {!loading && customers.map((c) => (
            <li key={c.id} role="option">
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-muted"
                onClick={() => onSelect(c)}
              >
                {c.name}
              </button>
            </li>
          ))}
          {!loading && customers.length === 0 && (
            <li className="px-3 py-2 text-muted-foreground">Brak wyników</li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ── Previous order banner ───────────────────────────────────────── */

function PrevOrderBanner({ order, onUse, onDismiss }: { order: Order; onUse: () => void; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mb-4 rounded-2xl border border-primary/20 bg-primary/5">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">Poprzednie zamówienie</p>
            <p className="text-[12px] text-muted-foreground">
              {order.order_number} · {order.items.length} {order.items.length === 1 ? 'produkt' : 'produktów'}
            </p>
          </div>
          <svg
            className={cn('ml-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
            viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="flex shrink-0 gap-2">
          <motion.button
            whileTap={{ scale: 0.95 }}
            type="button"
            onClick={onUse}
            className="rounded-xl bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-foreground"
          >
            Użyj
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.95 }}
            type="button"
            onClick={onDismiss}
            className="rounded-xl bg-secondary px-3 py-1.5 text-[13px] text-muted-foreground"
          >
            Pomiń
          </motion.button>
        </div>
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ul className="border-t border-primary/10 px-4 pb-3 pt-2 space-y-1.5">
              {order.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between text-[13px]">
                  <span className="text-foreground">{item.product_name}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {Number(item.quantity) % 1 === 0 ? Number(item.quantity) : Number(item.quantity).toFixed(2)} {item.product_unit}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Main page ───────────────────────────────────────────────────── */

const DRAFT_KEY = 'order_create_draft';

type OrderDraft = {
  deliveryDate: string;
  selectedCustomer: SelectedCustomer | null;
  lines: OrderDraftLine[];
  prevOrderDismissed: boolean;
};

function draftKey(customerId?: string) {
  return customerId ? `${DRAFT_KEY}_${customerId}` : DRAFT_KEY;
}

function loadDraft(customerId?: string): Partial<OrderDraft> {
  try {
    const raw = sessionStorage.getItem(draftKey(customerId));
    return raw ? (JSON.parse(raw) as OrderDraft) : {};
  } catch {
    return {};
  }
}

function saveDraft(draft: OrderDraft, customerId?: string) {
  try {
    sessionStorage.setItem(draftKey(customerId), JSON.stringify(draft));
  } catch {
    // ignore
  }
}

function clearDraft(customerId?: string) {
  sessionStorage.removeItem(draftKey(customerId));
}

export function OrderCreatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlDate = searchParams.get('date') ?? '';
  const urlCustomerId = searchParams.get('customer_id') ?? '';
  const { user } = useAuth();
  const companyId = user?.current_company ?? '';
  const create = useCreateOrderMutation();
  const confirm = useConfirmOrderMutation();
  const createWithOffline = useOfflineOrderCreate();

  const draft = loadDraft(urlCustomerId || undefined);

  const [deliveryDate, setDeliveryDate] = useState(draft.deliveryDate ?? urlDate);
  const [selectedCustomer, setSelectedCustomer] = useState<SelectedCustomer | null>(
    urlCustomerId ? null : (draft.selectedCustomer ?? null),
  );
  const [customerInput, setCustomerInput] = useState(
    urlCustomerId ? '' : (draft.selectedCustomer?.name ?? ''),
  );
  const [customerOpen, setCustomerOpen] = useState(false);
  const [showCustomerChange, setShowCustomerChange] = useState(false);
  const customerRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;

  const customerDebounce = useDebouncedValue(customerInput, DEBOUNCE_MS);
  const { data: customerData, isFetching: customersLoading } = useCustomerListQuery(1, customerDebounce);
  const customers = customerData?.results ?? [];

  // Custom prices for selected customer — used to override default product prices
  const { data: customerPricesData } = useCustomerPricesQuery(selectedCustomer?.id);
  // Store effective net price per product (converting gross→net when price_type='gross')
  const customerPrices: Record<string, string> = {};
  (customerPricesData ?? []).forEach((cp) => {
    const val = parseDecimalInput(cp.price_net) ?? 0;
    const vat = parseDecimalInput(String(cp.product_vat_rate)) ?? 0;
    const netVal = cp.price_type === 'gross' ? val / (1 + vat / 100) : val;
    customerPrices[cp.product] = netVal.toFixed(4);
  });

  // Auto-load customer from URL param
  const { data: preloadedCustomer } = useCustomerQuery(urlCustomerId || undefined, Boolean(urlCustomerId));
  useEffect(() => {
    if (preloadedCustomer && !selectedCustomer) {
      setSelectedCustomer({ id: preloadedCustomer.id, name: preloadedCustomer.name });
      setCustomerInput(preloadedCustomer.name);
    }
  }, [preloadedCustomer, selectedCustomer]);

  const [productSearch, setProductSearch] = useState('');
  const productSearchDebounced = useDebouncedValue(productSearch, DEBOUNCE_MS);

  const {
    data: productPages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: productsLoading,
  } = useInfiniteQuery({
    queryKey: ['products', 'order-create', companyId, productSearchDebounced] as const,
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
    enabled: Boolean(companyId),
  });

  const products = useMemo(() => productPages?.pages.flatMap((p) => p.results) ?? [], [productPages]);
  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const [lines, setLines] = useState<OrderDraftLine[]>(draft.lines ?? []);
  const [prevOrderDismissed, setPrevOrderDismissed] = useState(draft.prevOrderDismissed ?? false);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);

  const { data: prevOrdersData } = useOrdersByCustomerQuery(
    selectedCustomer?.id,
    Boolean(selectedCustomer) && lines.length === 0 && !prevOrderDismissed,
  );
  const prevOrder = prevOrdersData?.[0] ?? null;

  // Persist draft to sessionStorage on every relevant change
  useEffect(() => {
    saveDraft({ deliveryDate, selectedCustomer, lines, prevOrderDismissed }, selectedCustomer?.id || urlCustomerId || undefined);
  }, [deliveryDate, selectedCustomer, lines, prevOrderDismissed]);

  const [numPadValue, setNumPadValue] = useState('0');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [view, setView] = useState<'products' | 'checkout'>('products');

  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Infinite scroll sentinel
  useEffect(() => {
    const root = scrollRef.current;
    const el = sentinelRef.current;
    if (!root || !el || !hasNextPage) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { root, rootMargin: '120px', threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, products.length]);

  // Close customer dropdown on outside click
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (customerRef.current && !customerRef.current.contains(e.target as Node)) {
        setCustomerOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Lock page scroll while numpad sheet is open (sheet is portaled to body)
  useEffect(() => {
    if (!activeProductId) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [activeProductId]);

  if (!authStorage.getAccessToken()) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  const lineByProductId = useMemo(() => new Map(lines.map((l) => [l.product.id, l])), [lines]);

  /* Cart totals */
  const lineNetGross = (l: OrderDraftLine) => {
    const q = parseDecimalInput(l.quantity) ?? 0;
    const netU = parseDecimalInput(l.unitPriceNet);
    if (netU == null) return { net: 0, g: 0 };
    const vat = parseDecimalInput(String(l.product.vat_rate)) ?? 0;
    const disc = parseDecimalInput(l.discountPercent) ?? 0;
    return { net: lineTotalNet(q, netU, disc), g: lineTotalGross(q, netU, vat, disc) };
  };
  const { gross: orderGross } = sumLines(lines, (l) => lineNetGross(l).net, (l) => lineNetGross(l).g);
  const cartCount = lines.reduce((sum, l) => sum + (parseDecimalInput(l.quantity) ?? 0), 0);

  /* Copy previous order lines */
  const applyPrevOrder = () => {
    if (!prevOrder) return;
    const newLines: OrderDraftLine[] = prevOrder.items.map((item: OrderItem) => ({
      key: item.product_id,
      product: {
        id: item.product_id,
        name: item.product_name,
        unit: item.product_unit,
        price_net: item.unit_price_net,
        price_gross: item.unit_price_gross,
        vat_rate: item.vat_rate,
        description: null,
        sku: null,
        barcode: null,
        pkwiu: '',
        track_batches: false,
        min_stock_alert: 0,
        shelf_life_days: null,
        is_service: false,
        is_resalable: true,
        markup_percent: null,
        avg_cost: null,
        avg_cost_source: null,
        avg_cost_updated_at: null,
        last_cost: null,
        is_active: true,
        stock_total: undefined,
        user: null,
        created_at: '',
        updated_at: '',
      },
      quantity: String(item.quantity),
      unitPriceNet: String(item.unit_price_net),
      discountPercent: String(item.discount_percent),
    }));
    setLines(newLines);
    setPrevOrderDismissed(true);
  };

  /* Quick +1 */
  const quickAdd = (product: Product) => {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.product.id === product.id);
      if (idx >= 0) {
        const next = [...prev];
        const cur = parseDecimalInput(next[idx]!.quantity) ?? 0;
        next[idx] = { ...next[idx]!, quantity: String(cur + 1) };
        return next;
      }
      const customPrice = customerPrices[product.id];
      return [...prev, { key: product.id, product, quantity: '1', unitPriceNet: customPrice ?? String(product.price_net), discountPercent: '0' }];
    });
  };

  /* Quick -1 */
  const quickRemove = (product: Product) => {
    setLines((prev) => {
      const idx = prev.findIndex((l) => l.product.id === product.id);
      if (idx < 0) return prev;
      const cur = parseDecimalInput(prev[idx]!.quantity) ?? 0;
      if (cur <= 1) return prev.filter((l) => l.product.id !== product.id);
      const next = [...prev];
      next[idx] = { ...next[idx]!, quantity: String(cur - 1) };
      return next;
    });
  };

  /* Open numpad */
  const openNumpad = (product: Product) => {
    setActiveProductId(product.id);
    const existing = lineByProductId.get(product.id);
    setNumPadValue(existing ? existing.quantity : '0');
  };

  const closeNumpad = () => {
    setActiveProductId(null);
    setNumPadValue('0');
  };

  /* Confirm numpad */
  const confirmNumpad = () => {
    if (!activeProductId) return;
    const qtyNum = parseDecimalInput(numPadValue);
    if (qtyNum == null || qtyNum === 0) {
      setLines((prev) => prev.filter((l) => l.product.id !== activeProductId));
    } else {
      const product = lineByProductId.get(activeProductId)?.product ?? productById.get(activeProductId);
      if (product) {
        const qtyStr = normalizeQty(numPadValue);
        setLines((prev) => {
          const idx = prev.findIndex((l) => l.product.id === activeProductId);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx]!, quantity: qtyStr };
            return next;
          }
          return [...prev, { key: product.id, product, quantity: qtyStr, unitPriceNet: String(product.price_net), discountPercent: '0' }];
        });
      }
    }
    setActiveProductId(null);
    setNumPadValue('0');
  };

  /* Submit */
  const onSubmit = async () => {
    if (!selectedCustomer) { setSubmitError('Wybierz klienta'); return; }
    if (!deliveryDate.trim()) { setSubmitError('Podaj datę dostawy'); return; }
    if (lines.length === 0) { setSubmitError('Dodaj co najmniej jeden produkt'); return; }
    setSubmitError(null);
    try {
      const items: OrderItemWrite[] = lines.map((l) => {
        const netU = parseDecimalInput(l.unitPriceNet)!;
        const vat = parseDecimalInput(String(l.product.vat_rate)) ?? 0;
        return {
          product_id: l.product.id,
          quantity: toApiDecimalString(parseDecimalInput(l.quantity) ?? 0),
          unit_price_net: toApiDecimalString(netU),
          unit_price_gross: toApiDecimalString(unitGrossFromNet(netU, vat)),
          vat_rate: toApiDecimalString(vat),
          discount_percent: toApiDecimalString(parseDecimalInput(l.discountPercent) ?? 0),
        };
      });
      const body: OrderCreate = { customer_id: selectedCustomer.id, delivery_date: deliveryDate, items };
      await createWithOffline(body, async (b) => {
        const order = await create.mutateAsync(b);
        await confirm.mutateAsync(order.id);
      });
      clearDraft(selectedCustomer.id);
      const d = deliveryDate.trim();
      navigate(d ? `/orders?date=${encodeURIComponent(d)}` : '/orders');
    } catch (e) {
      if (e instanceof OfflineQueuedError) {
        clearDraft(selectedCustomer.id);
        const d = deliveryDate.trim();
        navigate(d ? `/orders?date=${encodeURIComponent(d)}` : '/orders');
        return;
      }
      setSubmitError(e instanceof Error ? e.message : 'Nie udało się utworzyć zamówienia');
    }
  };

  const backToOrders = () => {
    clearDraft(selectedCustomer?.id || urlCustomerId || undefined);
    const d = deliveryDate.trim();
    navigate(d ? `/orders?date=${encodeURIComponent(d)}` : '/orders');
  };

  const numpadOpen = Boolean(activeProductId);
  const activeProduct = activeProductId ? (productById.get(activeProductId) ?? lineByProductId.get(activeProductId)?.product) : null;
  const dateLabel = deliveryDate.trim() ? formatDeliveryDate(deliveryDate) : 'Wybierz datę';

  if (view === 'checkout') {
    return (
      <CheckoutView
        lines={lines}
        setLines={setLines}
        customerName={selectedCustomer?.name ?? ''}
        onBack={() => setView('products')}
        onSubmit={onSubmit}
        isPending={create.isPending}
        submitError={submitError}
      />
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-background pb-[calc(83px+env(safe-area-inset-bottom))]">
      {/* ── Sticky header ─────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/95 backdrop-blur-xl">
        <div className="mx-auto max-w-3xl px-4 pb-3 pt-10">
          {/* Back + title */}
          <div className="mb-4 flex items-center gap-3">
            <motion.button
              whileTap={{ scale: 0.92 }}
              type="button"
              onClick={backToOrders}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-card shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
              aria-label="Wróć do listy sklepów"
            >
              <ChevronLeftIcon />
            </motion.button>

            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold text-foreground">
                {selectedCustomer ? `Dostawa ${selectedCustomer.name}` : 'Nowe zamówienie'}
              </h1>

              {/* Date row */}
              <div className="mt-0.5 flex items-center gap-3">
                <input
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                  aria-label="Data dostawy"
                  className="cursor-pointer border-0 bg-transparent p-0 text-[13px] text-muted-foreground focus:outline-none focus:ring-0"
                />
                {deliveryDate && (
                  <span className="text-[13px] text-muted-foreground">{dateLabel}</span>
                )}
              </div>
            </div>

            {/* Customer change toggle */}
            {selectedCustomer && (
              <button
                type="button"
                onClick={() => setShowCustomerChange((v) => !v)}
                className="shrink-0 rounded-full px-3 py-1.5 text-[12px] font-medium text-muted-foreground hover:bg-muted"
                aria-label="Zmień klienta"
              >
                Zmień
              </button>
            )}
          </div>

          {/* Customer dropdown (only when no customer or changing) */}
          {(!selectedCustomer || showCustomerChange) && (
            <div className="mb-3">
              <CustomerDropdown
                value={customerInput}
                onChange={(v) => { setCustomerInput(v); setSelectedCustomer(null); }}
                onSelect={(c) => { setSelectedCustomer(c); setCustomerInput(c.name); setCustomerOpen(false); setShowCustomerChange(false); setLines([]); setPrevOrderDismissed(false); }}
                customers={customers}
                loading={customersLoading}
                open={customerOpen}
                onOpenChange={setCustomerOpen}
                containerRef={customerRef}
              />
            </div>
          )}

          {/* Search bar */}
          <div className="relative">
            <svg className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M11 19a8 8 0 100-16 8 8 0 000 16zm10 2l-4-4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <input
              type="search"
              placeholder="Szukaj produktu..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              aria-label="Szukaj produktu"
              className="h-12 w-full rounded-2xl border border-border bg-card pl-12 pr-4 text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
            />
          </div>
        </div>
      </header>

      {/* ── Product list ──────────────────────────────────────────── */}
      <main
        ref={scrollRef}
        className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-4 py-4"
        aria-label="Lista produktów"
      >
        {submitError && (
          <p className="mb-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
            {submitError}
          </p>
        )}

        {/* Previous order banner */}
        {prevOrder && lines.length === 0 && !prevOrderDismissed && (
          <PrevOrderBanner
            order={prevOrder}
            onUse={applyPrevOrder}
            onDismiss={() => setPrevOrderDismissed(true)}
          />
        )}

        {/* Section heading */}
        <h2 className="mb-3 text-[17px] font-semibold text-foreground">Produkty</h2>

        {/* Skeleton */}
        {productsLoading && products.length === 0 && (
          <div className="space-y-3" aria-hidden>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex animate-pulse items-center gap-4 rounded-xl bg-card p-3.5">
                <div className="h-14 w-14 shrink-0 rounded-xl bg-muted/50" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-2/3 rounded bg-muted/50" />
                  <div className="h-3 w-1/3 rounded bg-muted/35" />
                  <div className="h-3 w-1/4 rounded bg-muted/30" />
                </div>
                <div className="h-9 w-9 shrink-0 rounded-full bg-muted/40" />
              </div>
            ))}
          </div>
        )}

        {!productsLoading && products.length === 0 && (
          <p className="py-10 text-center text-sm text-muted-foreground">Brak produktów.</p>
        )}

        <div className="space-y-3" data-product-row>
          {products.map((product, i) => {
            const line = lineByProductId.get(product.id);
            const qty = line ? (parseDecimalInput(line.quantity) ?? 0) : 0;
            return (
              <motion.div
                key={product.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(i * 0.03, 0.3) }}
              >
                <ProductCard
                  product={product}
                  quantity={qty}
                  customPriceNet={customerPrices[product.id]}
                  onTap={() => openNumpad(product)}
                  onAdd={() => quickAdd(product)}
                  onRemove={() => quickRemove(product)}
                />
              </motion.div>
            );
          })}
        </div>

        <div ref={sentinelRef} className="h-2" aria-hidden />
        {isFetchingNextPage && (
          <p className="py-4 text-center text-xs text-muted-foreground" role="status">Ładowanie…</p>
        )}
      </main>

      {typeof document !== 'undefined'
        ? createPortal(
            <>
              {cartCount > 0 ? (
                <motion.div
                  initial={{ y: 60, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  className={cn(
                    'fixed z-40 left-0 right-0 pointer-events-none',
                    'bottom-[calc(83px+0.75rem+env(safe-area-inset-bottom))]',
                    'md:bottom-[max(0.75rem,env(safe-area-inset-bottom))]',
                  )}
                >
                  <div className="mx-auto w-full max-w-3xl px-4 pointer-events-auto">
                    <motion.button
                      whileTap={{ scale: 0.98 }}
                      type="button"
                      onClick={() => setView('checkout')}
                      className="flex w-full items-center justify-between rounded-2xl bg-primary px-4 py-3.5 text-primary-foreground shadow-[0_4px_16px_rgba(79,70,229,0.3)]"
                    >
                      <div className="flex items-center gap-3">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-foreground/20 text-sm font-bold">
                          {Math.round(cartCount)}
                        </span>
                        <span className="font-medium">Do zamówienia</span>
                      </div>
                      <span className="text-lg font-bold tabular-nums">{formatGrossPln(orderGross)}</span>
                    </motion.button>
                  </div>
                </motion.div>
              ) : null}

              <AnimatePresence>
              {numpadOpen && activeProduct ? (
                <>
                  <motion.div
                    key="numpad-backdrop"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 z-[100] bg-foreground/10 backdrop-blur-sm"
                    onClick={closeNumpad}
                    aria-hidden
                  />
                  <motion.div
                    key="numpad-sheet"
                    role="dialog"
                    aria-modal="true"
                    aria-label={`Ilość: ${activeProduct.name}`}
                    data-numpad
                    initial={{ y: '100%' }}
                    animate={{ y: 0 }}
                    exit={{ y: '100%' }}
                    transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                    className="fixed bottom-0 left-0 right-0 z-[110] overflow-hidden rounded-t-3xl bg-card shadow-[0_-8px_32px_rgba(0,0,0,0.12)]"
                  >
                    <div className="flex justify-center pt-3 pb-1" aria-hidden>
                      <div className="h-1 w-9 rounded-full bg-border" />
                    </div>

                    <div className="border-b border-border/60 px-5 pb-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[17px] font-semibold text-foreground">{activeProduct.name}</h3>
                          <p className="mt-0.5 text-[13px] text-muted-foreground">
                            {formatGrossPln(grossPerUnit(activeProduct))} / {activeProduct.unit || 'szt.'}
                          </p>
                        </div>
                        <motion.button
                          whileTap={{ scale: 0.9 }}
                          type="button"
                          aria-label="Zamknij"
                          onClick={closeNumpad}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary"
                        >
                          <XIcon />
                        </motion.button>
                      </div>
                    </div>

                    {/* Quantity stepper */}
                    <div className="flex items-center justify-center gap-6 px-5 py-4">
                      <motion.button
                        whileTap={{ scale: 0.88 }}
                        type="button"
                        aria-label="Zmniejsz ilość"
                        onClick={() => {
                          const cur = parseDecimalInput(numPadValue) ?? 0;
                          const next = Math.max(0, cur - 1);
                          setNumPadValue(String(next));
                        }}
                        className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground shadow-sm"
                      >
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                          <path d="M5 12h14" strokeLinecap="round" />
                        </svg>
                      </motion.button>

                      <div className="flex flex-col items-center">
                        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Ilość</span>
                        <span className="text-[40px] font-semibold tabular-nums leading-tight text-foreground">
                          {numPadValue === '' ? '0' : numPadValue}
                        </span>
                      </div>

                      <motion.button
                        whileTap={{ scale: 0.88 }}
                        type="button"
                        aria-label="Zwiększ ilość"
                        onClick={() => {
                          const cur = parseDecimalInput(numPadValue) ?? 0;
                          setNumPadValue(String(cur + 1));
                        }}
                        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm"
                      >
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden>
                          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
                        </svg>
                      </motion.button>
                    </div>

                    <div className="mx-auto max-w-3xl px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                      <NumPad
                        value={numPadValue}
                        onChange={setNumPadValue}
                        onConfirm={confirmNumpad}
                      />
                    </div>
                  </motion.div>
                </>
              ) : null}
            </AnimatePresence>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}
