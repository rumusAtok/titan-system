'use client';

import Keycloak from 'keycloak-js';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { getConfig } from './config';

export interface User {
  id: string;
  username: string;
  name: string;
  email: string | null;
  tenantId: string;
  department: string | null;
  roles: string[];
}

type AuthState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; user: User };

interface AuthContextValue {
  user: User;
  logout: () => void;
  hasRole: (...roles: string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let keycloak: Keycloak | null = null;
let initialising: Promise<boolean> | null = null;

/** One Keycloak client per page load, even if React mounts the provider twice. */
function init(): Promise<boolean> {
  if (!initialising) {
    const config = getConfig();
    keycloak = new Keycloak({ url: config.keycloakUrl, realm: config.realm, clientId: config.clientId });
    // Authorization Code flow with PKCE. Tokens stay in memory: nothing is put in localStorage.
    initialising = keycloak.init({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false });
  }
  return initialising;
}

/** A valid access token, refreshed when it is about to expire. Redirects to login if the session ended. */
export async function getToken(): Promise<string> {
  await init();
  if (!keycloak) throw new Error('not authenticated');
  try {
    await keycloak.updateToken(30);
  } catch {
    await keycloak.login();
  }
  if (!keycloak.token) throw new Error('not authenticated');
  return keycloak.token;
}

export function forceLogin(): void {
  void keycloak?.login();
}

function userFromToken(): User {
  const claims = (keycloak?.tokenParsed ?? {}) as Record<string, any>;
  // Realm roles the platform knows about; Keycloak's built-in default roles are not shown.
  const roles: string[] = (claims.realm_access?.roles ?? []).filter((r: string) => !r.startsWith('default-roles-') && r !== 'offline_access' && r !== 'uma_authorization');
  return {
    id: claims.sub,
    username: claims.preferred_username ?? claims.sub,
    name: claims.name ?? claims.preferred_username ?? '',
    email: claims.email ?? null,
    tenantId: claims.tenant_id ?? '',
    department: claims.department ?? null,
    roles,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    init()
      .then((authenticated) => {
        if (cancelled) return;
        if (!authenticated) setState({ status: 'error', message: 'Sign-in did not complete.' });
        else setState({ status: 'ready', user: userFromToken() });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: 'The identity provider could not be reached. Check that Keycloak is running, then reload.' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-600" role="status" aria-live="polite">
        <span className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-sky-700" aria-hidden="true" />
        Signing in…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div role="alert" className="max-w-md rounded-lg border border-red-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-slate-900">Unable to sign in</h1>
          <p className="mt-2 text-sm text-slate-600">{state.message}</p>
          <button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-md bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700">
            Try again
          </button>
        </div>
      </div>
    );
  }

  const value: AuthContextValue = {
    user: state.user,
    logout: () => void keycloak?.logout({ redirectUri: window.location.origin }),
    hasRole: (...roles) => roles.some((r) => state.user.roles.includes(r)),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export const STAFF_ROLES = [
  'validation_officer', 'technical_officer', 'department_head', 'final_approver', 'duty_officer', 'incident_commander',
  'asset_manager', 'iot_operator', 'analyst', 'auditor', 'tenant_admin',
];
export const REVIEWER_ROLES = ['validation_officer', 'technical_officer', 'department_head', 'final_approver'];
