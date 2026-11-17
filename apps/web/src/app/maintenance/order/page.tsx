'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { WorkOrderDetail } from '@/components/maintenance';
import { Button, EmptyState, PageHeader } from '@/components/ui';

function Content() {
  const router = useRouter();
  const id = useSearchParams().get('id');
  return (
    <>
      <PageHeader title="Work order" actions={<Button onClick={() => router.back()}>Back</Button>} />
      {id ? <WorkOrderDetail id={id} /> : <EmptyState title="No work order selected" />}
    </>
  );
}

export default function WorkOrderPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}
