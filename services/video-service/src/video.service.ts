import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Principal } from '@titan/authentication';
import { type EventEnvelope, type EventPayload, Roles } from '@titan/contracts';
import { type Logger, newContext, runWithContext } from '@titan/observability';
import { Db, DomainError, EventConsumers, LOGGER, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { type CameraStatus, canTransition, checkSegment, checkStreamUrl, markerInside, retainUntil } from './rules.js';

const RETENTION_SWEEP_MS = Number(process.env.RECORDING_RETENTION_SWEEP_MS ?? 3_600_000);

/** Roles that may open a live stream (each viewing is logged with its purpose). */
export const VIEWERS = [Roles.SecurityOperator, Roles.IncidentCommander, Roles.DutyOfficer, Roles.FacilityManager, Roles.TenantAdmin];
/** Roles that register and maintain cameras and recordings. */
export const OPERATORS = [Roles.SecurityOperator, Roles.FacilityManager, Roles.TenantAdmin];
/** Roles that may read the viewing log. */
export const SESSION_AUDITORS = [Roles.SecurityOperator, Roles.TenantAdmin, Roles.Auditor];

export const RegisterCamera = z.object({
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,31}$/),
  name: z.string().trim().min(2).max(120),
  location_note: z.string().max(300).default(''),
  asset_id: z.uuid().nullable().default(null),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  stream_url: z.string().max(500).nullable().default(null),
  retention_days: z.number().int().min(1).max(3650).default(30),
  privacy_masking: z.boolean().default(false),
});

export const UpdateCamera = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  location_note: z.string().max(300).optional(),
  stream_url: z.string().max(500).nullable().optional(),
  retention_days: z.number().int().min(1).max(3650).optional(),
  privacy_masking: z.boolean().optional(),
  expected_version: z.number().int().positive(),
});

export const ChangeStatus = z.object({ status: z.enum(['online', 'offline', 'maintenance', 'decommissioned']), note: z.string().max(300).default('') });

export const StartSession = z.object({
  purpose: z.string().trim().min(5).max(300),
  incident_id: z.uuid().nullable().default(null),
});

export const RegisterRecording = z.object({
  started_at: z.iso.datetime({ offset: true }),
  ended_at: z.iso.datetime({ offset: true }),
  storage_ref: z.string().max(300).nullable().default(null),
  size_bytes: z.number().int().min(0).nullable().default(null),
});

export const CreateMarker = z.object({
  at: z.iso.datetime({ offset: true }),
  label: z.string().trim().min(2).max(120),
  note: z.string().max(1000).default(''),
  recording_id: z.uuid().nullable().default(null),
  incident_id: z.uuid().nullable().default(null),
});

export const LegalHold = z.object({ legal_hold: z.boolean() });

export interface CameraRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  location_note: string;
  asset_id: string | null;
  latitude: number | null;
  longitude: number | null;
  stream_url: string | null;
  status: CameraStatus;
  last_seen_at: Date | null;
  retention_days: number;
  privacy_masking: boolean;
  version: number;
  created_at: Date;
}

/** Everything except the stream URL, which only a logged viewing session reveals. */
const CAMERA_PUBLIC = 'id, code, name, location_note, asset_id, latitude, longitude, status, last_seen_at, retention_days, privacy_masking, version, created_at, (stream_url IS NOT NULL) AS has_stream';
const CAMERA = 'id, tenant_id, code, name, location_note, asset_id, latitude, longitude, stream_url, status, last_seen_at, retention_days, privacy_masking, version, created_at';

/**
 * Video metadata. TITAN neither stores nor analyses video: it keeps the camera register,
 * logs who opened which stream and why, records references to clips held by an external
 * video management system, and links moments in them to incidents.
 */
