-- The shared Interview Assistant chat of each room. Clearing the chat hides
-- messages from the panel and from the model's memory but keeps them here.
CREATE TABLE assistant_message(
    id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    author TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    patch TEXT,
    notice TEXT,
    applied_by TEXT,
    cleared INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX assistant_message_room ON assistant_message(room_id, id);

-- One row per question: everything sent to and received from the model.
CREATE TABLE assistant_log(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    entry TEXT NOT NULL
);
CREATE INDEX assistant_log_room ON assistant_log(room_id, id);
