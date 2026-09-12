const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');

const router = express.Router();

// ── Overview: all students + last attempt summary ──────────────────
router.get('/students', (req, res) => {
  const db = getDb();
  const { search } = req.query;

  let query = `
    SELECT u.id, u.name, u.email, u.username, u.student_id, u.created_at,
           COUNT(ta.id) as attempt_count,
           MAX(ta.submitted_at) as last_attempt_at
    FROM users u
    LEFT JOIN test_attempts ta ON ta.student_id = u.id AND ta.status = 'submitted'
    WHERE u.role = 'student'
  `;
  const params = [];
  if (search) {
    query += ` AND (u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  query += ' GROUP BY u.id ORDER BY u.name ASC';

  const students = db.prepare(query).all(...params);
  res.json({ students });
});

// ── Single student profile + all attempts ─────────────────────────
router.get('/students/:studentId', (req, res) => {
  const db = getDb();
  const student = db.prepare(`
    SELECT id, name, email, username, student_id, created_at
    FROM users WHERE id = ? AND role = 'student'
  `).get(req.params.studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const attempts = db.prepare(`
    SELECT ta.id, ta.test_id, ta.started_at, ta.submitted_at, ta.status,
           t.title, t.test_type,
           tr.score, tr.correct_count, tr.incorrect_count, tr.unanswered_count,
           tr.accuracy, tr.time_used
    FROM test_attempts ta
    JOIN tests t ON t.id = ta.test_id
    LEFT JOIN test_results tr ON tr.attempt_id = ta.id
    WHERE ta.student_id = ? AND ta.status = 'submitted'
    ORDER BY ta.submitted_at ASC
  `).all(student.id);

  // Integrity summary per attempt
  const integrityCounts = db.prepare(`
    SELECT attempt_id, COUNT(*) as event_count
    FROM integrity_events WHERE attempt_id IN (
      SELECT id FROM test_attempts WHERE student_id = ?
    )
    GROUP BY attempt_id
  `).all(student.id);

  const integrityMap = {};
  for (const row of integrityCounts) integrityMap[row.attempt_id] = row.event_count;

  const attemptsWithIntegrity = attempts.map(a => ({ ...a, integrityEvents: integrityMap[a.id] || 0 }));

  res.json({ student, attempts: attemptsWithIntegrity });
});

// ── Detailed attempt review (teacher) ─────────────────────────────
router.get('/attempts/:attemptId', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT ta.*, t.title, t.show_explanations,
           u.name as student_name, u.email as student_email, u.student_id
    FROM test_attempts ta
    JOIN tests t ON t.id = ta.test_id
    JOIN users u ON u.id = ta.student_id
    WHERE ta.id = ?
  `).get(req.params.attemptId);

  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });

  const result = db.prepare('SELECT * FROM test_results WHERE attempt_id = ?').get(attempt.id);

  const answers = db.prepare(`
    SELECT a.question_id, a.selected_answer, a.is_correct,
           q.word, q.question, q.context, q.options, q.correct_answer,
           q.explanation, q.difficulty, q.category, q.question_type
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    WHERE a.attempt_id = ?
  `).all(attempt.id).map(r => ({ ...r, options: JSON.parse(r.options) }));

  const integrityEvents = db.prepare(`
    SELECT event_type, timestamp, question_number
    FROM integrity_events WHERE attempt_id = ?
    ORDER BY timestamp ASC
  `).all(attempt.id);

  res.json({
    attempt: {
      id: attempt.id,
      studentName: attempt.student_name,
      studentEmail: attempt.student_email,
      studentId: attempt.student_id,
      testTitle: attempt.title,
      status: attempt.status,
      startedAt: attempt.started_at,
      submittedAt: attempt.submitted_at
    },
    result: result ? {
      ...result,
      difficultyBreakdown: JSON.parse(result.difficulty_breakdown || '{}'),
      categoryBreakdown: JSON.parse(result.category_breakdown || '{}'),
      questionTypeBreakdown: JSON.parse(result.question_type_breakdown || '{}')
    } : null,
    answers,
    integrityEvents
  });
});

// ── Question bank management ───────────────────────────────────────
router.get('/questions', (req, res) => {
  const db = getDb();
  const questions = db.prepare('SELECT * FROM questions ORDER BY question_type, id').all()
    .map(q => ({ ...q, options: JSON.parse(q.options) }));
  res.json({ questions });
});

