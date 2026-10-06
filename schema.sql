-- Schema D1 cho Wifi Checker
-- Chạy 1 lần:  wrangler d1 execute <TEN_DATABASE> --file=./schema.sql
-- (lệnh trên local; thêm --remote để chạy trên production)

CREATE TABLE IF NOT EXISTS wifi_checkers (
id          TEXT PRIMARY KEY,
user_id     TEXT    NOT NULL,
username    TEXT    NOT NULL,
password    TEXT    NOT NULL,
status      TEXT    NOT NULL DEFAULT 'offline',
created_at  INTEGER NOT NULL
);

-- Mỗi user chỉ truy cập được dòng của mình (lọc bằng user_id ở mọi query)
CREATE INDEX IF NOT EXISTS idx_wifi_checkers_user ON wifi_checkers(user_id);
