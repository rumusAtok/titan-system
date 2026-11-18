-- Full-text search over document titles, descriptions and the text of published versions.
-- Text is extracted on upload from text/plain and text/csv content only (no PDF or OCR).

ALTER TABLE document_versions ADD COLUMN extracted_text text;
-- Which scanner checked the content: 'signature' (built-in check) or 'clamav'.
ALTER TABLE document_versions ADD COLUMN scanned_by text NOT NULL DEFAULT 'signature';

CREATE INDEX documents_fts_idx ON documents USING gin (to_tsvector('english', title || ' ' || description));
CREATE INDEX document_versions_fts_idx ON document_versions USING gin (to_tsvector('english', COALESCE(extracted_text, '')));
