'use client';

import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';

export interface NavEntry {
  key: string;
  label: string;
  href: string;
  icon: string;
  order: number;
  /** Packs that contribute this entry; `platform-core` for the universal ones. */
  workspaces: string[];
}

export interface Widget {
  id: string;
  title: string;
  description: string;
  type: 'stat' | 'timeseries' | 'bar' | 'table';
  dataset: string;
  filters: Record<string, string | number | boolean>;
  value?: { column: string; agg: 'sum' | 'avg' | 'min' | 'max' | 'count' };
  unit?: string;
  x?: string;
  y?: string;
  series?: string;
  category?: string;
  columns?: { column: string; label: string }[];
  span: number;
}

export interface DashboardDef {
  key: string;
  title: string;
  description: string;
  pack_id: string;
  customised: boolean;
  layout_version: number;
  widgets: Widget[];
  available_widgets: { id: string; title: string }[];
}

export interface WorkspaceInfo {
  tenant_id: string;
  capabilities: string[];
  packs: { id: string; name: string; industry: string; version: string; core: boolean }[];
  workspaces: { id: string; name: string }[];
  navigation: NavEntry[];
  dashboards: DashboardDef[];
  role_templates: { role: string; name: string; description: string; permissions: string[]; packs: string[] }[];
}

interface WorkspaceContextValue {
  info: WorkspaceInfo | undefined;
  /** 'all' (enterprise workspace) or the id of one industry pack. */
  selected: string;
  select: (id: string) => void;
  /** Navigation of the selected workspace. Visibility only: every service enforces access itself. */
  navigation: NavEntry[];
  dashboards: DashboardDef[];
  hasCapability: (capability: string) => boolean;
  isError: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const STORAGE_KEY = 'titan.workspace';

function remembered(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const query = useQuery({ queryKey: ['tenant', 'workspace'], queryFn: () => api<WorkspaceInfo>('/api/tenant/workspace'), staleTime: 60_000, retry: 1 });
  const [selected, setSelected] = useState('all');
  useEffect(() => setSelected(remembered()), []);

  const value = useMemo<WorkspaceContextValue>(() => {
    const info = query.data;
    const known = info?.workspaces.some((w) => w.id === selected) ? selected : 'all';
    const inScope = (packs: string[]) => known === 'all' || packs.includes(known) || packs.includes('platform-core');
    return {
      info,
      selected: known,
      select: (id: string) => {
        setSelected(id);
        try {
          window.localStorage.setItem(STORAGE_KEY, id);
        } catch {
          // a preference only
        }
      },
      navigation: (info?.navigation ?? []).filter((n) => inScope(n.workspaces)),
      dashboards: (info?.dashboards ?? []).filter((d) => inScope([d.pack_id])),
      hasCapability: (c: string) => !!info?.capabilities.includes(c),
      isError: query.isError,
    };
  }, [query.data, query.isError, selected]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceProvider');
  return ctx;
}

/** Link to the page that shows a workflow subject. */
export function subjectHref(subjectType: string, subjectId: string): string {
  switch (subjectType) {
    case 'case':
      return `/government/case/?id=${subjectId}`;
    case 'incident':
      return `/incidents/?id=${subjectId}`;
    case 'maintenance_request':
    case 'service_request':
      return `/maintenance/request/?id=${subjectId}`;
    default:
      return '/work/';
  }
}
