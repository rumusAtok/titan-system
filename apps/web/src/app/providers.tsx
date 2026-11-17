'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Shell } from '@/components/shell';
import { ApiError } from '@/lib/api';
import { AuthProvider } from '@/lib/auth';
import { WorkspaceProvider } from '@/lib/workspace';

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            // Do not hammer a service that said "no" or is down; one retry for transient faults.
            retry: (failures, error) => !(error instanceof ApiError && (error.status === 403 || error.status === 404 || error.isUnavailable)) && failures < 1,
          },
        },
      }),
  );
  return (
    <AuthProvider>
      <QueryClientProvider client={client}>
        <WorkspaceProvider>
          <Shell>{children}</Shell>
        </WorkspaceProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}
