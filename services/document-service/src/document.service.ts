import { createHash } from 'node:crypto';
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { hasAnyRole, type Principal } from '@titan/authentication';
import { type EventEnvelope, type EventPayload, STAFF_ROLES } from '@titan/contracts';
import { Db, DomainError, EventConsumers, Outbox, type Q } from '@titan/platform';
import { z } from 'zod';
import { canRead, disposalBlock, RECORDS_ROLES, RETENTION_CLASSES, retainUntil, sanitizeFilename, scanContent } from './rules.js';
import { clamdScan, extractText } from './scanner.js';

const CLAMAV_HOST = process.env.CLAMAV_HOST || null;
const CLAMAV_PORT = Number(process.env.CLAMAV_PORT ?? 3310);

export const DOCUMENT_TYPES = ['procedure', 'drawing', 'certificate', 'inspection_report', 'contract', 'manual', 'record', 'other'] as const;
export const SUBJECT_TYPES = ['asset', 'incident', 'case', 'work_order', 'maintenance_request', 'purchase_order', 'site', 'camera'] as const;
export const REVIEW_WORKFLOW = process.env.DOCUMENT_REVIEW_WORKFLOW ?? 'document-review';

const role = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const link = z.object({ subject_type: z.enum(SUBJECT_TYPES), subject_id: z.string().min(1).max(100) });
const file = {
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(100),
  /** At most 5 MB once decoded. */
  content_base64: z.string().min(1).max(7_000_000),
  change_note: z.string().max(1000).default(''),
};

export const CreateDocument = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(4000).default(''),
  document_type: z.enum(DOCUMENT_TYPES),
  classification: z.enum(['public', 'internal', 'restricted']).default('internal'),
  allowed_roles: z.array(role).max(20).default([]),
  retention_class: z.enum(RETENTION_CLASSES.map((r) => r.key) as [string, ...string[]]).default('operational-3y'),
  requires_review: z.boolean().default(true),
  links: z.array(link).max(20).default([]),
  ...file,
});

export const AddVersion = z.object(file);
export const AddLink = link;
export const LegalHold = z.object({ legal_hold: z.boolean(), reason: z.string().trim().min(3).max(500) });

