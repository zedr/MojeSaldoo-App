/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TestQueryProvider } from '@/test/TestQueryProvider';
import type { CompanyRole, UserPermissions } from '@/types';
import { CompanySettingsPage } from './CompanySettingsPage';

function renderPage() {
  return render(
    <TestQueryProvider>
      <MemoryRouter>
        <CompanySettingsPage />
      </MemoryRouter>
    </TestQueryProvider>,
  );
}

const refreshUser = vi.fn();
const toggleMutateAsync = vi.fn().mockResolvedValue({});

const authState = vi.hoisted(() => ({
  user: {
    id: 1,
    current_company: '550e8400-e29b-41d4-a716-446655440000' as string | null,
    current_company_role: 'admin' as CompanyRole | null,
    is_company_admin: true as boolean,
    permissions: null as UserPermissions | null,
  },
}));

const myCompaniesListState = vi.hoisted(() => ({
  data: [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      name: 'ACME Sp. z o.o.',
      nip: '5260250274',
      address: 'ul. Przykładowa 1',
      city: 'Kraków',
      postal_code: '30-001',
      email: 'biuro@acme.test',
      phone: '+48111222333',
    },
  ] as
    | {
        id: string;
        name: string;
        nip: string;
        address: string;
        city: string;
        postal_code: string;
        email: string;
        phone: string;
      }[]
    | undefined,
  isPending: false,
}));

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    refreshUser,
  }),
}));

const deleteCompanyMutateAsync = vi.fn().mockResolvedValue({ detail: 'Firma została usunięta.' });
const leaveCompanyMutateAsync = vi.fn().mockResolvedValue({ detail: 'Opuściłeś firmę.' });

vi.mock('@/query/use-companies', () => ({
  useMyCompaniesQuery: () => ({
    get data() {
      return myCompaniesListState.data;
    },
    get isPending() {
      return myCompaniesListState.isPending;
    },
  }),
  useCompanyModulesQuery: () => ({
    data: [
      { module: 'products' as const, isEnabled: true, enabledAt: '2020-01-15T10:00:00.000Z' },
      { module: 'warehouses' as const, isEnabled: false, enabledAt: null },
    ],
    isPending: false,
    isError: false,
  }),
  useToggleModuleMutation: () => ({
    mutateAsync: toggleMutateAsync,
    isPending: false,
  }),
  useCreateCompanyMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useSwitchCompanyMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useWorkflowSettingsQuery: () => ({
    data: { orders_required: false, wz_required_before_invoice: true },
    isPending: false,
    isError: false,
  }),
  useUpdateWorkflowSettingsMutation: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
  }),
  useDeleteCompanyMutation: () => ({
    mutateAsync: deleteCompanyMutateAsync,
    isPending: false,
  }),
  useLeaveCompanyMutation: () => ({
    mutateAsync: leaveCompanyMutateAsync,
    isPending: false,
  }),
}));

