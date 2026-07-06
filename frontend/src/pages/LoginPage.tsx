import { type FormEvent, useState } from 'react';
import { isAxiosError } from 'axios';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { companyKeys } from '@/query/keys';
import { useMyCompaniesQuery } from '@/query/use-companies';
import { API_BASE_URL } from '@/services/api';
import { companyService } from '@/services/company.service';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { GoogleSignInButton } from '@/components/auth/GoogleSignInButton';
function resolvePostLoginTarget(from: string, hasCompanies: boolean): string {
  if (!hasCompanies) return '/onboarding';
  if (!from.startsWith('/')) return '/';
  if (from === '/login' || from === '/onboarding') return '/';
  return from;
}

/**
 * When session exists but the user opened `/login`, send them to onboarding or the app based on company membership.
 */
function PostAuthLoginRedirect({ from }: { from: string }) {
  const { data, isPending, isSuccess, isError } = useMyCompaniesQuery();

  if (isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 text-sm text-muted-foreground">
        Ładowanie…
      </div>
    );
  }

  if (isError) {
    // Could not load companies (network/401/5xx). Prefer onboarding so new users are not dropped on `/` with a broken shell.
    return <Navigate to="/onboarding" replace />;
  }

  const hasCompanies = isSuccess && data.length > 0;
  return <Navigate to={resolvePostLoginTarget(from, hasCompanies)} replace />;
}

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { login, isAuthenticated, isLoading } = useAuth();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 text-sm text-muted-foreground">
        Ładowanie…
      </div>
    );
  }

  if (isAuthenticated) {
    return <PostAuthLoginRedirect from={from.startsWith('/') ? from : '/'} />;
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(username.trim(), password);
      const companies = await queryClient.fetchQuery({
        queryKey: companyKeys.me(),
        queryFn: () => companyService.getMyCompanies(),
      });
      const target = resolvePostLoginTarget(from, companies.length > 0);
      navigate(target, { replace: true });
    } catch (err) {
      if (isAxiosError(err) && err.message === 'Network Error') {
        setError(
          `Brak połączenia z API (${API_BASE_URL}). Uruchom Django na porcie 8000 i otwórz aplikację z Vite (http://localhost:3000). Usuń VITE_API_BASE_URL z pliku .env w dev, chyba że skonfigurowałeś CORS dla tego hosta.`,
        );
        return;
      }
      setError(err instanceof Error ? err.message : 'Logowanie nie powiodło się');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">MojeSaldoo</h1>
          <p className="mt-1 text-sm text-muted-foreground">Zaloguj się, aby kontynuować</p>
        </div>

        <Card className="shadow-sm">
          <CardContent className="pt-6 space-y-4">
            <GoogleSignInButton />

            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">lub</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form className="space-y-4" onSubmit={onSubmit}>
              {error && (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              <Input
                label="Nazwa użytkownika lub e-mail"
                name="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(ev) => setUsername(ev.target.value)}
                required
              />
              <Input
                label="Hasło"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(ev) => setPassword(ev.target.value)}
                required
              />
              <div className="flex items-center justify-between pt-1">
                <Link to="/forgot-password" className="text-sm text-muted-foreground hover:text-primary hover:underline">
                  Zapomniałeś hasła?
                </Link>
              </div>
              <Button type="submit" loading={loading} className="w-full">
                Zaloguj się
              </Button>
            </form>
          </CardContent>
        </Card>


        <p className="text-center text-sm text-muted-foreground">
          Nie masz jeszcze konta?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Zarejestruj się
          </Link>
        </p>
      </div>
    </div>
  );
}
