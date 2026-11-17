'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { RaiseRequestDialog, RequestsTable, WorkOrdersTable } from '@/components/maintenance';
import { Button, Card, EmptyState, PageHeader, QueryView, StatusBadge } from '@/components/ui';
import { DashboardView } from '@/components/widgets';
import { api } from '@/lib/api';
import { STAFF_ROLES, useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';

/**
 * Industry page of the facilities pack. Occupants raise and follow their own
 * service requests here; staff also see buildings, all requests and the work.
 * Nothing on this page needs a device or sensor.
 */
export default function FacilitiesPage() {
  const { hasRole } = useAuth();
  const { info, dashboards } = useWorkspace();
  const [raising, setRaising] = useState(false);
  const staff = hasRole(...STAFF_ROLES);
  const active = info?.packs.some((p) => p.id === 'facilities');
  const buildings = useQuery({ queryKey: ['assets', 'list', 'facilities'], queryFn: () => api<any[]>('/api/asset/assets?pack=facilities&limit=500'), enabled: staff && !!active });
  const dashboard = dashboards.find((d) => d.key === 'facilities');

  if (info && !active) {
    return (
      <>
        <PageHeader title="Facilities" />
        <Card><EmptyState title="The facilities pack is not active for your organisation" /></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Facilities"
        description={staff ? 'Buildings and building systems, service requests, inspection findings and the work they lead to.' : 'Report a problem in a building and follow what happens to your requests.'}
        actions={<Button variant="primary" onClick={() => setRaising(true)}>Raise service request</Button>}
      />
      <div className="space-y-6">
        <RequestsTable pack="facilities" title={staff ? 'Service requests and inspection findings' : 'My requests'} />
        {staff && (
          <>
            <WorkOrdersTable pack="facilities" title="Facility work orders" />
            <Card title="Buildings and systems" padded={false}>
              <QueryView query={buildings} what="Buildings" isEmpty={(d) => d.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No buildings registered.</p>}>
                {(rows) => (
                  <ul className="divide-y divide-line">
                    {rows.map((a) => (
                      <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                        <span><Link className="font-medium text-brand-700 hover:underline" href={`/assets/?id=${a.id}`}>{a.code}</Link> {a.name} · {a.category_name}</span>
                        <span className="flex items-center gap-2 text-ink-muted"><StatusBadge status={a.status} />{titleCase(a.condition)} · next maintenance {dateTime(a.next_maintenance_due)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </QueryView>
            </Card>
          </>
        )}
        {staff && dashboard && <DashboardView dashboard={dashboard} />}
      </div>
      <RaiseRequestDialog open={raising} onClose={() => setRaising(false)} pack="facilities" />
    </>
  );
}
