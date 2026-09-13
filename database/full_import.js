/**
 * full_import.js  —  Run from the SAT platform root directory:
 *   node database/full_import.js
 *
 * This script:
 *   1. Migrates the questions table to allow math question types
 *   2. Cleans any existing math tests
 *   3. Imports all 26 chapters from the HTML files
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getDb } = require('./db.js');

const SOURCE_DIR = "c:\\Users\\Madijonov Sardorbek.DESKTOP-108GLPM\\Downloads\\Telegram Desktop";

const CHAPTERS = [
  { file: "exponents-and-radicals.html",             n:  1, title: "Exponents & Radicals" },
  { file: "expressions (2).html",                    n:  2, title: "Expressions" },
  { file: "manipulating-solving-equations (1).html", n:  3, title: "Manipulating & Solving Equations" },
  { file: "other-types-of-equation-questions.html",  n:  4, title: "Other Types of Equation Questions" },
  { file: "functions (1).html",                      n:  5, title: "Functions" },
  { file: "lines-and-linear-relationships.html",     n:  6, title: "Lines & Linear Relationships" },
  { file: "linear-models.html",                      n:  7, title: "Interpreting Linear Equations & Models" },
  { file: "percent.html",                            n:  8, title: "Percent" },
  { file: "exponential-vs-linear-growth.html",       n:  9, title: "Exponential vs. Linear Growth" },
  { file: "rates-conversions-ratios (4).html",       n: 10, title: "Rates, Conversions & Ratios" },
  { file: "word-problems-sat-guide (3).html",        n: 11, title: "Word Problems" },
  { file: "quadratic-equations-sat-guide.html",      n: 12, title: "Quadratic Equations" },
  { file: "systems-of-equations (1).html",           n: 13, title: "Systems of Equations" },
  { file: "inequalities.html",                       n: 14, title: "Inequalities" },
  { file: "function-transformations (1).html",       n: 15, title: "Function Transformations" },
  { file: "quadratic-functions.html",                n: 16, title: "Quadratic Functions" },
  { file: "angles (1).html",                         n: 17, title: "Angles" },
  { file: "triangles-sat-guide.html",                n: 18, title: "Triangles" },
  { file: "circles (1).html",                        n: 19, title: "Circles" },
  { file: "radians.html",                            n: 20, title: "Radians" },
  { file: "trigonometry.html",                       n: 21, title: "Trigonometry" },
  { file: "area-perimeter-volume-sat-guide.html",    n: 22, title: "Area, Perimeter & Volume" },
  { file: "reading-data.html",                       n: 23, title: "Reading Data" },
  { file: "probability.html",                        n: 24, title: "Probability" },
  { file: "statistics-1.html",                       n: 25, title: "Statistics I" },
  { file: "statistics-ii (1).html",                  n: 26, title: "Statistics II" },
];

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function shuffleOpts(opts, correctIdx) {
  const arr = opts.map((v, i) => ({ v, c: i === correctIdx }));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return {
    shuffled:  arr.map(x => x.v),
    newLetter: 'ABCD'[arr.findIndex(x => x.c)],
  };
}

function parseChapter(file, n) {
  const fp = path.join(SOURCE_DIR, file);
  if (!fs.existsSync(fp)) return null;

  const html = fs.readFileSync(fp, 'utf8');

  // ── Extract examples and quiz arrays from embedded JS ──────────
  let examples = [], quiz = [];
  try {
    const em = html.match(/const\s+examples\s*=\s*(\[[\s\S]*?\]);\s*\n/);
    if (em) examples = eval(em[1]);              // trusted user-supplied content
  } catch (_) {}
  try {
    const qm = html.match(/const\s+quiz\s*=\s*(\[[\s\S]*?\]);\s*\n/);
    if (qm) quiz = eval(qm[1]);
  } catch (_) {}

  // ── Build lesson context block (formulas + examples) ───────────
  const fmaths  = [...html.matchAll(/class="fmath">([\s\S]*?)<\/div>/g)].map(m => m[1].trim());
  const flabels = [...html.matchAll(/class="flabel">([\s\S]*?)<\/div>/g)].map(m => m[1].trim());

  let ctx = `<div style="font-family:inherit">`;
  ctx += `<h3 style="color:#1a56db;margin:0 0 12px;font-size:16px">Chapter ${n} — Formulas & Key Concepts</h3>`;

  if (fmaths.length) {
    ctx += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:8px;margin-bottom:18px">`;
    fmaths.forEach((fm, i) => {
      ctx += `<div style="background:#f0f4ff;border:1px solid #c7d7fd;border-radius:6px;padding:10px 12px">`;
      if (flabels[i]) ctx += `<div style="font-size:11px;color:#6b7280;margin-bottom:4px">${flabels[i]}</div>`;
      ctx += `<div style="font-size:15px">${fm}</div></div>`;
    });
    ctx += `</div>`;
  }

  if (examples.length) {
    ctx += `<h3 style="color:#1a56db;margin:4px 0 10px;font-size:15px">Worked Examples</h3>`;
    examples.forEach(ex => {
      const steps = ex.steps
        ? `<ol style="margin:6px 0 6px 18px;padding:0">${ex.steps.map(s => `<li style="margin-bottom:3px">${s}</li>`).join('')}</ol>`
        : '';
      ctx += `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin-bottom:10px">`;
      ctx += `<div style="font-weight:600;margin-bottom:6px">${ex.title || 'Example'}: <span style="font-weight:400">${ex.prompt || ''}</span></div>`;
      ctx += steps;
      if (ex.answer) ctx += `<div style="color:#059669;font-weight:600;margin-top:4px">✓ Answer: ${ex.answer}</div>`;
      ctx += `</div>`;
    });
  }
  ctx += `</div>`;

  return { quiz, context: ctx };
}

// ─────────────────────────────────────────────────────────────────
// STEP 1 — Schema migration
// ─────────────────────────────────────────────────────────────────
function migrateSchema(db) {
  console.log('STEP 1: Checking schema...');

  // Check current constraint text
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='questions'").get();
  const alreadyHasMath = row && row.sql && row.sql.includes('math-multiple-choice');

  if (alreadyHasMath) {
    console.log('  Schema already supports math types. Skipping migration.\n');
  } else {
    console.log('  Migrating questions table...');
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      BEGIN;
      ALTER TABLE questions RENAME TO questions_bak;
      
      -- Recreate questions
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
            'definition','isolated-word','passage-in-context',
            'math-multiple-choice','math-grid-in'
          )
        ),
        is_active     INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
        updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
      );
      INSERT INTO questions SELECT * FROM questions_bak;
      DROP TABLE questions_bak;

      -- ALTER TABLE RENAME TO questions_bak automatically updated foreign keys in test_questions and answers.
      -- We must recreate them to point back to 'questions'.
      
      ALTER TABLE test_questions RENAME TO test_questions_bak;
      CREATE TABLE test_questions (
        id             TEXT PRIMARY KEY,
        test_id        TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        question_id    TEXT NOT NULL REFERENCES questions(id),
        section        TEXT,
        question_order INTEGER NOT NULL
      );
      INSERT INTO test_questions SELECT * FROM test_questions_bak;
      DROP TABLE test_questions_bak;

      ALTER TABLE answers RENAME TO answers_bak;
      CREATE TABLE answers (
        id              TEXT PRIMARY KEY,
        attempt_id      TEXT NOT NULL REFERENCES test_attempts(id) ON DELETE CASCADE,
        question_id     TEXT NOT NULL REFERENCES questions(id),
        selected_answer TEXT,
        is_correct      INTEGER,
        answered_at     TEXT
      );
      INSERT INTO answers SELECT * FROM answers_bak;
      DROP TABLE answers_bak;

      COMMIT;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
    console.log('  ✅ question_type CHECK constraint expanded.\n');
  }

  // Extra columns on tests and test_attempts
  const tCols = db.prepare('PRAGMA table_info(tests)').all().map(r => r.name);
  if (!tCols.includes('requires_mastery_pass')) {
    db.exec('ALTER TABLE tests ADD COLUMN requires_mastery_pass INTEGER NOT NULL DEFAULT 0;');
    console.log('  + tests.requires_mastery_pass');
  }
  const aCols = db.prepare('PRAGMA table_info(test_attempts)').all().map(r => r.name);
  if (!aCols.includes('mastery_pass')) {
    db.exec('ALTER TABLE test_attempts ADD COLUMN mastery_pass INTEGER NOT NULL DEFAULT 1;');
    console.log('  + test_attempts.mastery_pass');
  }
  if (!aCols.includes('parent_attempt_id')) {
    db.exec('ALTER TABLE test_attempts ADD COLUMN parent_attempt_id TEXT;');
    console.log('  + test_attempts.parent_attempt_id');
  }
  console.log();
}

// ─────────────────────────────────────────────────────────────────
// STEP 2 — Clean existing math tests
// ─────────────────────────────────────────────────────────────────
function cleanMathTests(db) {
  const existing = db.prepare("SELECT id FROM tests WHERE test_type='math'").all();
  if (!existing.length) return;

  console.log(`STEP 2: Cleaning ${existing.length} existing math test(s)...`);
  db.exec('PRAGMA foreign_keys = OFF;');

  for (const { id: tid } of existing) {
    const attempts = db.prepare('SELECT id FROM test_attempts WHERE test_id=?').all(tid);
    for (const { id: aid } of attempts) {
      db.prepare('DELETE FROM answers          WHERE attempt_id=?').run(aid);
      db.prepare('DELETE FROM integrity_events WHERE attempt_id=?').run(aid);
      db.prepare('DELETE FROM test_results     WHERE attempt_id=?').run(aid);
    }
    db.prepare('DELETE FROM test_attempts WHERE test_id=?').run(tid);

    const qids = db.prepare('SELECT question_id FROM test_questions WHERE test_id=?').all(tid).map(r => r.question_id);
    db.prepare('DELETE FROM test_questions WHERE test_id=?').run(tid);
    for (const qid of qids) {
      db.prepare('DELETE FROM questions WHERE id=?').run(qid);
    }
    db.prepare('DELETE FROM tests WHERE id=?').run(tid);
  }

  db.exec('PRAGMA foreign_keys = ON;');
  console.log('  Done.\n');
}

// ─────────────────────────────────────────────────────────────────
// STEP 3 — Import chapters
// ─────────────────────────────────────────────────────────────────
function importChapters(db) {
  console.log('STEP 3: Importing chapters...\n');

  const insertTest = db.prepare(`
    INSERT INTO tests (id, title, test_type, duration_seconds, question_count, status, show_explanations, requires_mastery_pass)
    VALUES (?, ?, 'math', 2700, ?, 'published', 1, 1)
  `);
  const insertQuestion = db.prepare(`
    INSERT INTO questions (id, word, question, context, options, correct_answer, explanation, difficulty, category, question_type)
    VALUES (?, '', ?, ?, ?, ?, ?, 'medium', 'math', ?)
  `);
  const insertTQ = db.prepare(`
    INSERT INTO test_questions (id, test_id, question_id, question_order)
    VALUES (?, ?, ?, ?)
  `);

  let totalTests = 0, totalQ = 0;

  for (const { file, n, title } of CHAPTERS) {
    const label = `Ch.${String(n).padStart(2, '0')} ${title}`;
    process.stdout.write(`  ${label}... `);

    const data = parseChapter(file, n);
    if (!data) { console.log('SKIPPED — file not found'); continue; }
    if (!data.quiz.length) { console.log('SKIPPED — no quiz extracted'); continue; }

    // Build valid questions
    const validQs = [];
    for (const q of data.quiz) {
      if (!q || !q.q) continue;
      const hasOpts = Array.isArray(q.opts) && q.opts.length >= 2;
      if (hasOpts) {
        const ci = typeof q.correct === 'number' ? q.correct : 0;
        const { shuffled, newLetter } = shuffleOpts(q.opts, ci);
        validQs.push({ question: q.q, options: shuffled, correct: newLetter, exp: q.exp || '', type: 'math-multiple-choice' });
      } else {
        validQs.push({ question: q.q, options: [], correct: String(q.correct ?? ''), exp: q.exp || '', type: 'math-grid-in' });
      }
    }
    if (!validQs.length) { console.log('SKIPPED — 0 valid questions'); continue; }

    // Insert test
    const testId = randomUUID();
    insertTest.run(testId, `Ch.${String(n).padStart(2, '0')}: ${title}`, validQs.length);

    // Insert questions + test_questions
    validQs.forEach((q, i) => {
      const qId = randomUUID();
      insertQuestion.run(qId, q.question, i === 0 ? data.context : null, JSON.stringify(q.options), q.correct, q.exp, q.type);
      insertTQ.run(randomUUID(), testId, qId, i + 1);
    });

    console.log(`✅  ${validQs.length} questions`);
    totalTests++;
    totalQ += validQs.length;
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`🎉  Import complete!`);
  console.log(`    ${totalTests} chapters  |  ${totalQ} total questions`);
}

// ─────────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────────
const db = getDb();

(function forceCleanCorruptedTables() {
  // SQLite's ALTER TABLE RENAME can silently corrupt foreign keys in child tables.
  // To guarantee the schema is clean, we will drop the child tables and let schema.sql recreate them.
  console.log('⚠  Running pre-flight schema repair...');
  db.exec('PRAGMA foreign_keys = OFF;');
  
  db.exec(`
    DROP TABLE IF EXISTS answers;
    DROP TABLE IF EXISTS test_questions;
    DROP TABLE IF EXISTS questions_bak;
    DROP TABLE IF EXISTS questions_old;
  `);
  
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
  
  db.exec('PRAGMA foreign_keys = ON;');
  console.log('   Schema repair complete.\n');
})();

migrateSchema(db);
cleanMathTests(db);
importChapters(db);
