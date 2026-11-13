'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Button, Dialog, Field, InlineError, inputClass } from './ui';

export interface WorkflowTask {
  id: string;
  stage_key: string;
  stage_name: string;
  role: string;
  subject_type: 'case' | 'incident';
  subject_id: string;
  reference: string;
  title: string;
}

/**
 * Records a decision on a workflow task. Used for case reviews and for
 * incident response steps; workflow-service decides whether the caller may act.
 */
export function DecisionDialog({ task, onClose }: { task: WorkflowTask | null; onClose: () => void }) {
  const client = useQueryClient();
  const [comment, setComment] = useState('');
  const isIncident = task?.subject_type === 'incident';

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject' | 'return') =>
      api(`/api/workflow/tasks/${task!.id}/decision`, {
        method: 'POST',
        body: { decision, comment: comment.trim() || undefined },
        // Makes an accidental double submission harmless.
        headers: { 'idempotency-key': `ui-${task!.id}-${decision}` },
      }),
    onSuccess: async () => {
      setComment('');
      await Promise.all(['workflow', 'cases', 'case', 'incident', 'incidents', 'notifications'].map((k) => client.invalidateQueries({ queryKey: [k] })));
      onClose();
    },
  });

  function close() {
    decide.reset();
    setComment('');
    onClose();
  }

  const needsComment = !comment.trim();
  return (
    <Dialog
      open={task !== null}
      onClose={close}
      title={task ? `${task.stage_name}: ${task.reference}` : ''}
      footer={
        <>
          <Button onClick={close} disabled={decide.isPending}>
            Cancel
          </Button>
          {!isIncident && (
            <>
              <Button onClick={() => decide.mutate('return')} disabled={decide.isPending || needsComment} title={needsComment ? 'A comment is required to return an application' : undefined}>
                Return for changes
              </Button>
              <Button variant="danger" onClick={() => decide.mutate('reject')} disabled={decide.isPending || needsComment} title={needsComment ? 'A comment is required to reject' : undefined}>
                Reject
              </Button>
            </>
          )}
          <Button variant="primary" onClick={() => decide.mutate('approve')} disabled={decide.isPending}>
            {isIncident ? (task?.stage_key === 'acknowledge' ? 'Acknowledge' : 'Mark resolved') : 'Approve'}
          </Button>
        </>
      }
    >
      {task && (
        <div className="space-y-3">
          <p className="text-sm text-ink">{task.title}</p>
          <p className="text-xs text-ink-muted">You are acting in the role required for this step. The decision is recorded with your name and cannot be changed afterwards.</p>
          <Field label="Comment" hint={isIncident ? 'Optional.' : 'Required when rejecting or returning.'}>
            {(props) => <textarea {...props} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} className={inputClass} maxLength={2000} />}
          </Field>
          <InlineError error={decide.error} />
        </div>
      )}
    </Dialog>
  );
}