@Injectable()
export class VideoService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({ subjects: ['incident.created.v1'], handler: (event, q) => this.onIncident(event, q) });
    this.timer = setInterval(() => void this.expireRecordings(), RETENTION_SWEEP_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  private async camera(q: Q, id: string, lock = false): Promise<CameraRow> {
    const c = await q.maybeOne<CameraRow>(`SELECT ${CAMERA} FROM cameras WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!c) throw DomainError.notFound('camera');
    return c;
  }

  private async incidentExists(q: Q, id: string | null): Promise<void> {
    if (id && !(await q.maybeOne('SELECT 1 FROM incident_refs WHERE incident_id = $1', [id]))) throw DomainError.invalid('unknown incident');
  }

  // --- cameras ---------------------------------------------------------------------

  listCameras(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT ${CAMERA_PUBLIC},
                (SELECT count(*)::int FROM recordings r WHERE r.camera_id = c.id AND r.status = 'available') AS recordings,
                (SELECT max(started_at) FROM view_sessions v WHERE v.camera_id = c.id) AS last_viewed_at
           FROM cameras c ORDER BY code`,
      ),
    );
  }

  register(user: Principal, input: z.infer<typeof RegisterCamera>) {
    if (input.stream_url) {
      const check = checkStreamUrl(input.stream_url);
      if (!check.ok) throw DomainError.invalid(check.reason);
    }
    if ((input.latitude === null) !== (input.longitude === null)) throw DomainError.invalid('give both latitude and longitude, or neither');
    return this.db.tx(user.tenantId, async (q) => {
      if (await q.maybeOne('SELECT 1 FROM cameras WHERE code = $1', [input.code])) throw DomainError.conflict('duplicate', `camera ${input.code} already exists`);
      const c = await q.one<CameraRow>(
        `INSERT INTO cameras (tenant_id, code, name, location_note, asset_id, latitude, longitude, stream_url, retention_days, privacy_masking)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING ${CAMERA}`,
        [user.tenantId, input.code, input.name, input.location_note, input.asset_id, input.latitude, input.longitude, input.stream_url, input.retention_days, input.privacy_masking],
      );
      await this.outbox.emit(q, {
        type: 'video.camera.registered.v1',
        aggregateType: 'camera',
        aggregateId: c.id,
        tenantId: user.tenantId,
        payload: { camera_id: c.id, code: c.code, name: c.name, asset_id: c.asset_id, latitude: c.latitude, longitude: c.longitude },
      });
      const { stream_url: _hidden, ...visible } = c;
      return { ...visible, has_stream: c.stream_url !== null };
    });
  }

  getCamera(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const camera = await q.maybeOne(`SELECT ${CAMERA_PUBLIC} FROM cameras c WHERE id = $1`, [id]);
      if (!camera) throw DomainError.notFound('camera');
      const recordings = await q.query(
        'SELECT id, started_at, ended_at, storage_ref, size_bytes, retain_until, legal_hold, status, registered_by FROM recordings WHERE camera_id = $1 ORDER BY started_at DESC LIMIT 100',
        [id],
      );
      const markers = await q.query(
        `SELECT m.id, m.at, m.label, m.note, m.recording_id, m.incident_id, i.reference_no AS incident_reference, m.created_by, m.created_at
           FROM markers m LEFT JOIN incident_refs i ON i.incident_id = m.incident_id WHERE m.camera_id = $1 ORDER BY m.at DESC LIMIT 100`,
        [id],
      );
      const sessions = await q.query('SELECT id, viewer_username, purpose, incident_id, started_at, ended_at FROM view_sessions WHERE camera_id = $1 ORDER BY started_at DESC LIMIT 50', [id]);
      return { ...camera, recordings, markers, sessions };
    });
  }

  updateCamera(user: Principal, id: string, input: z.infer<typeof UpdateCamera>) {
    if (input.stream_url) {
      const check = checkStreamUrl(input.stream_url);
      if (!check.ok) throw DomainError.invalid(check.reason);
    }
    return this.db.tx(user.tenantId, async (q) => {
      const c = await this.camera(q, id, true);
      if (c.status === 'decommissioned') throw DomainError.conflict('decommissioned', 'the camera is decommissioned');
      if (c.version !== input.expected_version) throw DomainError.conflict('version_conflict', `the camera is at version ${c.version}`);
      await q.exec(
        `UPDATE cameras SET name = $2, location_note = $3, stream_url = $4, retention_days = $5, privacy_masking = $6, version = version + 1 WHERE id = $1`,
        [
          id,
          input.name ?? c.name,
          input.location_note ?? c.location_note,
          input.stream_url === undefined ? c.stream_url : input.stream_url,
          input.retention_days ?? c.retention_days,
          input.privacy_masking ?? c.privacy_masking,
        ],
      );
      return q.one(`SELECT ${CAMERA_PUBLIC} FROM cameras c WHERE id = $1`, [id]);
    });
  }

  changeStatus(user: Principal, id: string, input: z.infer<typeof ChangeStatus>) {
    return this.db.tx(user.tenantId, async (q) => {
      const c = await this.camera(q, id, true);
      if (!canTransition(c.status, input.status)) throw DomainError.conflict('invalid_transition', `a camera cannot go from ${c.status} to ${input.status}`);
      await q.exec(`UPDATE cameras SET status = $2, last_seen_at = CASE WHEN $2 = 'online' THEN now() ELSE last_seen_at END, version = version + 1 WHERE id = $1`, [id, input.status]);
      await this.outbox.emit(q, {
        type: 'video.camera.status_changed.v1',
        aggregateType: 'camera',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { camera_id: id, code: c.code, from: c.status, to: input.status },
      });
      if (input.status === 'offline' && c.status === 'online') {
        await this.outbox.emit(q, {
          type: 'notification.requested.v1',
          aggregateType: 'camera',
          aggregateId: id,
          tenantId: user.tenantId,
          payload: {
            dedupe_key: `camera-offline:${id}:${c.version}`,
            channel: 'in_app',
            category: 'video.camera_offline',
            external: false,
            recipient_user_id: null,
            recipient_role: Roles.SecurityOperator,
            recipient_address: null,
            subject: `Camera ${c.code} is offline`,
            body: `${c.name}${input.note ? `: ${input.note}` : ''}`,
            reference_type: 'camera',
            reference_id: id,
          },
        });
      }
      return { id, code: c.code, from: c.status, status: input.status };
    });
  }

  // --- viewing ---------------------------------------------------------------------

  startSession(user: Principal, cameraId: string, input: z.infer<typeof StartSession>) {
    return this.db.tx(user.tenantId, async (q) => {
      const c = await this.camera(q, cameraId);
      if (c.status !== 'online') throw DomainError.conflict('camera_unavailable', `camera ${c.code} is ${c.status}`);
      if (!c.stream_url) throw DomainError.conflict('no_stream', `camera ${c.code} has no stream configured`);
      await this.incidentExists(q, input.incident_id);
      const s = await q.one<{ id: string; started_at: Date }>(
        'INSERT INTO view_sessions (tenant_id, camera_id, viewer_id, viewer_username, purpose, incident_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, started_at',
        [user.tenantId, cameraId, user.userId, user.username, input.purpose, input.incident_id],
      );
      await this.outbox.emit(q, {
        type: 'video.session.started.v1',
        aggregateType: 'camera',
        aggregateId: cameraId,
        tenantId: user.tenantId,
        payload: { session_id: s.id, camera_id: cameraId, viewer_id: user.userId, purpose: input.purpose, incident_id: input.incident_id },
      });
      // The URL is for the viewer's own player; TITAN does not proxy or record the stream.
      return { session_id: s.id, started_at: s.started_at, camera: { id: c.id, code: c.code, name: c.name, privacy_masking: c.privacy_masking }, stream_url: c.stream_url };
    });
  }

  endSession(user: Principal, sessionId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const s = await q.maybeOne<{ id: string; viewer_id: string; ended_at: Date | null }>('SELECT id, viewer_id, ended_at FROM view_sessions WHERE id = $1 FOR UPDATE', [sessionId]);
      if (!s || s.viewer_id !== user.userId) throw DomainError.notFound('session');
      if (s.ended_at) return { id: sessionId, ended_at: s.ended_at };
      return q.one('UPDATE view_sessions SET ended_at = now() WHERE id = $1 RETURNING id, ended_at', [sessionId]);
    });
  }

  sessions(user: Principal) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT v.id, c.code AS camera_code, c.name AS camera_name, v.viewer_username, v.purpose, v.incident_id, v.started_at, v.ended_at
           FROM view_sessions v JOIN cameras c ON c.id = v.camera_id ORDER BY v.started_at DESC LIMIT 200`,
      ),
    );
  }

  // --- recordings and markers ---------------------------------------------------------

  registerRecording(user: Principal, cameraId: string, input: z.infer<typeof RegisterRecording>) {
    const started = new Date(input.started_at);
    const ended = new Date(input.ended_at);
    const check = checkSegment(started, ended);
    if (!check.ok) throw DomainError.invalid(check.reason);
    return this.db.tx(user.tenantId, async (q) => {
      const c = await this.camera(q, cameraId);
      if (c.status === 'decommissioned') throw DomainError.conflict('decommissioned', 'the camera is decommissioned');
      return q.one(
        `INSERT INTO recordings (tenant_id, camera_id, started_at, ended_at, storage_ref, size_bytes, retain_until, registered_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, camera_id, started_at, ended_at, storage_ref, size_bytes, retain_until, legal_hold, status`,
        [user.tenantId, cameraId, started, ended, input.storage_ref, input.size_bytes, retainUntil(ended, c.retention_days), user.username],
      );
    });
  }

  setLegalHold(user: Principal, recordingId: string, hold: boolean) {
    return this.db.tx(user.tenantId, async (q) => {
      const r = await q.maybeOne<{ status: string }>('SELECT status FROM recordings WHERE id = $1 FOR UPDATE', [recordingId]);
      if (!r) throw DomainError.notFound('recording');
      if (r.status === 'expired') throw DomainError.conflict('expired', 'the recording has already expired');
      return q.one('UPDATE recordings SET legal_hold = $2 WHERE id = $1 RETURNING id, legal_hold, retain_until, status', [recordingId, hold]);
    });
  }

  createMarker(user: Principal, cameraId: string, input: z.infer<typeof CreateMarker>) {
    return this.db.tx(user.tenantId, async (q) => {
      await this.camera(q, cameraId);
      await this.incidentExists(q, input.incident_id);
      const at = new Date(input.at);
      if (input.recording_id) {
        const rec = await q.maybeOne<{ started_at: Date; ended_at: Date }>('SELECT started_at, ended_at FROM recordings WHERE id = $1 AND camera_id = $2', [input.recording_id, cameraId]);
        if (!rec) throw DomainError.invalid('unknown recording for this camera');
        if (!markerInside(at, rec)) throw DomainError.invalid('the marker time is outside the recording');
      }
      const m = await q.one<{ id: string; at: Date }>(
        'INSERT INTO markers (tenant_id, camera_id, recording_id, incident_id, at, label, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, at',
        [user.tenantId, cameraId, input.recording_id, input.incident_id, at, input.label, input.note, user.username],
      );
      await this.outbox.emit(q, {
        type: 'video.marker.created.v1',
        aggregateType: 'camera',
        aggregateId: cameraId,
        tenantId: user.tenantId,
        payload: { marker_id: m.id, camera_id: cameraId, recording_id: input.recording_id, incident_id: input.incident_id, at: m.at.toISOString(), label: input.label, created_by: user.userId },
      });
      return { id: m.id, camera_id: cameraId, at: m.at, label: input.label, incident_id: input.incident_id, recording_id: input.recording_id };
    });
  }

  incidentMarkers(user: Principal, incidentId: string) {
    return this.db.tx(user.tenantId, (q) =>
      q.query(
        `SELECT m.id, m.at, m.label, m.note, m.recording_id, c.id AS camera_id, c.code AS camera_code, c.name AS camera_name, m.created_by
           FROM markers m JOIN cameras c ON c.id = m.camera_id WHERE m.incident_id = $1 ORDER BY m.at`,
        [incidentId],
      ),
    );
  }

  incidents(user: Principal) {
    return this.db.tx(user.tenantId, (q) => q.query('SELECT incident_id, reference_no, title, severity, created_at FROM incident_refs ORDER BY created_at DESC LIMIT 100'));
  }

  // --- events and retention ----------------------------------------------------------

  private async onIncident(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'incident.created.v1'>;
    await q.exec(
      'INSERT INTO incident_refs (incident_id, tenant_id, reference_no, title, severity, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (incident_id) DO NOTHING',
      [p.incident_id, event.tenant_id, p.reference_no, p.title, p.severity, p.created_at],
    );
  }

  /** Recordings past retention and not on hold: the clip reference is removed, the metadata kept. */
  async expireRecordings(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let expired = 0;
    try {
      const due = await this.db.tx(null, (q) => q.query<{ recording_id: string; tenant_id: string }>('SELECT recording_id, tenant_id FROM recordings_expired($1)', [500]));
      for (const row of due) {
        const ctx = newContext({ actor: { id: 'video-service', type: 'system' } });
        const n = await runWithContext(ctx, () =>
          this.db.tx(row.tenant_id, (q) =>
            q.exec(`UPDATE recordings SET status = 'expired', storage_ref = NULL WHERE id = $1 AND status = 'available' AND NOT legal_hold AND retain_until < current_date`, [row.recording_id]),
          ),
        );
        expired += n;
      }
      if (expired) this.logger.info({ expired }, 'recordings past retention expired');
    } catch (err) {
      this.logger.warn({ error: (err as Error).message }, 'recording retention sweep failed');
    } finally {
      this.sweeping = false;
    }
    return expired;
  }
}
