CREATE TABLE room(
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Pads from before rooms existed become read-only rooms as of this migration.
INSERT INTO room (id, name, created_by, created_at, expires_at)
SELECT
    id,
    id,
    '',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000,
    CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM document;
