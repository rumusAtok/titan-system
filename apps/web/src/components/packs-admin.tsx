'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download } from '@/lib/api';
import { dateTime, titleCase } from '@/lib/format';
import { SchemaFields } from './fields';
import { Badge, Button, Card, Dialog, InlineError, KeyValue, QueryView, inputClass } from './ui';

/**
 * Administration of the tenant's industry packs. Every action is decided and
 * recorded by tenant-service; the services that own each capability enforce it.
 */
export function IndustryPacks() {
  const client = useQueryClient();
  const catalog = useQuery({ queryKey: ['tenant', 'packs', 'catalog'], queryFn: () => api<any[]>('/api/tenant/packs/catalog') });
  const mine = useQuery({ queryKey: ['tenant', 'packs', 'mine'], queryFn: () => api<any[]>('/api/tenant/packs') });
  const history = useQuery({ queryKey: ['tenant', 'packs', 'history'], queryFn: () => api<any[]>('/api/tenant/packs/history') });
  const [configuring, setConfiguring] = useState<any | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [restoreText, setRestoreText] = useState('');
  const [restoreResult, setRestoreResult] = useState<any | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['tenant'] });

  const change = useMutation({
    mutationFn: (a: { id: string; action: 'activate' | 'deactivate'; body?: unknown }) => api(`/api/tenant/packs/${a.id}/${a.action}`, { method: 'POST', body: a.body ?? {} }),
    onSuccess: refresh,
  });
  const saveConfig = useMutation({
    mutationFn: () => api(`/api/tenant/packs/${configuring.pack_id}/config`, { method: 'PUT', body: { config, expected_version: configuring.config_version } }),
    onSuccess: async () => {
      await refresh();
      setConfiguring(null);
    },
  });
  const restore = useMutation({
    mutationFn: (dryRun: boolean) => api('/api/tenant/packs/import', { method: 'POST', body: { document: JSON.parse(restoreText), dry_run: dryRun } }),
    onSuccess: async (result) => {
      setRestoreResult(result);
      if (!result.dry_run) await refresh();
    },
  });

  const state = new Map((mine.data ?? []).map((p) => [p.pack_id, p]));

  return (
    <div className="space-y-6">
      <Card title="Industry packs" description="A pack switches on platform capabilities and installs workflows, forms, asset categories, sensor profiles, alarm rules and dashboards. Deactivating a pack never deletes business records.">
        <QueryView query={catalog} what="The pack catalogue">
          {(packs) => (
            <ul className="divide-y divide-line">
              {packs.map((p) => {
                const s = state.get(p.id);
                const isActive = s?.status === 'active';
                return (
                  <li key={p.id} className="py-4" data-testid={`pack-${p.id}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium text-ink">
                          {p.name} <span className="text-sm font-normal text-ink-muted">· {p.industry}</span>
                        </p>
                        <p className="mt-1 max-w-3xl text-sm text-ink-muted">{p.description}</p>
                        <p className="mt-1 text-xs text-ink-muted">
                          Capabilities: {p.capabilities.length ? p.capabilities.map(titleCase).join(', ') : 'core only'} · Versions: {p.versions.map((v: any) => v.version).join(', ')}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {s && <Badge tone={isActive ? 'ok' : 'neutral'}>{isActive ? `Active ${s.version}` : `Disabled (${s.version})`}</Badge>}
                        {p.core ? (
                          <Badge tone="info">Always active</Badge>
                        ) : (
                          <>
                            {!isActive && <Button variant="primary" onClick={() => change.mutate({ id: p.id, action: 'activate' })} disabled={change.isPending}>{s ? 'Re-activate' : 'Activate'}</Button>}
                            {isActive && s.upgrade_available && <Button variant="primary" onClick={() => change.mutate({ id: p.id, action: 'activate', body: { version: p.latest_version } })} disabled={change.isPending}>Upgrade to {p.latest_version}</Button>}
                            {isActive && s.config_schema.length > 0 && <Button onClick={() => { setConfiguring(s); setConfig({ ...s.effective_config }); }}>Configure</Button>}
                            {isActive && <Button variant="danger" onClick={() => { if (window.confirm(`Deactivate ${p.name}? Its capabilities are withdrawn; no records are deleted.`)) change.mutate({ id: p.id, action: 'deactivate' }); }} disabled={change.isPending}>Deactivate</Button>}
                          </>
                        )}
                      </div>
                    </div>
                    {isActive && s.upgrade_available && (
                      <p className="mt-2 text-xs text-ink-muted">Version {p.latest_version}: {p.versions.at(-1).changes.join(' ')}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </QueryView>
        <InlineError error={change.error} />
      </Card>

      <Card title="Backup and restore of pack configuration" description="Export which packs are active, in which version, with which settings and dashboard layouts. A restore always applies to this organisation.">
        <div className="space-y-3">
          <Button onClick={() => void download('/api/tenant/packs/export', 'pack-configuration.json')}>Download configuration</Button>
          <label htmlFor="restore-doc" className="block text-sm font-medium text-ink">Configuration to restore (JSON)</label>
          <textarea id="restore-doc" className={`${inputClass} font-mono text-xs`} rows={5} value={restoreText} onChange={(e) => setRestoreText(e.target.value)} />
          <div className="flex gap-2">
            <Button onClick={() => restore.mutate(true)} disabled={!restoreText.trim() || restore.isPending}>Preview</Button>
            <Button variant="primary" onClick={() => restore.mutate(false)} disabled={!restoreText.trim() || restore.isPending}>Restore</Button>
          </div>
          <InlineError error={restore.error} />
          {restoreResult && (
            <ul className="text-sm">
              {restoreResult.actions.map((a: any) => <li key={a.pack_id}>{a.pack_id}: {titleCase(a.action)}</li>)}
              <li className="text-ink-muted">{restoreResult.dry_run ? 'Preview only: nothing was changed.' : 'Restored.'}</li>
            </ul>
          )}
        </div>
      </Card>

      <Card title="History" padded={false}>
        <QueryView query={history} what="Pack history" isEmpty={(d) => d.length === 0} empty={<p className="p-4 text-sm text-ink-muted">No changes yet.</p>}>
          {(rows) => (
            <ul className="divide-y divide-line text-sm">
              {rows.slice(0, 50).map((h) => (
                <li key={h.id} className="px-4 py-2">{dateTime(h.occurred_at)} · {h.pack_id} · {titleCase(h.action)}{h.to_version ? ` ${h.from_version && h.from_version !== h.to_version ? `${h.from_version} → ` : ''}${h.to_version}` : ''} · {h.actor}</li>
              ))}
            </ul>
          )}
        </QueryView>
      </Card>

      <Dialog
        open={configuring !== null}
        onClose={() => setConfiguring(null)}
        title={configuring ? `Configure ${configuring.name}` : ''}
        footer={<><Button onClick={() => setConfiguring(null)}>Cancel</Button><Button variant="primary" onClick={() => saveConfig.mutate()} disabled={saveConfig.isPending}>Save</Button></>}
      >
        {configuring && (
          <div className="space-y-3">
            <p className="text-xs text-ink-muted">Saving re-installs the pack's rules that use these settings (for example alarm thresholds). Running approval processes are not changed.</p>
            <SchemaFields fields={configuring.config_schema} values={config} onChange={setConfig} />
            <KeyValue items={[['Version', configuring.version], ['Last changed', dateTime(configuring.activated_at)]]} />
            <InlineError error={saveConfig.error} />
          </div>
        )}
      </Dialog>
    </div>
  );
}
