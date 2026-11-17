'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { RequestDetail } from '@/components/maintenance';
import { Button, EmptyState, PageHeader } from '@/components/ui';

function Content() {
  const router = useRouter();
  const id = useSearchParams().get('id');
  return (
    <>
      <PageHeader title="Request" actions={<Button onClick={() => router.back()}>Back</Button>} />
      {id ? <RequestDetail id={id} /> : <EmptyState title="No request selected" />}
    </>
  );
}

export default function RequestPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}
