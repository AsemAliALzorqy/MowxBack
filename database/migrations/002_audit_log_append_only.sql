-- Extend system events while keeping the existing audit history intact.
-- New actions cover generated reports and captured application errors.
ALTER TABLE audit_log RENAME TO audit_log_legacy;

CREATE TABLE audit_log (
    id                TEXT PRIMARY KEY,
    entity_type       TEXT NOT NULL CHECK (entity_type IN (
        'profit_transaction', 'profit_line', 'expense', 'withdrawal',
        'item', 'worker', 'expense_category', 'system'
    )),
    entity_id         TEXT NOT NULL,
    parent_entity_id  TEXT,
    action            TEXT NOT NULL CHECK (action IN (
        'create', 'update', 'soft_delete', 'restore', 'activate', 'deactivate',
        'import', 'backup_restore', 'database_move', 'reset', 'report_export', 'application_error'
    )),
    before_json       TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
    after_json        TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
    occurred_at_utc   TEXT NOT NULL
);

INSERT INTO audit_log (id, entity_type, entity_id, parent_entity_id, action,
    before_json, after_json, occurred_at_utc)
SELECT id, entity_type, entity_id, parent_entity_id, action,
    before_json, after_json, occurred_at_utc
FROM audit_log_legacy;

DROP TABLE audit_log_legacy;
CREATE INDEX IF NOT EXISTS idx_audit_entity_time
    ON audit_log(entity_type, entity_id, occurred_at_utc);
CREATE INDEX IF NOT EXISTS idx_audit_time
    ON audit_log(occurred_at_utc);

-- Audit history is append-only. Inserts are allowed; UPDATE and DELETE are rejected.
CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not permitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not permitted');
END;