router.post('/questions', (req, res) => {
  const db = getDb();
  const { word, question, context, options, correct_answer, explanation, difficulty, category, question_type } = req.body;

  if (!word || !question || !options || !correct_answer || !explanation || !difficulty || !question_type) {
    return res.status(400).json({ error: 'All required fields must be provided' });
  }
  if (!Array.isArray(options) || options.length !== 4) return res.status(400).json({ error: 'Options must be an array of 4 choices' });
  if (!['A','B','C','D'].includes(correct_answer)) return res.status(400).json({ error: 'correct_answer must be A, B, C, or D' });

  const id = uuidv4();
  db.prepare(`
    INSERT INTO questions (id, word, question, context, options, correct_answer, explanation, difficulty, category, question_type, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(id, word, question, context || null, JSON.stringify(options), correct_answer, explanation, difficulty, category || 'vocabulary', question_type);

  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
  res.status(201).json({ question: { ...q, options: JSON.parse(q.options) } });
});

router.put('/questions/:id', (req, res) => {
  const db = getDb();
  const { word, question, context, options, correct_answer, explanation, difficulty, category, question_type, is_active } = req.body;

  const existing = db.prepare('SELECT id FROM questions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Question not found' });

  db.prepare(`
    UPDATE questions SET word=?, question=?, context=?, options=?, correct_answer=?,
      explanation=?, difficulty=?, category=?, question_type=?, is_active=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id=?
  `).run(word, question, context || null, JSON.stringify(options), correct_answer,
    explanation, difficulty, category || 'vocabulary', question_type,
    is_active !== undefined ? (is_active ? 1 : 0) : 1, req.params.id);

  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  res.json({ question: { ...q, options: JSON.parse(q.options) } });
});

router.delete('/questions/:id', (req, res) => {
  const db = getDb();
  db.prepare("UPDATE questions SET is_active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ── Tests management ───────────────────────────────────────────────
router.get('/tests', (req, res) => {
  const db = getDb();
  const tests = db.prepare('SELECT * FROM tests ORDER BY created_at DESC').all();
  res.json({ tests });
});

router.put('/tests/:id', (req, res) => {
  const db = getDb();
  const { status, show_explanations, title, duration_seconds } = req.body;
  const test = db.prepare('SELECT id FROM tests WHERE id = ?').get(req.params.id);
  if (!test) return res.status(404).json({ error: 'Test not found' });

  const updates = [];
  const params = [];
  if (status !== undefined) {
    updates.push('status = ?');
    params.push(status);
    if (status === 'published') { updates.push('published_at = ?'); params.push(new Date().toISOString()); }
  }
  if (show_explanations !== undefined) { updates.push('show_explanations = ?'); params.push(show_explanations ? 1 : 0); }
  if (title) { updates.push('title = ?'); params.push(title); }
  if (duration_seconds) { updates.push('duration_seconds = ?'); params.push(duration_seconds); }
  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
  params.push(req.params.id);

  db.prepare(`UPDATE tests SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.id);
  res.json({ test: updated });
});

// ── Add student account manually ──────────────────────────────────
router.post('/students', (req, res) => {
  const db = getDb();
  const { name, email, password, username } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, password required' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;
  const studentId = `SAT-${String(count + 1).padStart(5, '0')}`;
  const hash = bcrypt.hashSync(password, 12);
  const id = uuidv4();
  const finalUsername = username?.trim() || name.trim().split(' ')[0].toLowerCase() + studentId;

  db.prepare(`
    INSERT INTO users (id, name, email, username, role, password_hash, student_id)
    VALUES (?, ?, ?, ?, 'student', ?, ?)
  `).run(id, name.trim(), email.trim().toLowerCase(), finalUsername, hash, studentId);

  res.status(201).json({ ok: true, studentId });
});

// ── Dashboard summary stats ────────────────────────────────────────
router.get('/stats', (req, res) => {
  const db = getDb();
  const totalStudents = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;
  const totalAttempts = db.prepare("SELECT COUNT(*) as c FROM test_attempts WHERE status = 'submitted'").get().c;
  const avgAccuracy = db.prepare("SELECT AVG(accuracy) as avg FROM test_results").get().avg;
  const recentAttempts = db.prepare(`
    SELECT ta.id, ta.submitted_at, u.name as student_name, t.title,
           tr.score, tr.accuracy, tr.correct_count, tr.incorrect_count, tr.unanswered_count, tr.time_used
    FROM test_attempts ta
    JOIN users u ON u.id = ta.student_id
    JOIN tests t ON t.id = ta.test_id
    LEFT JOIN test_results tr ON tr.attempt_id = ta.id
    WHERE ta.status = 'submitted'
    ORDER BY ta.submitted_at DESC
    LIMIT 10
  `).all();

  res.json({ totalStudents, totalAttempts, avgAccuracy: avgAccuracy ? Math.round(avgAccuracy * 10) / 10 : 0, recentAttempts });
});

module.exports = router;
