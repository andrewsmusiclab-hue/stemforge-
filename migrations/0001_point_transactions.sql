CREATE TABLE IF NOT EXISTS point_transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL,
  job_id      TEXT,
  type        TEXT NOT NULL,
  label       TEXT NOT NULL,
  points      INTEGER NOT NULL,
  balance_after INTEGER,
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_pt_user_id   ON point_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_pt_created   ON point_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pt_job_id    ON point_transactions(job_id);
