/**
 * migrate_questions_table.js
 * 
 * Expands the questions.question_type CHECK constraint to include math types.
 * SQLite doesn't support ALTER COLUMN, so we must recreate the table.
 * We turn off foreign keys to avoid cascade issues during the swap.
 */

const { getDb } = require('c:\\Users\\Madijonov Sardorbek.DESKTOP-108GLPM\\Documents\\SAT platform\\database\\db.js');

const db = getDb();

console.log('Starting migration: expanding question_type CHECK constraint...\n');

// Run everything in a transaction with FK disabled
db.exec('PRAGMA foreign_keys = OFF;');

try {
  db.exec(`
    BEGIN;

    -- 1. Rename old table
    ALTER TABLE questions RENAME TO questions_old;

    -- 2. Create new table with expanded CHECK
    CREATE TABLE questions (
      id            TEXT PRIMARY KEY,
      word          TEXT NOT NULL DEFAULT '',
      question      TEXT NOT NULL,
      context       TEXT,
      options       TEXT NOT NULL DEFAULT '[]',
      correct_answer TEXT NOT NULL,
      explanation   TEXT NOT NULL DEFAULT '',
      difficulty    TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
      category      TEXT NOT NULL DEFAULT 'vocabulary',
      question_type TEXT NOT NULL CHECK (
        question_type IN (
          'definition',
          'isolated-word',
          'passage-in-context',
          'math-multiple-choice',
          'math-grid-in'
        )
      ),
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );

    -- 3. Copy all existing data
    INSERT INTO questions
      (id, word, question, context, options, correct_answer, explanation,
       difficulty, category, question_type, is_active, created_at, updated_at)
    SELECT
      id, word, question, context, options, correct_answer, explanation,
      difficulty, category, question_type, is_active, created_at, updated_at
    FROM questions_old;

    -- 4. Drop old table
    DROP TABLE questions_old;

    -- 5. Also add requires_mastery_pass + mastery pass columns to tests/attempts if missing
    -- (safe to run even if columns already exist — they'll just error silently in the catch)
    COMMIT;
  `);

  // Add columns separately (SQLite doesn't support multiple ADD COLUMN in one statement)
  const testsInfo = db.prepare("PRAGMA table_info(tests)").all().map(r => r.name);
  if (!testsInfo.includes('requires_mastery_pass')) {
    db.exec("ALTER TABLE tests ADD COLUMN requires_mastery_pass INTEGER NOT NULL DEFAULT 0;");
    console.log('  + Added tests.requires_mastery_pass');
  }

  const attemptsInfo = db.prepare("PRAGMA table_info(test_attempts)").all().map(r => r.name);
  if (!attemptsInfo.includes('mastery_pass')) {
    db.exec("ALTER TABLE test_attempts ADD COLUMN mastery_pass INTEGER NOT NULL DEFAULT 1;");
    console.log('  + Added test_attempts.mastery_pass');
  }
  if (!attemptsInfo.includes('parent_attempt_id')) {
    db.exec("ALTER TABLE test_attempts ADD COLUMN parent_attempt_id TEXT;");
    console.log('  + Added test_attempts.parent_attempt_id');
  }

  db.exec('PRAGMA foreign_keys = ON;');

  console.log('\n✅ Migration complete! question_type now accepts math types.');
} catch (e) {
  db.exec('ROLLBACK;');
  db.exec('PRAGMA foreign_keys = ON;');
  console.error('\n❌ Migration failed:', e.message);
  process.exit(1);
}
