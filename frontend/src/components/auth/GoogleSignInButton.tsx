import { GoogleLogin } from '@react-oauth/google';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { authApi } from '@/services/api';
import { companyKeys } from '@/query/keys';
import { companyService } from '@/services/company.service';

interface GoogleSignInButtonProps {
  /** Where to send the user after successful login if they already have a company. Defaults to '/'. */
  defaultRedirect?: string;
}

export function GoogleSignInButton({ defaultRedirect = '/' }: GoogleSignInButtonProps) {
  const { refreshUser } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="flex h-10 w-full items-center justify-center rounded-md border border-input bg-muted/30 text-sm text-muted-foreground">
        Łączenie z Google…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-center">
        <GoogleLogin
          onSuccess={async (response) => {
            if (!response.credential) return;
            setLoading(true);
            setError(null);
            try {
              await authApi.loginWithGoogle(response.credential);
              await refreshUser();
              const companies = await queryClient.fetchQuery({
                queryKey: companyKeys.me(),
                queryFn: () => companyService.getMyCompanies(),
              });
              navigate(companies.length > 0 ? defaultRedirect : '/onboarding', { replace: true });
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Logowanie przez Google nie powiodło się.');
              setLoading(false);
            }
          }}
          onError={() => setError('Logowanie przez Google nie powiodło się. Spróbuj ponownie.')}
          text="continue_with"
          shape="rectangular"
          size="large"
          width="360"
        />
      </div>
    </div>
  );
}
