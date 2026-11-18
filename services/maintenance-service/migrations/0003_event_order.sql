-- Work order history entries written in one transaction (e.g. "completed" and "cost") all got the
-- same now() and were ordered by a random id. clock_timestamp() advances within a transaction,
-- so entries keep the order in which they were written. Existing rows are unchanged.
ALTER TABLE work_order_events ALTER COLUMN occurred_at SET DEFAULT clock_timestamp();
