CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  conversation_log TEXT NOT NULL
);

CREATE INDEX submissions_submitted_at_idx ON submissions (submitted_at, id);
