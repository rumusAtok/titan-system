'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { DecisionDialog, type WorkflowTask } from '@/components/decision';
import { Badge, Button, Card, type Column, DataTable, PageHeader, QueryView, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ago, dateTime, titleCase } from '@/lib/format';

export default function InboxPage() {
  const { hasRole } = useAuth();
  const canSeeAll = hasRole('tenant_admin', 'auditor');
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [kind, setKind] = useState('');
  const [deciding, setDeciding] = useState<WorkflowTask | null>(null);
  const tasks = useQuery({ queryKey: ['workflow', 'inbox', scope], queryFn: () => api<any[]>(`/api/workflow/tasks?scope=${scope}&limit=200`), refetchInterval: 10_000 });

  const columns: Column<any>[] = [
    {
      key: 'reference', header: 'Reference', value: (t) => t.reference,
      cell: (t) => (t.subject_type === 'case' ? <Link className="font-medium text-brand-700 hover:underline" href={`/government/case/?id=${t.subject_id}`}>{t.reference}</Link> : <Link className="font-medium text-brand-700 hover:underline" href="/iot/">{t.reference}</Link>),
    },
    { key: 'title', header: 'Subject', value: (t) => t.title, cell: (t) => t.title },
    { key: 'type', header: 'Type', value: (t) => t.subject_type, cell: (t) => <Badge tone={t.subject_type === 'incident' ? 'danger' : 'info'}>{titleCase(t.subject_type)}</Badge> },
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
      <PageHeader title="Review inbox" description="Tasks waiting for a role you hold, or delegated to you. Decisions are final and recorded in the audit trail." />
      <Card padded={false}>
        <QueryView query={tasks} what="Your review inbox">
          {(rows) => (
            <DataTable
              caption="Pending workflow tasks"
              columns={columns}
              rows={kind ? rows.filter((r) => r.subject_type === kind) : rows}
              rowKey={(t) => t.id}
              filterPlaceholder="Filter by reference, subject, step…"
              emptyTitle="Nothing is waiting for you"
              toolbar={
                <>
                  <label className="sr-only" htmlFor="kind-filter">Type</label>
                  <select id="kind-filter" value={kind} onChange={(e) => setKind(e.target.value)} className={`${inputClass} w-auto`}>
                    <option value="">Cases and incidents</option>
                    <option value="case">Cases only</option>
                    <option value="incident">Incidents only</option>
                  </select>
                  {canSeeAll && (
                    <>
                      <label className="sr-only" htmlFor="inbox-scope">Scope</label>
                      <select id="inbox-scope" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} className={`${inputClass} w-auto`}>
                        <option value="mine">My tasks</option>
                        <option value="all">All pending tasks</option>
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
