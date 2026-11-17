'use client';

import { useState } from 'react';
import { RaiseRequestDialog, RequestsTable, WorkOrdersTable } from '@/components/maintenance';
import { Button, PageHeader } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { useWorkspace } from '@/lib/workspace';

/** Maintenance across every industry pack that provides it; an industry workspace narrows it to that pack. */
export default function MaintenancePage() {
  const { hasRole } = useAuth();
  const { selected } = useWorkspace();
  const [raising, setRaising] = useState(false);
  const pack = selected !== 'all' ? selected : undefined;
  return (
    <>
      <PageHeader
        title="Maintenance"
        description="Requests go through the approval process their type names; an approved request becomes a work order."
        actions={<Button variant="primary" onClick={() => setRaising(true)}>Raise request</Button>}
      />
      <div className="space-y-6">
        {hasRole('maintenance_technician') && <WorkOrdersTable mine pack={pack} title="My work orders" />}
        <WorkOrdersTable pack={pack} title="Work orders" />
        <RequestsTable pack={pack} title="Requests" />
      </div>
      <RaiseRequestDialog open={raising} onClose={() => setRaising(false)} pack={pack} />
    </>
  );
}
