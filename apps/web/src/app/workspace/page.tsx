'use client';

import { Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui';
import { DashboardView } from '@/components/widgets';
import { useWorkspace } from '@/lib/workspace';

/** Universal workspace: the dashboards of the tenant's active packs, in the tenant's own layout. */
export default function WorkspacePage() {
  const { info, dashboards, selected, isError } = useWorkspace();
  const current = info?.workspaces.find((w) => w.id === selected);

  return (
    <>
      <PageHeader
        title={current && current.id !== 'all' ? current.name : 'Enterprise workspace'}
        description="Dashboards of the industry packs your organisation uses. Every figure is computed by the data pipeline from stored records."
        actions={
          info && (
            <div className="flex flex-wrap gap-1" aria-label="Active industry packs">
              {info.packs.filter((p) => !p.core).map((p) => (
                <Badge key={p.id} tone="info">
                  {p.name} {p.version}
                </Badge>
              ))}
            </div>
          )
        }
      />
      {!info && !isError && <Spinner label="Loading your workspace…" />}
      {isError && (
        <Card>
          <p role="alert" className="text-sm text-amber-800">
            The workspace configuration could not be loaded (tenant-service unavailable). The menu shows the standard areas; their pages still work.
          </p>
        </Card>
      )}
      {info && dashboards.length === 0 && (
        <Card>
          <EmptyState title="No dashboards for your role">Your organisation has not activated an industry pack with dashboards for you.</EmptyState>
        </Card>
      )}
      {dashboards.map((d) => (
        <DashboardView key={d.key} dashboard={d} />
      ))}
    </>
  );
}