describe('CompanySettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.user = {
      id: 1,
      current_company: '550e8400-e29b-41d4-a716-446655440000',
      current_company_role: 'Administrator',
      is_company_admin: true,
      permissions: {
        can_manage_team: true, can_manage_settings: true, can_see_prices: true,
        can_manage_products: true, can_manage_warehouses: true, can_manage_inventory: true,
        can_manage_customers: true, can_manage_orders: true,
        can_manage_delivery: true, can_access_routes: true, can_manage_invoices: true,
        can_manage_purchasing: true, can_manage_production: true, can_view_reports: true,
        can_access_ksef_inbox: true, can_manage_stock_moves: true, can_manage_accounting: true,
      },
    };
    myCompaniesListState.data = [
      {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'ACME Sp. z o.o.',
        nip: '5260250274',
        address: 'ul. Przykładowa 1',
        city: 'Kraków',
        postal_code: '30-001',
        email: 'biuro@acme.test',
        phone: '+48111222333',
      },
    ];
    myCompaniesListState.isPending = false;
  });

  it('shows company data and module cards', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Ustawienia firmy' })).toBeInTheDocument();
    expect(screen.getByText('ACME Sp. z o.o.')).toBeInTheDocument();
    expect(screen.getByText('5260250274')).toBeInTheDocument();
    const roleGroup = screen.getByText('Twoja rola').parentElement;
    expect(roleGroup).toBeTruthy();
    expect(within(roleGroup as HTMLElement).getByText('Administrator', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Produkty i magazyn')).toBeInTheDocument();
    expect(screen.getByText('Moduł aktywny')).toBeInTheDocument();
  });

  it('toggles a module for admin and refreshes the user', async () => {
    const user = userEvent.setup();
    renderPage();

    const warehousesCard = screen.getByText('Magazyny').closest('li');
    expect(warehousesCard).toBeTruthy();
    const whSwitch = within(warehousesCard!).getByRole('switch');
    await user.click(whSwitch);

    await waitFor(() => {
      expect(toggleMutateAsync).toHaveBeenCalledWith({ module: 'warehouses', enabled: true });
    });
    expect(refreshUser).toHaveBeenCalled();
  });

  it('disables module switches for non-admin roles', () => {
    authState.user.current_company_role = 'Pracownik';
    authState.user.is_company_admin = false;
    authState.user.permissions = {
      can_manage_team: false, can_manage_settings: false, can_see_prices: true,
      can_manage_products: true, can_manage_warehouses: false, can_manage_inventory: false,
      can_manage_customers: true, can_manage_orders: true,
      can_manage_delivery: true, can_access_routes: false, can_manage_invoices: false,
      can_manage_purchasing: false, can_manage_production: false, can_view_reports: false,
      can_access_ksef_inbox: false, can_manage_stock_moves: false, can_manage_accounting: false,
    };
    renderPage();

    const switches = screen.getAllByRole('switch');
    for (const sw of switches) {
      expect(sw).toBeDisabled();
    }
    expect(
      screen.getByText(
        /Tylko administrator może zmieniać moduły/,
      ),
    ).toBeInTheDocument();
  });

  it('asks to refresh when the user has no company memberships', () => {
    authState.user.current_company = null;
    myCompaniesListState.data = [];
    renderPage();

    expect(screen.getByText(/Nie należysz do żadnej firmy/)).toBeInTheDocument();
  });

  it('shows delete button only for admins', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Usuń firmę' })).toBeInTheDocument();
  });

  it('hides delete button for non-admins', () => {
    authState.user.is_company_admin = false;
    renderPage();
    expect(screen.queryByRole('button', { name: 'Usuń firmę' })).not.toBeInTheDocument();
  });

  it('shows leave button for all members', () => {
    authState.user.is_company_admin = false;
    renderPage();
    expect(screen.getByRole('button', { name: 'Opuść firmę' })).toBeInTheDocument();
  });

  it('confirm button disabled until name matches', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Usuń firmę' }));

    const confirmBtn = screen.getByRole('button', { name: 'Usuń firmę', hidden: false });
    expect(confirmBtn).toBeDisabled();

    const input = screen.getByPlaceholderText('Wpisz nazwę firmy');
    await user.type(input, 'ACME Sp. z o.o.');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Usuń firmę' })).not.toBeDisabled();
    });
  });

  it('calls deleteCompany and navigates on successful deletion', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'Usuń firmę' }));
    const input = screen.getByPlaceholderText('Wpisz nazwę firmy');
    await user.type(input, 'ACME Sp. z o.o.');

    const confirmBtn = await screen.findByRole('button', { name: 'Usuń firmę' });
    await user.click(confirmBtn);

    await waitFor(() => {
      expect(deleteCompanyMutateAsync).toHaveBeenCalledWith({
        companyId: '550e8400-e29b-41d4-a716-446655440000',
        confirmName: 'ACME Sp. z o.o.',
      });
    });
    expect(refreshUser).toHaveBeenCalled();
  });
});
