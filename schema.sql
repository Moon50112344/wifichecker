CREATE TABLE IF NOT EXISTS wifi_checkers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wifi_checkers_user
ON wifi_checkers(user_id);
