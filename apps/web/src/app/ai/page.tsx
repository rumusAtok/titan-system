'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, ShieldAlert, User as UserIcon } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, InlineError, PageHeader, QueryView, StatusBadge, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateTime, titleCase } from '@/lib/format';

interface Source {
  type: string;
  id: string;
  title: string;
  as_of?: string | null;
  classification?: string;
}

interface Answer {
  status: 'ok' | 'insufficient_evidence' | 'unavailable' | 'refused';
  answer: string;
  generated_by: { kind: 'model' | 'deterministic'; model: string | null };
  sources: Source[];
  security_flags: string[];
  notice?: string | null;
  evidence?: string;
  tool?: { name: string; selected_by?: string; status: string } | null;
}

type Message = { role: 'user'; text: string } | { role: 'assistant'; answer: Answer } | { role: 'error'; error: unknown };

/** States plainly how an answer was produced. A deterministic summary is never presented as AI output. */
function ProvenanceBadge({ generatedBy }: { generatedBy: Answer['generated_by'] }) {
  return generatedBy.kind === 'model' ? (
    <Badge tone="info">AI-generated · {generatedBy.model}</Badge>
  ) : (
    <Badge>Deterministic summary of records · not AI-generated</Badge>
  );
}

function AnswerView({ answer }: { answer: Answer }) {
  const tone = { ok: '', insufficient_evidence: 'border-amber-300 bg-amber-50', unavailable: 'border-amber-300 bg-amber-50', refused: 'border-slate-300 bg-slate-50' }[answer.status];
  return (
    <div className={`rounded-lg border border-line p-3 ${tone}`} data-testid="ai-answer" data-status={answer.status} data-generated-by={answer.generated_by.kind}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ProvenanceBadge generatedBy={answer.generated_by} />
        {answer.status !== 'ok' && <Badge tone="warn">{titleCase(answer.status)}</Badge>}
      </div>
      <p className="whitespace-pre-wrap text-sm text-ink">{answer.answer}</p>
      {answer.notice && <p className="mt-2 text-xs text-ink-muted">{answer.notice}</p>}
      {answer.security_flags.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-800">
          <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          Security screening flagged: {answer.security_flags.map(titleCase).join(', ')}. Flagged content is not passed to a model.
        </p>
      )}
      {answer.sources.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Sources</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-xs text-ink">
            {answer.sources.map((s, i) => (
              <li key={`${s.id}-${i}`}>
                {s.title} <span className="text-ink-muted">({titleCase(s.type)}{s.as_of ? `, as of ${dateTime(s.as_of)}` : ''}{s.classification ? `, ${s.classification}` : ''})</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {answer.generated_by.kind === 'model' && answer.evidence && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-brand-700">Show the records this answer is based on</summary>
          <pre tabIndex={0} className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-ink">{answer.evidence}</pre>
        </details>
      )}
    </div>
  );
}

const SUGGESTIONS = ['Which incidents are active?', 'What is the current river level?', 'Where is the workflow backlog?', 'What must the duty officer do for a warning level alarm?', 'Give me an operations overview'];

function Chat({ disabled }: { disabled: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const ask = useMutation({
    mutationFn: (message: string) => api<Answer>('/api/ai/chat', { method: 'POST', body: { message } }),
    onMutate: (message) => setMessages((m) => [...m, { role: 'user', text: message }]),
    onSuccess: (answer) => setMessages((m) => [...m, { role: 'assistant', answer }]),
    onError: (error) => setMessages((m) => [...m, { role: 'error', error }]),
  });
  useEffect(() => {
    // Braces matter: scrollIntoView() may return a Promise, and an effect must not return one.
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [messages, ask.isPending]);

  function send(e?: FormEvent, preset?: string) {
    e?.preventDefault();
    const message = (preset ?? text).trim();
    if (message.length < 2 || ask.isPending) return;
    setText('');
    ask.mutate(message);
  }

  return (
    <Card title="Ask about operational data" description="Answers use only records you are authorised to see, through read-only tools.">
      <div className="flex max-h-[30rem] min-h-48 flex-col gap-3 overflow-y-auto" role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {messages.length === 0 && (
          <div className="text-sm text-ink-muted">
            <p>Try one of these:</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} onClick={() => send(undefined, s)} disabled={disabled}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="flex items-start gap-2 self-end">
              <p className="max-w-prose rounded-lg bg-brand-600 px-3 py-2 text-sm text-white">{m.text}</p>
              <UserIcon className="mt-1.5 h-4 w-4 shrink-0 text-ink-muted" aria-label="You" />
            </div>
          ) : m.role === 'assistant' ? (
            <div key={i} className="flex items-start gap-2">
              <Bot className="mt-1.5 h-4 w-4 shrink-0 text-ink-muted" aria-label="Assistant" />
              <div className="min-w-0 flex-1">
                <AnswerView answer={m.answer} />
              </div>
            </div>
          ) : (
            <InlineError key={i} error={m.error} />
          ),
        )}
        {ask.isPending && <p className="text-sm text-ink-muted" role="status">Looking up records…</p>}
        <div ref={end} />
      </div>
      <form onSubmit={send} className="mt-4 flex gap-2">
        <label htmlFor="ai-question" className="sr-only">Your question</label>
        <input id="ai-question" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Ask a question…" className={inputClass} disabled={disabled} autoComplete="off" />
        <Button type="submit" variant="primary" disabled={disabled || ask.isPending || text.trim().length < 2}>
          Ask
        </Button>
      </form>
      <p className="mt-2 text-xs text-ink-muted">The assistant cannot change data. To record a note on an incident it prepares a proposal that a person must approve.</p>
    </Card>
  );
}

function Reports() {
  const client = useQueryClient();
  const { hasRole } = useAuth();
  const reports = useQuery({ queryKey: ['ai', 'reports'], queryFn: () => api<any[]>('/api/ai/reports') });
  const draft = useMutation({ mutationFn: () => api('/api/ai/reports/draft', { method: 'POST', body: { report_type: 'daily_operations' } }), onSuccess: () => client.invalidateQueries({ queryKey: ['ai', 'reports'] }) });
  const review = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) => api(`/api/ai/reports/${v.id}/review`, { method: 'POST', body: { decision: v.decision } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['ai', 'reports'] }),
  });
  const canReview = hasRole('analyst', 'tenant_admin', 'incident_commander', 'department_head');
  return (
    <Card title="Report drafts" description="Drafts are generated from current records and stay drafts until a person reviews them." actions={<Button variant="primary" onClick={() => draft.mutate()} disabled={draft.isPending}>{draft.isPending ? 'Generating…' : 'Draft daily operations report'}</Button>}>
      <InlineError error={draft.error ?? review.error} />
      <QueryView query={reports} what="Report drafts" isEmpty={(d) => d.length === 0} empty={<EmptyState title="No report drafts yet" />}>
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((r) => (
              <li key={r.id} className="rounded-md border border-line">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className="font-medium text-ink">{r.title}</span>
                    <StatusBadge status={r.status} />
                    {r.generated_by === 'model' ? <Badge tone="info">AI-generated · {r.model}</Badge> : <Badge>Deterministic · not AI-generated</Badge>}
                    <span className="ml-auto text-xs text-ink-muted">requested by {r.requested_by}</span>
                  </summary>
                  <div className="border-t border-line p-3">
                    <pre tabIndex={0} className="max-h-80 overflow-auto whitespace-pre-wrap font-sans text-sm text-ink">{r.body}</pre>
                    <p className="mt-2 text-xs text-ink-muted">Sources: {r.sources.map((s: Source) => s.title).join('; ') || 'none'}</p>
                    {r.status === 'draft' && canReview && (
                      <div className="mt-3 flex gap-2">
                        <Button variant="primary" onClick={() => review.mutate({ id: r.id, decision: 'approve' })} disabled={review.isPending}>Approve</Button>
                        <Button onClick={() => review.mutate({ id: r.id, decision: 'reject' })} disabled={review.isPending}>Reject</Button>
                      </div>
                    )}
                    {r.reviewed_by && <p className="mt-2 text-xs text-ink-muted">Reviewed by {r.reviewed_by} at {dateTime(r.reviewed_at)}.</p>}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </Card>
  );
}

function Actions() {
  const client = useQueryClient();
  const actions = useQuery({ queryKey: ['ai', 'actions'], queryFn: () => api<any[]>('/api/ai/actions'), refetchInterval: 15_000 });
  const decide = useMutation({
    mutationFn: (v: { id: string; verb: 'approve' | 'reject' }) => api(`/api/ai/actions/${v.id}/${v.verb}`, { method: 'POST' }),
    onSettled: () => client.invalidateQueries({ queryKey: ['ai', 'actions'] }),
  });
  return (
    <Card title="Proposed actions" description="Changes suggested by the assistant. Nothing happens until a person approves, and then it runs with that person's permissions.">
      <InlineError error={decide.error} />
      <QueryView query={actions} what="Proposed actions" isEmpty={(d) => d.length === 0} empty={<EmptyState title="No proposals" />}>
        {(rows) => (
          <ul className="divide-y divide-line">
            {rows.map((a) => (
              <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    <span className="font-medium">{a.action === 'incident.add_note' ? 'Add note to incident' : a.action}</span>: “{a.arguments.note}”
                  </p>
                  <p className="text-xs text-ink-muted">
                    Proposed for {a.proposed_for} · {dateTime(a.created_at)}{a.decided_by ? ` · decided by ${a.decided_by}` : ''}{a.result ? ` · ${a.result}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={a.status} />
                  {a.status === 'pending' && (
                    <>
                      <Button variant="primary" onClick={() => decide.mutate({ id: a.id, verb: 'approve' })} disabled={decide.isPending}>Approve</Button>
                      <Button onClick={() => decide.mutate({ id: a.id, verb: 'reject' })} disabled={decide.isPending}>Reject</Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </Card>
  );
}

function Documents() {
  const [query, setQuery] = useState('');
  const search = useMutation({ mutationFn: (q: string) => api('/api/ai/documents/search', { method: 'POST', body: { query: q, limit: 5 } }) });
  const docs = useQuery({ queryKey: ['ai', 'documents'], queryFn: () => api<any[]>('/api/ai/documents') });
  return (
    <Card title="Reference documents" description="Approved documents you are allowed to read.">
      <form onSubmit={(e) => { e.preventDefault(); if (query.trim().length >= 2) search.mutate(query.trim()); }} className="flex gap-2">
        <label htmlFor="doc-search" className="sr-only">Search documents</label>
        <input id="doc-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search procedures and guidelines…" className={inputClass} maxLength={300} />
        <Button type="submit" disabled={search.isPending || query.trim().length < 2}>Search</Button>
      </form>
      <InlineError error={search.error} />
      {search.data && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-muted">{search.data.results.length} passage(s) · {search.data.retrieval} search</p>
          {search.data.results.map((r: any, i: number) => (
            <div key={i} className={`rounded-md border p-3 text-sm ${r.flagged ? 'border-amber-300 bg-amber-50' : 'border-line'}`}>
              <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                {r.title} <Badge>{r.classification}</Badge>
                {r.flagged && <Badge tone="warn">Flagged: contains instructions aimed at an AI model</Badge>}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-ink">{r.text}</p>
            </div>
          ))}
        </div>
      )}
      <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-muted">Library</h3>
      <QueryView query={docs} what="The document library" isEmpty={(d) => d.length === 0} empty={<p className="text-sm text-ink-muted">No documents have been approved for retrieval.</p>}>
        {(rows) => (
          <ul className="divide-y divide-line text-sm">
            {rows.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>{d.title}</span>
                <span className="flex items-center gap-2 text-xs text-ink-muted">
                  <Badge>{d.classification}</Badge>
                  {d.allowed_roles.length > 0 && <span>restricted to {d.allowed_roles.map(titleCase).join(', ')}</span>}
                  {d.flagged_chunks > 0 && <Badge tone="warn">{d.flagged_chunks} flagged passage(s)</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </QueryView>
    </Card>
  );
}

export default function AiPage() {
  const status = useQuery({ queryKey: ['ai', 'status'], queryFn: () => api('/api/ai/status'), refetchInterval: 30_000 });
  const s = status.data;
  const disabled = !s || s.mode === 'disabled';
  return (
    <>
      <PageHeader title="AI workspace" description="An optional assistant over operational data and approved documents. Core workflows and alarms do not depend on it." />
      <div className="mb-6" data-testid="ai-availability" data-mode={s?.mode ?? (status.isError ? 'unreachable' : 'loading')}>
        {status.isPending && <Card><p className="text-sm text-ink-muted">Checking availability…</p></Card>}
        {status.isError && <Card><ErrorState error={status.error} onRetry={() => void status.refetch()} what="The AI subsystem (ai profile)" /></Card>}
        {s && (
          <div className={`flex flex-wrap items-center gap-3 rounded-lg border p-4 ${s.mode === 'model' ? 'border-green-300 bg-green-50' : 'border-amber-300 bg-amber-50'}`} role="status">
            <Badge tone={s.mode === 'model' ? 'ok' : 'warn'}>{s.mode === 'model' ? 'Model available' : s.mode === 'disabled' ? 'AI switched off' : 'No model available'}</Badge>
            <p className="text-sm text-ink">{s.detail}</p>
            <p className="ml-auto text-xs text-ink-muted">Configured model: {s.chat_model} · embeddings {s.embedding_available ? 'available' : 'unavailable (lexical search)'}</p>
          </div>
        )}
      </div>
      {!status.isError && (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <Chat disabled={disabled} />
          <div className="space-y-6">
            <Reports />
            <Actions />
          </div>
          <div className="xl:col-span-2">
            <Documents />
          </div>
        </div>
      )}
    </>
  );
}
