'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bell, Bot, Building2, ClipboardCheck, FileText, LayoutDashboard, LifeBuoy, LogOut, Map as MapIcon, Menu, Settings, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { REVIEWER_ROLES, STAFF_ROLES, useAuth } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { ago, titleCase } from '@/lib/format';
import { Button, Dialog, EmptyState } from './ui';

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** Roles that see this entry. Undefined: everybody. */
  roles?: string[];
}

/** Navigation is derived from the roles in the user's token. The services enforce the same rules again. */
export const NAV: NavItem[] = [
  { href: '/', label: 'Executive dashboard', icon: LayoutDashboard, roles: STAFF_ROLES },
  { href: '/government/', label: 'Applications', icon: FileText, roles: ['applicant', ...REVIEWER_ROLES, 'tenant_admin', 'auditor'] },
  { href: '/government/inbox/', label: 'Review inbox', icon: ClipboardCheck, roles: [...REVIEWER_ROLES, 'duty_officer', 'incident_commander', 'tenant_admin'] },
  { href: '/iot/', label: 'IoT operations', icon: Activity, roles: STAFF_ROLES },
  { href: '/gis/', label: 'GIS operations', icon: MapIcon, roles: STAFF_ROLES },
  { href: '/ai/', label: 'AI workspace', icon: Bot, roles: STAFF_ROLES },
  { href: '/admin/', label: 'Administration', icon: Settings, roles: ['tenant_admin', 'auditor'] },
  { href: '/dr/', label: 'Disaster recovery', icon: LifeBuoy, roles: ['dr_operator', 'platform_admin', 'tenant_admin'] },
];

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/government/') return pathname.startsWith('/government') && !pathname.startsWith('/government/inbox');
  return pathname.startsWith(href.replace(/\/$/, ''));
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const count = useQuery({ queryKey: ['notifications', 'unread'], queryFn: () => api<{ unread: number }>('/api/notification/notifications/unread-count'), refetchInterval: 30_000, retry: false });
  const list = useQuery({ queryKey: ['notifications', 'list'], queryFn: () => api<any[]>('/api/notification/notifications?limit=30'), enabled: open, retry: false });
  const unread = count.data?.unread ?? 0;

  async function markRead(id: string) {
    await api(`/api/notification/notifications/${id}/read`, { method: 'POST' });
    await client.invalidateQueries({ queryKey: ['notifications'] });
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="relative rounded-md p-2 text-ink-muted hover:bg-slate-100" aria-label={count.isError ? 'Notifications (unavailable)' : `Notifications, ${unread} unread`}>
        <Bell className="h-5 w-5" aria-hidden="true" />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-full bg-red-600 px-1 text-center text-[11px] font-semibold leading-5 text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Notifications" footer={<Button onClick={() => setOpen(false)}>Close</Button>}>
        {list.isPending && <p className="text-sm text-ink-muted">Loading…</p>}
        {list.isError && <p role="alert" className="text-sm text-amber-800">Notifications are unavailable right now.</p>}
        {list.data?.length === 0 && <EmptyState title="No notifications" />}
        <ul className="max-h-[55vh] divide-y divide-line overflow-y-auto" tabIndex={0} aria-label="Notifications">
          {list.data?.map((n) => (
            <li key={n.id} className="flex items-start gap-3 py-2.5">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-slate-300' : 'bg-brand-600'}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${n.read ? 'text-ink-muted' : 'font-medium text-ink'}`}>{n.subject}</p>
                <p className="text-sm text-ink-muted">{n.body}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {titleCase(n.category.replace('.', ' · '))} · {ago(n.created_at)}
                </p>
              </div>
              {!n.read && (
                <Button variant="ghost" onClick={() => void markRead(n.id)}>
                  Mark read
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout, hasRole } = useAuth();
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const tenant = useQuery({ queryKey: ['tenant', 'current'], queryFn: () => api<{ name: string }>('/api/tenant/tenants/current'), staleTime: 5 * 60_000, retry: false });
  const items = NAV.filter((i) => !i.roles || hasRole(...i.roles));

  useEffect(() => setMenuOpen(false), [pathname]);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 p-3">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium ${active ? 'bg-white/15 text-white' : 'text-sky-100 hover:bg-white/10 hover:text-white'}`}
          >
            <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col bg-brand-900 lg:flex">
        <div className="flex items-center gap-2 border-b border-white/10 px-5 py-4">
          <Building2 className="h-6 w-6 text-sky-300" aria-hidden="true" />
          <div>
            <p className="text-base font-semibold leading-tight text-white">TITAN</p>
            <p className="text-[11px] leading-tight text-sky-200">Operations platform</p>
          </div>
        </div>
        {nav}
        <p className="mt-auto border-t border-white/10 p-4 text-[11px] leading-snug text-sky-200">
          {titleCase(getConfig().environment)} environment. All records are synthetic demonstration data.
        </p>
      </aside>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <aside className="absolute inset-y-0 left-0 w-72 bg-brand-900 shadow-xl" id="mobile-menu">
            <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
              <p className="text-base font-semibold text-white">TITAN</p>
              <button type="button" onClick={() => setMenuOpen(false)} className="rounded-md p-2 text-sky-100 hover:bg-white/10" aria-label="Close menu">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-4 py-2.5">
          <button type="button" onClick={() => setMenuOpen(true)} className="rounded-md p-2 text-ink-muted hover:bg-slate-100 lg:hidden" aria-label="Open menu" aria-expanded={menuOpen} aria-controls="mobile-menu">
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink" data-testid="tenant-name">
              {tenant.data?.name ?? (tenant.isError ? 'Tenant unavailable' : '…')}
            </p>
            <p className="truncate text-xs text-ink-muted">{user.department ? `${titleCase(user.department)} department` : 'Signed in'}</p>
          </div>
          <Notifications />
          <div className="hidden text-right sm:block">
            <p className="text-sm font-medium text-ink" data-testid="user-name">
              {user.name || user.username}
            </p>
            <p className="text-xs text-ink-muted" data-testid="user-roles">
              {user.roles.map(titleCase).join(', ') || 'No roles'}
            </p>
          </div>
          <Button variant="ghost" onClick={logout} aria-label="Sign out">
            <LogOut className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