export const ListDocuments = z.object({
  q: z.string().max(100).optional(),
  /** Full-text search over titles, descriptions and the text of published versions. */
  text: z.string().trim().min(2).max(200).optional(),
  document_type: z.enum(DOCUMENT_TYPES).optional(),
  subject_type: z.enum(SUBJECT_TYPES).optional(),
  subject_id: z.string().max(100).optional(),
  status: z.enum(['active', 'disposed']).default('active'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export interface DocumentRow {
  id: string;
  tenant_id: string;
  reference_no: string;
  title: string;
  description: string;
  document_type: string;
  classification: 'public' | 'internal' | 'restricted';
  allowed_roles: string[];
  retention_class: string;
  requires_review: boolean;
  status: 'active' | 'disposed';
  current_version_id: string | null;
  legal_hold: boolean;
  legal_hold_reason: string | null;
  retain_until: string | null;
  created_by: string;
  created_by_id: string;
  created_at: Date;
  disposed_at: Date | null;
  disposed_by: string | null;
  version: number;
}

export interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  status: 'draft' | 'in_review' | 'published' | 'rejected' | 'superseded' | 'disposed';
  change_note: string;
  scan_result: string;
  uploaded_by: string;
  uploaded_by_id: string;
  uploaded_at: Date;
  published_at: Date | null;
}

const DOC = `id, tenant_id, reference_no, title, description, document_type, classification, allowed_roles, retention_class, requires_review, status,
  current_version_id, legal_hold, legal_hold_reason, retain_until::text AS retain_until, created_by, created_by_id, created_at, disposed_at, disposed_by, version`;
const DOC_D = DOC.split(',').map((c) => `d.${c.trim()}`).join(', ');
const VER = 'id, document_id, version, filename, content_type, size_bytes, sha256, status, change_note, scan_result, scanned_by, uploaded_by, uploaded_by_id, uploaded_at, published_at';

/**
 * Controlled documents. A document has versions; a version is a draft until it is
 * published, directly by a records manager or through the `document-review` workflow.
 * Retention classes set the earliest disposal date; legal hold blocks disposal.
 * Disposal removes the content and keeps the metadata as the record that it happened.
 */
@Injectable()
export class DocumentService implements OnApplicationBootstrap {
  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Outbox) private readonly outbox: Outbox,
    @Inject(EventConsumers) private readonly consumers: EventConsumers,
  ) {}

  onApplicationBootstrap(): void {
    this.consumers.register({ subjects: ['workflow.instance.completed.v1'], handler: (event, q) => this.onReviewCompleted(event, q) });
  }

  // --- helpers ---------------------------------------------------------------

  private reader(user: Principal) {
    return { roles: user.roles, staff: hasAnyRole(user, STAFF_ROLES) };
  }

  private log(q: Q, doc: Pick<DocumentRow, 'id' | 'tenant_id'>, type: string, message: string, actor: string | null) {
    return q.exec('INSERT INTO document_events (tenant_id, document_id, entry_type, message, actor) VALUES ($1, $2, $3, $4, $5)', [doc.tenant_id, doc.id, type, message, actor]);
  }

  /** Loads a document the caller may read. Anything else answers like a missing document. */
  private async load(q: Q, user: Principal, id: string, lock = false): Promise<DocumentRow> {
    const doc = await q.maybeOne<DocumentRow>(`SELECT ${DOC} FROM documents WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    if (!doc || !canRead(doc, this.reader(user))) throw DomainError.notFound('document');
    return doc;
  }

  /**
   * Built-in type and EICAR check, then (when configured) the ClamAV daemon. A configured scanner
   * that cannot be reached refuses the upload: content is never stored unscanned.
   */
  private async decode(input: { content_base64: string; content_type: string }): Promise<{ content: Buffer; scan: string; scannedBy: string }> {
    const content = Buffer.from(input.content_base64, 'base64');
    const scan = scanContent(input.content_type, content);
    if (!scan.ok) throw DomainError.invalid(`the file was refused: ${scan.reason}`);
    if (!CLAMAV_HOST) return { content, scan: scan.result, scannedBy: 'signature' };
    let result;
    try {
      result = await clamdScan(CLAMAV_HOST, CLAMAV_PORT, content);
    } catch (err) {
      throw new DomainError(503, 'scanner_unavailable', `the virus scanner is not available, so the file was not accepted (${(err as Error).message})`);
    }
    if (!result.clean) throw DomainError.invalid(`the file was refused: malware detected by ClamAV (${result.signature})`);
    return { content, scan: `${scan.result}; ClamAV: clean`, scannedBy: 'clamav' };
  }

  private async insertVersion(q: Q, user: Principal, doc: Pick<DocumentRow, 'id' | 'tenant_id'>, input: { filename: string; content_type: string; content_base64: string; change_note: string }) {
    const { content, scan, scannedBy } = await this.decode(input);
    const { next } = await q.one<{ next: number }>('SELECT COALESCE(max(version), 0) + 1 AS next FROM document_versions WHERE document_id = $1', [doc.id]);
    const filename = sanitizeFilename(input.filename);
    const version = await q.one<VersionRow>(
      `INSERT INTO document_versions (tenant_id, document_id, version, filename, content_type, size_bytes, sha256, content, change_note, scan_result, uploaded_by, uploaded_by_id,
                                      extracted_text, scanned_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING ${VER}`,
      [
        doc.tenant_id, doc.id, next, filename, input.content_type, content.length, createHash('sha256').update(content).digest('hex'), content, input.change_note, scan,
        user.username, user.userId, extractText(input.content_type, content), scannedBy,
      ],
    );
    await this.log(q, doc, 'version_added', `Version ${version.version} uploaded (${filename}, ${content.length} bytes)`, user.username);
    await this.outbox.emit(q, {
      type: 'document.version.added.v1',
      aggregateType: 'document',
      aggregateId: doc.id,
      tenantId: doc.tenant_id,
      payload: { document_id: doc.id, version_id: version.id, version: version.version, filename, content_type: version.content_type, size_bytes: version.size_bytes, sha256: version.sha256, uploaded_by: user.userId },
    });
    return version;
  }

  /** Makes a version the published one; the previously published version is superseded. */
  private async publish(q: Q, doc: DocumentRow, version: Pick<VersionRow, 'id' | 'version'>, actor: string | null): Promise<void> {
    await q.exec(`UPDATE document_versions SET status = 'superseded' WHERE document_id = $1 AND status = 'published'`, [doc.id]);
    await q.exec(`UPDATE document_versions SET status = 'published', published_at = now() WHERE id = $1`, [version.id]);
    // Retention runs from the latest publication.
    await q.exec('UPDATE documents SET current_version_id = $2, retain_until = $3, version = version + 1, updated_at = now() WHERE id = $1', [
      doc.id,
      version.id,
      retainUntil(doc.retention_class, new Date()),
    ]);
    await this.log(q, doc, 'published', `Version ${version.version} published`, actor);
    await this.outbox.emit(q, {
      type: 'document.version.published.v1',
      aggregateType: 'document',
      aggregateId: doc.id,
      tenantId: doc.tenant_id,
      payload: { document_id: doc.id, version_id: version.id, version: version.version, approved: true },
    });
  }

  private async requestReview(q: Q, user: Principal, doc: DocumentRow, version: VersionRow): Promise<void> {
    await q.exec(`UPDATE document_versions SET status = 'in_review' WHERE id = $1`, [version.id]);
    await this.log(q, doc, 'submitted', `Version ${version.version} submitted for review`, user.username);
    await this.outbox.emit(q, {
      type: 'workflow.start.requested.v1',
      aggregateType: 'document',
      aggregateId: doc.id,
      tenantId: doc.tenant_id,
      payload: {
        subject_type: 'document',
        // One process per version under review: the subject id is the version id.
        subject_id: version.id,
        workflow_key: REVIEW_WORKFLOW,
        reference: `${doc.reference_no} v${version.version}`,
        title: doc.title,
        requester_id: user.userId,
        context: { document_type: doc.document_type, classification: doc.classification, version: version.version },
      },
    });
  }

  // --- commands --------------------------------------------------------------

  create(user: Principal, input: z.infer<typeof CreateDocument>) {
    if (input.classification === 'restricted' && input.allowed_roles.length === 0) throw DomainError.invalid('a restricted document needs at least one allowed role');
    return this.db.tx(user.tenantId, async (q) => {
      const year = new Date().getUTCFullYear();
      const { last_no } = await q.one<{ last_no: number }>(
        `INSERT INTO document_counters (tenant_id, year, last_no) VALUES ($1, $2, 1)
         ON CONFLICT (tenant_id, year) DO UPDATE SET last_no = document_counters.last_no + 1 RETURNING last_no`,
        [user.tenantId, year],
      );
      const doc = await q.one<DocumentRow>(
        `INSERT INTO documents (tenant_id, reference_no, title, description, document_type, classification, allowed_roles, retention_class, requires_review,
                                retain_until, created_by, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING ${DOC}`,
        [
          user.tenantId,
          `DOC-${year}-${String(last_no).padStart(6, '0')}`,
          input.title,
          input.description,
          input.document_type,
          input.classification,
          input.allowed_roles,
          input.retention_class,
          input.requires_review,
          retainUntil(input.retention_class, new Date()),
          user.username,
          user.userId,
        ],
      );
      for (const l of input.links) {
        await q.exec('INSERT INTO document_links (tenant_id, document_id, subject_type, subject_id, linked_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [
          user.tenantId,
          doc.id,
          l.subject_type,
          l.subject_id,
          user.username,
        ]);
      }
      await this.log(q, doc, 'created', `Document created (${doc.document_type}, ${doc.classification}, retention ${doc.retention_class})`, user.username);
      await this.outbox.emit(q, {
        type: 'document.created.v1',
        aggregateType: 'document',
        aggregateId: doc.id,
        tenantId: user.tenantId,
        payload: {
          document_id: doc.id,
          reference_no: doc.reference_no,
          title: doc.title,
          document_type: doc.document_type,
          classification: doc.classification,
          retention_class: doc.retention_class,
          links: input.links,
          created_by: user.userId,
        },
      });
      const version = await this.insertVersion(q, user, doc, input);
      return { ...doc, versions: [version] };
    });
  }

  addVersion(user: Principal, id: string, input: z.infer<typeof AddVersion>) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id, true);
      if (doc.status === 'disposed') throw DomainError.conflict('invalid_state', 'a disposed document cannot get new versions');
      if (!hasAnyRole(user, STAFF_ROLES)) throw DomainError.forbidden('only staff may add versions');
      return this.insertVersion(q, user, doc, input);
    });
  }

  /** Submits a draft version for review, or publishes it directly when the document does not require review. */
  submit(user: Principal, id: string, versionNo: number) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id, true);
      if (doc.status === 'disposed') throw DomainError.conflict('invalid_state', 'the document has been disposed of');
      const version = await q.maybeOne<VersionRow>(`SELECT ${VER} FROM document_versions WHERE document_id = $1 AND version = $2 FOR UPDATE`, [id, versionNo]);
      if (!version) throw DomainError.notFound('document version');
      if (version.status !== 'draft') throw DomainError.conflict('invalid_state', `version ${versionNo} is ${version.status}`);
      if (version.uploaded_by_id !== user.userId && !hasAnyRole(user, RECORDS_ROLES)) throw DomainError.forbidden('only the uploader or a records manager may submit a version');
      if (doc.requires_review) {
        if (await q.maybeOne(`SELECT 1 FROM document_versions WHERE document_id = $1 AND status = 'in_review'`, [id])) {
          throw DomainError.conflict('review_in_progress', 'another version of this document is in review');
        }
        await this.requestReview(q, user, doc, version);
        return { document_id: id, version: versionNo, status: 'in_review' };
      }
      if (!hasAnyRole(user, RECORDS_ROLES)) throw DomainError.forbidden('publishing without review needs the records manager role');
      await this.publish(q, doc, version, user.username);
      return { document_id: id, version: versionNo, status: 'published' };
    });
  }

  addLink(user: Principal, id: string, input: z.infer<typeof AddLink>) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id);
      await q.exec('INSERT INTO document_links (tenant_id, document_id, subject_type, subject_id, linked_by) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [
        user.tenantId,
        doc.id,
        input.subject_type,
        input.subject_id,
        user.username,
      ]);
      await this.log(q, doc, 'linked', `Linked to ${input.subject_type} ${input.subject_id}`, user.username);
      return { document_id: id, ...input };
    });
  }

  removeLink(user: Principal, id: string, subjectType: string, subjectId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id);
      const removed = await q.exec('DELETE FROM document_links WHERE document_id = $1 AND subject_type = $2 AND subject_id = $3', [doc.id, subjectType, subjectId]);
      if (removed) await this.log(q, doc, 'unlinked', `Link to ${subjectType} ${subjectId} removed`, user.username);
      return { removed: removed > 0 };
    });
  }

  setLegalHold(user: Principal, id: string, input: z.infer<typeof LegalHold>) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id, true);
      if (doc.status === 'disposed') throw DomainError.conflict('invalid_state', 'the document has been disposed of');
      const updated = await q.one<DocumentRow>(
        `UPDATE documents SET legal_hold = $2, legal_hold_reason = $3, version = version + 1, updated_at = now() WHERE id = $1 RETURNING ${DOC}`,
        [id, input.legal_hold, input.legal_hold ? input.reason : null],
      );
      await this.log(q, doc, input.legal_hold ? 'legal_hold_set' : 'legal_hold_released', input.reason, user.username);
      await this.outbox.emit(q, {
        type: 'document.legal_hold.changed.v1',
        aggregateType: 'document',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { document_id: id, legal_hold: input.legal_hold, changed_by: user.userId, reason: input.reason },
      });
      return updated;
    });
  }

  /**
   * Disposal: removes the content of every version. The metadata, the events and the
   * audit record remain as evidence that the record existed and was disposed of.
   */
  dispose(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id, true);
      const block = disposalBlock(doc, new Date());
      if (block) {
        const message = {
          legal_hold: 'the document is under legal hold',
          retention_not_expired: `the retention period runs until ${doc.retain_until}`,
          permanent: 'the document is kept permanently',
          already_disposed: 'the document has already been disposed of',
        }[block];
        throw DomainError.conflict(`disposal_blocked_${block}`, message);
      }
      const removed = await q.exec(`UPDATE document_versions SET content = NULL, extracted_text = NULL, status = 'disposed' WHERE document_id = $1`, [id]);
      const updated = await q.one<DocumentRow>(
        `UPDATE documents SET status = 'disposed', current_version_id = NULL, disposed_at = now(), disposed_by = $2, version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING ${DOC}`,
        [id, user.username],
      );
      await this.log(q, doc, 'disposed', `Content of ${removed} version(s) disposed of under retention class ${doc.retention_class}`, user.username);
      await this.outbox.emit(q, {
        type: 'document.disposed.v1',
        aggregateType: 'document',
        aggregateId: id,
        tenantId: user.tenantId,
        payload: { document_id: id, reference_no: doc.reference_no, retention_class: doc.retention_class, disposed_by: user.userId, versions_removed: removed },
      });
      return updated;
    });
  }

  // --- queries ---------------------------------------------------------------

  list(user: Principal, query: z.infer<typeof ListDocuments>) {
    return this.db.tx(user.tenantId, async (q) => {
      const params: unknown[] = [query.status];
      const where = ['d.status = $1'];
      if (query.document_type) {
        params.push(query.document_type);
        where.push(`d.document_type = $${params.length}`);
      }
      if (query.q) {
        params.push(`%${query.q.replace(/[%_\\]/g, '\\$&')}%`);
        where.push(`(d.title ILIKE $${params.length} OR d.reference_no ILIKE $${params.length})`);
      }
      // Full text: the document's own words, or the text of its PUBLISHED version (drafts are not searchable).
      let rank = '0';
      if (query.text) {
        params.push(query.text);
        const t = `websearch_to_tsquery('english', $${params.length})`;
        where.push(`(to_tsvector('english', d.title || ' ' || d.description) @@ ${t} OR to_tsvector('english', COALESCE(cv.extracted_text, '')) @@ ${t})`);
        rank = `ts_rank(to_tsvector('english', d.title || ' ' || d.description || ' ' || COALESCE(cv.extracted_text, '')), ${t})`;
      }
      if (query.subject_type && query.subject_id) {
        params.push(query.subject_type, query.subject_id);
        where.push(`EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = d.id AND l.subject_type = $${params.length - 1} AND l.subject_id = $${params.length})`);
      }
      params.push(query.limit);
      const rows = await q.query<DocumentRow & { current_version: number | null; latest_version: number; latest_status: string }>(
        `SELECT ${DOC_D},
                cv.version AS current_version,
                (SELECT max(version) FROM document_versions v WHERE v.document_id = d.id) AS latest_version,
                (SELECT status FROM document_versions v WHERE v.document_id = d.id ORDER BY version DESC LIMIT 1) AS latest_status,
                ${rank} AS rank,
                ${query.text ? `ts_headline('english', COALESCE(cv.extracted_text, d.title || ' ' || d.description), websearch_to_tsquery('english', $${params.indexOf(query.text) + 1}), 'MaxWords=18, MinWords=6, StartSel=«, StopSel=»')` : 'NULL'} AS snippet
           FROM documents d LEFT JOIN document_versions cv ON cv.id = d.current_version_id
          WHERE ${where.join(' AND ')}
          ORDER BY ${query.text ? 'rank DESC, ' : ''}d.created_at DESC LIMIT $${params.length}`,
        params,
      );
      // Classification is enforced per document; a document the caller may not read is not listed at all.
      return rows.filter((d) => canRead(d, this.reader(user)));
    });
  }

  /** The document a version belongs to (review tasks name the version). Same read rules as the document. */
  byVersion(user: Principal, versionId: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const v = await q.maybeOne<{ document_id: string; version: number }>('SELECT document_id, version FROM document_versions WHERE id = $1', [versionId]);
      if (!v) throw DomainError.notFound('document version');
      await this.load(q, user, v.document_id);
      return { document_id: v.document_id, version: v.version };
    });
  }

  get(user: Principal, id: string) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id);
      const versions = await q.query<VersionRow>(`SELECT ${VER} FROM document_versions WHERE document_id = $1 ORDER BY version DESC`, [id]);
      const links = await q.query('SELECT subject_type, subject_id, linked_by, linked_at FROM document_links WHERE document_id = $1 ORDER BY linked_at', [id]);
      const events = await q.query('SELECT entry_type, message, actor, occurred_at FROM document_events WHERE document_id = $1 ORDER BY occurred_at, id', [id]);
      return { ...doc, disposal_block: disposalBlock(doc, new Date()), versions, links, events };
    });
  }

  /** Content of a version. Drafts and versions in review are visible to their uploader and to records managers only. */
  content(user: Principal, id: string, versionNo: number) {
    return this.db.tx(user.tenantId, async (q) => {
      const doc = await this.load(q, user, id);
      const v = await q.maybeOne<VersionRow & { content: Buffer | null }>(`SELECT ${VER}, content FROM document_versions WHERE document_id = $1 AND version = $2`, [id, versionNo]);
      if (!v) throw DomainError.notFound('document version');
      const unpublished = v.status === 'draft' || v.status === 'in_review' || v.status === 'rejected';
      if (unpublished && v.uploaded_by_id !== user.userId && !hasAnyRole(user, RECORDS_ROLES)) throw DomainError.notFound('document version');
      if (!v.content) throw new DomainError(410, 'disposed', 'the content of this document has been disposed of');
      return { filename: v.filename, content_type: v.content_type, content: v.content, sha256: v.sha256, reference_no: doc.reference_no };
    });
  }

  retentionClasses() {
    return RETENTION_CLASSES;
  }

  summary(user: Principal) {
    return this.db.tx(user.tenantId, async (q) => ({
      by_type: await q.query(`SELECT document_type, count(*)::int AS count FROM documents WHERE status = 'active' GROUP BY 1 ORDER BY 1`),
      in_review: (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM document_versions WHERE status = 'in_review'`)).n,
      legal_hold: (await q.one<{ n: number }>(`SELECT count(*)::int AS n FROM documents WHERE legal_hold AND status = 'active'`)).n,
      disposable: (await q.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM documents WHERE status = 'active' AND NOT legal_hold AND retain_until IS NOT NULL AND retain_until <= current_date`,
      )).n,
    }));
  }

  // --- events ----------------------------------------------------------------

  /** The review process of a version ended: publish it, or mark it rejected. */
  private async onReviewCompleted(event: EventEnvelope, q: Q): Promise<void> {
    const p = event.payload as EventPayload<'workflow.instance.completed.v1'>;
    if (p.subject_type !== 'document') return;
    const version = await q.maybeOne<VersionRow>(`SELECT ${VER} FROM document_versions WHERE id = $1 FOR UPDATE`, [p.subject_id]);
    if (!version || version.status !== 'in_review') return;
    const doc = await q.one<DocumentRow>(`SELECT ${DOC} FROM documents WHERE id = $1 FOR UPDATE`, [version.document_id]);
    if (p.outcome === 'approved' && doc.status === 'active') {
      await this.publish(q, doc, version, null);
      return;
    }
    await q.exec(`UPDATE document_versions SET status = $2 WHERE id = $1`, [version.id, p.outcome === 'approved' ? 'draft' : 'rejected']);
    await this.log(q, doc, 'review_ended', `Review of version ${version.version} ended: ${p.outcome}`, null);
    if (p.outcome === 'rejected') {
      await this.outbox.emit(q, {
        type: 'document.version.published.v1',
        aggregateType: 'document',
        aggregateId: doc.id,
        tenantId: doc.tenant_id,
        payload: { document_id: doc.id, version_id: version.id, version: version.version, approved: false },
      });
    }
  }
}
