import type { ModuleName } from '@/types';

/** Polish copy for company module settings (aligned with `CompanyModule.MODULE_CHOICES`). */
export const MODULE_DISPLAY_ORDER: ModuleName[] = [
  'products',
  'warehouses',
  'customers',
  'orders',
  'delivery',
  'van_routes',
  'invoicing',
  'ksef',
  'ksef_inbox',
  'purchasing',
  'production',
  'cost_allocation',
  'reporting',
];

export const MODULE_CARD_COPY: Record<
  ModuleName,
  { title: string; description: string; statusOn: string; statusOff: string }
> = {
  products: {
    title: 'Produkty i magazyn',
    description: 'Katalog, partie, stany i lokalizacje magazynowe.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  warehouses: {
    title: 'Magazyny',
    description: 'Definicje magazynów i stany w wielu lokalizacjach.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  customers: {
    title: 'Klienci',
    description: 'Baza odbiorców i dane kontaktowe.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  orders: {
    title: 'Zamówienia',
    description: 'Zamówienia i realizacja sprzedaży.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  delivery: {
    title: 'Dostawa i dokumenty WZ',
    description: 'Wystawianie WZ i obsługa dostaw.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  van_routes: {
    title: 'Trasy rozwozowe',
    description: 'Planowanie tras i rozliczanie dostaw kierowców.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  invoicing: {
    title: 'Fakturowanie',
    description: 'Faktury sprzedaży i powiązane dokumenty.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  ksef: {
    title: 'KSeF',
    description: 'Integracja z Krajowym Systemem e-Faktur.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  ksef_inbox: {
    title: 'Skrzynka odbiorcza KSeF',
    description: 'Odbieranie faktur zakupowych i kosztowych z KSeF.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  purchasing: {
    title: 'Zakupy i dostawcy',
    description: 'Dostawcy, dokumenty PZ i przyjęcia towaru.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  production: {
    title: 'Produkcja',
    description: 'Receptury, zlecenia produkcji, rozchody RW i przychody PW.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  cost_allocation: {
    title: 'Adnotacje kosztowe',
    description: 'Przypisywanie projektów i opisów dla księgowości do pozycji faktur z KSeF. Eksport zestawienia do biura rachunkowego.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
  reporting: {
    title: 'Raporty',
    description: 'Analityka, zestawienia i eksporty.',
    statusOn: 'Moduł aktywny',
    statusOff: 'Moduł wyłączony',
  },
};
