'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Card, type Column, DataTable, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { REVIEWER_ROLES, useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';

const STATUSES = ['draft', 'submitted', 'in_review', 'returned', 'approved', 'rejected', 'cancelled'];

export default function ApplicationsPage() {
  const { hasRole } = useAuth();
  const router = useRouter();
  const canSeeAll = hasRole(...REVIEWER_ROLES, 'tenant_admin', 'auditor');
  const [scope, setScope] = useState<'mine' | 'all'>(canSeeAll ? 'all' : 'mine');
  const [status, setStatus] = useState('');

  const cases = useQuery({
    queryKey: ['cases', scope, status],
    queryFn: () => api<any[]>(`/api/case/cases?scope=${scope}&limit=200${status ? `&status=${status}` : ''}`),
    refetchInterval: 20_000,
  });

  const columns: Column<any>[] = [
    { key: 'reference', header: 'Reference', value: (c) => c.reference_no, cell: (c) => c.reference_no },
    { key: 'title', header: 'Title', value: (c) => c.title, cell: (c) => c.title },
    { key: 'form', header: 'Form', value: (c) => c.form_key, cell: (c) => titleCase(c.form_key) },
    { key: 'status', header: 'Status', value: (c) => c.status, cell: (c) => <StatusBadge status={c.status} /> },
    { key: 'stage', header: 'Current stage', value: (c) => c.current_stage ?? '', cell: (c) => c.current_stage ?? '—' },
    { key: 'applicant', header: 'Applicant', value: (c) => c.applicant_username, cell: (c) => c.applicant_username },
    { key: 'submitted', header: 'Submitted', value: (c) => c.submitted_at ?? '', cell: (c) => dateTime(c.submitted_at) },
    { key: 'decided', header: 'Decided', value: (c) => c.decided_at ?? '', cell: (c) => dateTime(c.decided_at), defaultHidden: true },
    { key: 'channel', header: 'Channel', value: (c) => c.channel, cell: (c) => titleCase(c.channel), defaultHidden: true },
  ];

  return (
    <>
      <PageHeader
        title="Applications"
        description={canSeeAll ? 'Applications submitted to your organisation.' : 'Your applications and their progress.'}
        actions={
          <Link href="/government/new/" className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-brand-700">
            <Plus className="h-4 w-4" aria-hidden="true" /> New application
          </Link>
        }
      />
      <Card padded={false}>
        <QueryView query={cases} what="The list of applications">
          {(rows) => (
            <DataTable
              caption="Applications"
              columns={columns}
              rows={rows}
              rowKey={(c) => c.id}
              onRowOpen={(c) => router.push(`/government/case/?id=${c.id}`)}
              filterPlaceholder="Filter by reference, title, applicant…"
              emptyTitle="No applications yet"
              toolbar={
                <>
                  <label className="sr-only" htmlFor="status-filter">
                    Status
                  </label>
                  <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} w-auto`}>
                    <option value="">All statuses</option>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {titleCase(s)}
                      </option>
                    ))}
                  </select>
                  {canSeeAll && (
                    <>
                      <label className="sr-only" htmlFor="scope-filter">
                        Scope
                      </label>
                      <select id="scope-filter" value={scope} onChange={(e) => setScope(e.target.value as 'mine' | 'all')} className={`${inputClass} w-auto`}>
                        <option value="all">All applicants</option>
                        <option value="mine">Submitted by me</option>
                      </select>
                    </>
                  )}
                </>
              }
            />
          )}
        </QueryView>
      </Card>
    </>
  );
}
