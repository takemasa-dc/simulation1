CREATE TABLE file_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  content_type TEXT,
  file_size INTEGER NOT NULL,
  r2_object_key TEXT NOT NULL UNIQUE
);

CREATE INDEX file_submissions_submitted_at_idx ON file_submissions (submitted_at DESC, id DESC);
