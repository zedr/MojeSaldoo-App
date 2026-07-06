import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useKsefKorMatchQuery } from '@/query/use-invoices';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { cn } from '@/lib/utils';
import { deliveryService } from '@/services/delivery.service';
import type { PzKorItemPayload } from '@/types/delivery.types';
import type { KorMatchPzItem } from '@/services/ksef.service';

const plMoney = new Intl.NumberFormat('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface CorrectionLine {
  deliveryItemId: string;
  productName: string;
  unit: string;
  originalQty: number;
  originalCost: number;
  newQty: string;
  newCost: string;
  include: boolean;
}

function buildLines(items: KorMatchPzItem[]): CorrectionLine[] {
  return items.map((item) => ({
    deliveryItemId: item.id,
    productName: item.productName,
    unit: item.unit,
    originalQty: item.quantity,
    originalCost: item.unitCost,
    newQty: String(item.quantity),
    newCost: String(item.unitCost),
    include: false,
  }));
}

export function KSeFInboxKorPage() {
  const { ksefNumber } = useParams<{ ksefNumber: string }>();
  const navigate = useNavigate();

  const { data: match, isPending, isError, error } = useKsefKorMatchQuery(
    ksefNumber ?? '',
    Boolean(ksefNumber),
  );

  const [selectedPzId, setSelectedPzId] = useState<string | null>(null);
  const [lines, setLines] = useState<CorrectionLine[] | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectedPz = match?.pz_documents.find((p) => p.id === selectedPzId) ?? null;

  const handleSelectPz = (pzId: string) => {
    setSelectedPzId(pzId);
    const pz = match?.pz_documents.find((p) => p.id === pzId);
    if (pz) setLines(buildLines(pz.items));
    setSubmitError(null);
  };

  const updateLine = (idx: number, field: 'newQty' | 'newCost' | 'include', value: string | boolean) => {
    setLines((prev) => {
      if (!prev) return prev;
      return prev.map((l, i) => i === idx ? { ...l, [field]: value } : l);
    });
  };

  const handleSubmit = async () => {
    if (!selectedPzId || !lines) return;
    const items = lines
      .filter((l) => l.include)
      .map((l) => {
        const newQty = parseFloat(l.newQty);
        const newCost = parseFloat(l.newCost);
        const changed: PzKorItemPayload = { delivery_item_id: l.deliveryItemId };
        if (!Number.isNaN(newQty) && newQty !== l.originalQty) changed.new_quantity_actual = String(newQty);
        if (!Number.isNaN(newCost) && newCost !== l.originalCost) changed.new_unit_cost = String(newCost);
        return changed;
      });

    if (items.length === 0) {
      setSubmitError('Zaznacz co najmniej jedną pozycję do korekty.');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const doc = await deliveryService.createPzKor(selectedPzId, {
        items,
        notes: notes || undefined,
      });
      navigate(`/delivery/${doc.id}`);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Błąd tworzenia PZ-KOR.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!ksefNumber) return null;

  return (
    <div className="max-w-3xl p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/ksef/inbox" className="text-sm text-muted-foreground hover:text-foreground">
          ← Skrzynka odbiorcza
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-xl font-semibold tracking-tight">Utwórz PZ-KOR</h1>
      </div>

      {/* KOR invoice info */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold bg-orange-100 text-orange-700">KOR</span>
            Faktura korygująca
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground break-all font-mono">{ksefNumber}</p>
        </CardContent>
      </Card>

      {isPending && (
        <p className="text-sm text-muted-foreground">Wyszukiwanie oryginalnego PZ…</p>
      )}

      {isError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Błąd pobierania danych'}
          <p className="mt-1 text-xs">Upewnij się, że XML faktury był już pobrany (kliknij ▼ na liście).</p>
        </div>
      )}

      {match && !match.matched && (
        <div className="rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 space-y-1">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Nie znaleziono powiązanego PZ</p>
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Oryginalna faktura KSeF <span className="font-mono">{match.original_ksef_number}</span>{' '}
            {match.original_invoice
              ? 'jest w skrzynce, ale nie ma przypisanego PZ.'
              : 'nie jest jeszcze w skrzynce — wykonaj synchronizację.'}
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400 mt-1">
            Możesz najpierw przejść do oryginalnej faktury, utworzyć PZ, a następnie wrócić tutaj.
          </p>
        </div>
      )}

      {match?.original_invoice && (
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-sm">Oryginalna faktura</CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-0.5">
            <p><span className="text-muted-foreground">Nr: </span>{match.original_invoice.invoiceNumber || '—'}</p>
            <p><span className="text-muted-foreground">Data: </span>{match.original_invoice.issueDate ?? '—'}</p>
            <p><span className="text-muted-foreground">Dostawca: </span>{match.original_invoice.seller.name}</p>
            <p className="text-xs text-muted-foreground font-mono">{match.original_invoice.ksefNumber}</p>
          </CardContent>
        </Card>
      )}

      {/* PZ selector */}
      {match && match.pz_documents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Wybierz PZ do korekty</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {match.pz_documents.map((pz) => (
              <button
                key={pz.id}
                type="button"
                onClick={() => handleSelectPz(pz.id)}
                className={cn(
                  'w-full text-left rounded-xl border px-4 py-3 transition-colors',
                  selectedPzId === pz.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border bg-background hover:bg-muted',
                )}
              >
                <p className="text-sm font-medium">{pz.documentNumber}</p>
                <p className="text-xs text-muted-foreground">{pz.issueDate} · {pz.status} · {pz.items.length} poz.</p>
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Correction lines */}
      {selectedPz && lines && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Pozycje PZ {selectedPz.documentNumber} — zaznacz i zmień wartości korygowane
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left pb-2 pr-3 font-medium w-8" />
                    <th className="text-left pb-2 pr-3 font-medium">Produkt</th>
                    <th className="text-right pb-2 pr-3 font-medium">Oryg. ilość</th>
                    <th className="text-right pb-2 pr-3 font-medium">Nowa ilość</th>
                    <th className="text-right pb-2 pr-3 font-medium">Oryg. cena netto</th>
                    <th className="text-right pb-2 font-medium">Nowa cena netto</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => (
                    <tr key={line.deliveryItemId} className={cn('border-t border-border/50', line.include && 'bg-primary/5')}>
                      <td className="py-2 pr-3">
                        <input
                          type="checkbox"
                          checked={line.include}
                          onChange={(e) => updateLine(idx, 'include', e.target.checked)}
                          className="rounded border-input"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <p className="font-medium">{line.productName}</p>
                        <p className="text-xs text-muted-foreground">{line.unit}</p>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {line.originalQty}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.001"
                          value={line.newQty}
                          disabled={!line.include}
                          onChange={(e) => updateLine(idx, 'newQty', e.target.value)}
                          className={cn(
                            'w-24 rounded border px-2 py-1 text-xs text-right tabular-nums',
                            'border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring',
                            !line.include && 'opacity-40',
                          )}
                        />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {plMoney.format(line.originalCost)}
                      </td>
                      <td className="py-2 text-right">
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={line.newCost}
                          disabled={!line.include}
                          onChange={(e) => updateLine(idx, 'newCost', e.target.value)}
                          className={cn(
                            'w-28 rounded border px-2 py-1 text-xs text-right tabular-nums',
                            'border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring',
                            !line.include && 'opacity-40',
                          )}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">
                  Przyczyna korekty (opcjonalnie)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="np. Faktura korygująca nr KOR/15/2026 — zmiana ceny"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>

              {submitError && (
                <p className="text-sm text-destructive">{submitError}</p>
              )}

              <div className="flex items-center gap-3">
                <Button onClick={() => void handleSubmit()} loading={submitting}>
                  Utwórz PZ-KOR
                </Button>
                <Button variant="outline" onClick={() => navigate('/ksef/inbox')}>
                  Anuluj
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
