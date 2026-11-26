-- Optional Telegram worker notifications. Existing records remain valid.
ALTER TABLE workers ADD COLUMN phone TEXT NOT NULL DEFAULT '';

CREATE TABLE telegram_worker_links (
    worker_id TEXT PRIMARY KEY REFERENCES workers(id) ON UPDATE CASCADE ON DELETE CASCADE,
    chat_id TEXT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT NOT NULL DEFAULT '',
    last_name TEXT NOT NULL DEFAULT '',
    linked_at TEXT NOT NULL
);

CREATE TABLE telegram_link_tokens (
    token_hash TEXT PRIMARY KEY,
    token_encrypted TEXT NOT NULL,
    worker_id TEXT NOT NULL REFERENCES workers(id) ON UPDATE CASCADE ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    invalidated_at TEXT
);
CREATE INDEX idx_telegram_link_tokens_worker ON telegram_link_tokens(worker_id, created_at DESC);

CREATE TABLE telegram_notifications (
    id TEXT PRIMARY KEY,
    withdrawal_id TEXT NOT NULL UNIQUE REFERENCES withdrawals(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    worker_id TEXT NOT NULL REFERENCES workers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    chat_id TEXT NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_attempt_at TEXT,
    sent_at TEXT,
    telegram_message_id TEXT,
    last_error TEXT
);
CREATE INDEX idx_telegram_notifications_due ON telegram_notifications(status, next_attempt_at, created_at);
CREATE INDEX idx_telegram_notifications_worker ON telegram_notifications(worker_id, created_at DESC);

PRAGMA user_version = 3;
