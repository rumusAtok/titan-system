'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { DecisionDialog, type WorkflowTask } from '@/components/decision';
import { Badge, Button, Card, type Column, DataTable, PageHeader, QueryView, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';
import { subjectHref } from '@/lib/workspace';

const TONE: Record<string, 'danger' | 'info' | 'warn' | 'neutral'> = { incident: 'danger', case: 'info', maintenance_request: 'warn', service_request: 'warn' };

/**
 * Shared work inbox: every workflow task waiting for a role the user holds (or holds
 * by delegation), whatever the business subject. workflow-service decides who may act.
 */
export default function WorkInboxPage() {
  const { hasRole } = useAuth();
  const canSeeAll = hasRole('tenant_admin', 'auditor');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [kind, setKind] = useState('');
  const [deciding, setDeciding] = useState<WorkflowTask | null>(null);
  const tasks = useQuery({ queryKey: ['workflow', 'work-inbox', scope], queryFn: () => api<any[]>(`/api/workflow/tasks?scope=${scope}&limit=200`), refetchInterval: 10_000 });
  const kinds = [...new Set((tasks.data ?? []).map((t) => t.subject_type as string))].sort();

  const columns: Column<any>[] = [
    { key: 'reference', header: 'Reference', value: (t) => t.reference, cell: (t) => <Link className="font-medium text-brand-700 hover:underline" href={subjectHref(t.subject_type, t.subject_id)}>{t.reference}</Link> },
    { key: 'title', header: 'Subject', value: (t) => t.title, cell: (t) => t.title },
    { key: 'type', header: 'Type', value: (t) => t.subject_type, cell: (t) => <Badge tone={TONE[t.subject_type] ?? 'neutral'}>{titleCase(t.subject_type)}</Badge> },
    { key: 'stage', header: 'Step', value: (t) => t.stage_name, cell: (t) => t.stage_name },
    { key: 'role', header: 'Assigned to role', value: (t) => t.role, cell: (t) => titleCase(t.role) },
    { key: 'waiting', header: 'Waiting', value: (t) => t.assigned_at, cell: (t) => ago(t.assigned_at) },
    {
      key: 'due', header: 'Due', value: (t) => t.due_at ?? '',
      cell: (t) => (t.due_at ? <span className={t.overdue ? 'font-medium text-red-700' : ''}>{dateTime(t.due_at)}{t.overdue && ' (overdue)'}{t.escalated_at && ' · escalated'}</span> : '—'),
    },
    { key: 'action', header: 'Action', cell: (t) => (scope === 'mine' ? <Button variant="primary" onClick={() => setDeciding(t)}>Decide</Button> : <span className="text-ink-muted">View only</span>) },
  ];

  return (
    <>
      <PageHeader title="Work inbox" description="Every approval and response step waiting for a role you hold: applications, incidents, maintenance and service requests. Decisions are final and audited." />
      <Card padded={false}>
        <QueryView query={tasks} what="Your work inbox">
          {(rows) => (
            <DataTable
              caption="Pending workflow tasks of every kind"
              columns={columns}
              rows={kind ? rows.filter((r) => r.subject_type === kind) : rows}
              rowKey={(t) => t.id}
              filterPlaceholder="Filter by reference, subject, step…"
              emptyTitle="Nothing is waiting for you"
              toolbar={
                <>
                  <label className="sr-only" htmlFor="work-kind">Type</label>
                  <select id="work-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputClass} w-auto`}>
                    <option value="">Every type</option>
                    {kinds.map((k) => (
                      <option key={k} value={k}>{titleCase(k)}</option>
                    ))}
                  </select>
                  {canSeeAll && (
                    <>
                      <label className="sr-only" htmlFor="work-scope">Scope</label>
                      <select id="work-scope" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} className={`${inputClass} w-auto`}>
                        <option value="mine">For me</option>
                        <option value="all">Everyone (read only)</option>
                      </select>
                    </>
                  )}
                </>
              }
            />
          )}
        </QueryView>
      </Card>
      <DecisionDialog task={deciding} onClose={() => setDeciding(null)} />
    </>
  );
}
