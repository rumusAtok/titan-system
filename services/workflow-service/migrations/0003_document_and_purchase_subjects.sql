-- Subject types of the modules added after v3. Mirrors SUBJECT_TYPES in @titan/contracts.
-- Forward-only: registers `document` and records the owner of `purchase_request`.
INSERT INTO workflow_subject_types (key, label, owner_service, supports_return)
VALUES ('document', 'Document review', 'document-service', false)
ON CONFLICT (key) DO NOTHING;

UPDATE workflow_subject_types SET owner_service = 'procurement-service' WHERE key = 'purchase_request' AND owner_service IS NULL;
