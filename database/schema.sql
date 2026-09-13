-- SAT Platform Full Schema
-- Compatible with SQLite (and easily portable to PostgreSQL)

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ─────────────────────────────────────────────
--  USERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,           -- UUID
  name         TEXT NOT NULL,
  email        TEXT UNIQUE NOT NULL,
  username     TEXT UNIQUE,
  role         TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','teacher')),
  google_id    TEXT UNIQUE,                -- null for password-auth users
  password_hash TEXT,                      -- null for Google-auth users
  student_id   TEXT UNIQUE,               -- human-readable unique ID e.g. SAT-00001
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ─────────────────────────────────────────────
--  QUESTIONS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  word          TEXT NOT NULL,
  question      TEXT NOT NULL,
  context       TEXT,                      -- passage text for passage-in-context type
  options       TEXT NOT NULL,             -- JSON array of 4 strings
  correct_answer TEXT NOT NULL,            -- 'A', 'B', 'C', or 'D'
  explanation   TEXT NOT NULL,
  difficulty    TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  category      TEXT NOT NULL DEFAULT 'vocabulary',
  question_type TEXT NOT NULL CHECK (question_type IN ('definition','isolated-word','passage-in-context','math-multiple-choice','math-grid-in')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ─────────────────────────────────────────────
--  TESTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tests (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  test_type        TEXT NOT NULL DEFAULT 'vocabulary',
  duration_seconds INTEGER NOT NULL DEFAULT 2700,   -- 45 min
  question_count   INTEGER NOT NULL DEFAULT 40,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  show_explanations INTEGER NOT NULL DEFAULT 1,     -- teacher toggle
  published_at     TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ─────────────────────────────────────────────
--  TEST_QUESTIONS  (join: which questions belong to which test)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_questions (
  id             TEXT PRIMARY KEY,
  test_id        TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL REFERENCES questions(id),
  section        TEXT,
  question_order INTEGER NOT NULL
);

-- ─────────────────────────────────────────────
--  TEST_ATTEMPTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_attempts (
  id           TEXT PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES users(id),
  test_id      TEXT NOT NULL REFERENCES tests(id),
  test_type    TEXT NOT NULL DEFAULT 'vocabulary',
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  submitted_at TEXT,
  expires_at   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'in-progress' CHECK (status IN ('in-progress','submitted','expired','abandoned'))
);

-- ─────────────────────────────────────────────
--  ANSWERS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS answers (
  id              TEXT PRIMARY KEY,
  attempt_id      TEXT NOT NULL REFERENCES test_attempts(id) ON DELETE CASCADE,
  question_id     TEXT NOT NULL REFERENCES questions(id),
  selected_answer TEXT,                    -- null = unanswered
  is_correct      INTEGER,                 -- null until scored
  answered_at     TEXT
);

-- ─────────────────────────────────────────────
--  TEST_RESULTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS test_results (
  id                      TEXT PRIMARY KEY,
  attempt_id              TEXT UNIQUE NOT NULL REFERENCES test_attempts(id),
  correct_count           INTEGER NOT NULL DEFAULT 0,
  incorrect_count         INTEGER NOT NULL DEFAULT 0,
  unanswered_count        INTEGER NOT NULL DEFAULT 0,
  score                   INTEGER NOT NULL DEFAULT 0,
  accuracy                REAL NOT NULL DEFAULT 0,
  time_used               INTEGER NOT NULL DEFAULT 0,  -- seconds
  difficulty_breakdown    TEXT,                        -- JSON
  category_breakdown      TEXT,                        -- JSON
  question_type_breakdown TEXT                         -- JSON
);

-- ─────────────────────────────────────────────
--  INTEGRITY_EVENTS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integrity_events (
  id              TEXT PRIMARY KEY,
  attempt_id      TEXT NOT NULL REFERENCES test_attempts(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,    -- 'fullscreen_exit','tab_switch','visibility_hidden', etc.
  timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  question_number INTEGER
);

-- ─────────────────────────────────────────────
--  INDEXES
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_test_attempts_student ON test_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_answers_attempt        ON answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_integrity_attempt      ON integrity_events(attempt_id);
CREATE INDEX IF NOT EXISTS idx_test_questions_test    ON test_questions(test_id);
