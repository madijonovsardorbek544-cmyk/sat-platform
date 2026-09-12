require('dotenv').config();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./db');

async function seed() {
  const db = getDb();
  console.log('🌱 Seeding database...');

  // ─── Teacher account ───────────────────────────────────────────
  const teacherEmail = process.env.TEACHER_EMAIL || 'teacher@satplatform.com';
  const teacherPassword = process.env.TEACHER_PASSWORD || 'Teacher2026!';
  const teacherName = process.env.TEACHER_NAME || 'SAT Tutor';

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(teacherEmail);
  if (!existing) {
    const hash = bcrypt.hashSync(teacherPassword, 12);
    db.prepare(`
      INSERT INTO users (id, name, email, username, role, password_hash)
      VALUES (?, ?, ?, ?, 'teacher', ?)
    `).run(uuidv4(), teacherName, teacherEmail, 'teacher', hash);
    console.log(`✅  Teacher account created: ${teacherEmail}`);
  } else {
    console.log(`ℹ️   Teacher account already exists: ${teacherEmail}`);
  }

  // ─── Questions ─────────────────────────────────────────────────
  const questionsPath = path.join(__dirname, '..', 'data', 'questions.json');
  const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8'));

  const insertQ = db.prepare(`
    INSERT OR IGNORE INTO questions
      (id, word, question, context, options, correct_answer, explanation, difficulty, category, question_type, is_active)
    VALUES
      (@id, @word, @question, @context, @options, @correct_answer, @explanation, @difficulty, @category, @question_type, 1)
  `);

  const insertMany = db.transaction((qs) => {
    let count = 0;
    for (const q of qs) {
      const changes = insertQ.run({
        ...q,
        options: JSON.stringify(q.options),
        context: q.context || null,
      });
      if (changes.changes > 0) count++;
    }
    return count;
  });

  const inserted = insertMany(questions);
  console.log(`✅  ${inserted} questions inserted (${questions.length - inserted} already existed)`);

  // ─── Default vocabulary test ────────────────────────────────────
  const testId = 'test-vocab-diagnostic-001';
  const existingTest = db.prepare('SELECT id FROM tests WHERE id = ?').get(testId);

  if (!existingTest) {
    db.prepare(`
      INSERT INTO tests (id, title, test_type, duration_seconds, question_count, status, show_explanations, published_at)
      VALUES (?, 'SAT Vocabulary Diagnostic', 'vocabulary', 2700, 40, 'published', 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    `).run(testId);

    // Link all 40 questions to the test in order
    const insertTQ = db.prepare(`
      INSERT OR IGNORE INTO test_questions (id, test_id, question_id, section, question_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    const insertTestQuestions = db.transaction((qs) => {
      qs.forEach((q, idx) => {
        let section = 'definition';
        if (idx >= 10 && idx < 30) section = 'isolated-word';
        if (idx >= 30) section = 'passage-in-context';
        insertTQ.run(uuidv4(), testId, q.id, section, idx + 1);
      });
    });

    insertTestQuestions(questions);
    console.log('✅  Default vocabulary test created and linked');
  } else {
    console.log('ℹ️   Default vocabulary test already exists');
  }

  console.log('\n🎉 Seed complete!');
  console.log(`\nTeacher login:\n  Email:    ${teacherEmail}\n  Password: ${teacherPassword}\n`);
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
