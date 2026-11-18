'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useWorkspace } from '@/lib/workspace';
import { Button, Card, EmptyState, InlineError, PageHeader } from './ui';

/** True/false once the workspace is known; undefined while it loads. */
export function usePackActive(packId: string): boolean | undefined {
  const { info } = useWorkspace();
  return info ? info.packs.some((p) => p.id === packId) : undefined;
}

export function PackInactive({ title, pack }: { title: string; pack: string }) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState title={`The ${pack} pack is not active for your organisation`}>A tenant administrator can activate it under Administration → Industry packs.</EmptyState>
      </Card>
    </>
  );
}

/** Reads a file chosen by the user as base64 (without the data: prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

/** A button that runs one API call, refreshes the given queries and shows its error inline. */
export function ActionButton({
  run, invalidate, children, variant = 'secondary', disabled, confirm, onDone,
}: {
  run: () => Promise<unknown>;
  invalidate: string[][];
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  confirm?: string;
  onDone?: (result: any) => void;
}) {
  const client = useQueryClient();
  const action = useMutation({
    mutationFn: run,
    onSuccess: async (result) => {
      await Promise.all(invalidate.map((queryKey) => client.invalidateQueries({ queryKey })));
      onDone?.(result);
    },
  });
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant={variant}
        disabled={disabled || action.isPending}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          action.mutate();
        }}
      >
        {action.isPending ? 'Working…' : children}
      </Button>
      <InlineError error={action.error} />
    </span>
  );
}

export function money(amount: number | string | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '—';
  return `${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
