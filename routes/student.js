const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');

const router = express.Router();

// ── Dashboard: get available tests ─────────────────────────────────
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const db_user = db.prepare('SELECT id, name, email, username, student_id, created_at FROM users WHERE id = ?').get(req.user.id);

  const tests = db.prepare(`
    SELECT t.id, t.title, t.test_type, t.duration_seconds, t.question_count
    FROM tests t
    WHERE t.status = 'published'
    ORDER BY t.created_at ASC
  `).all();

  // For each test, check if the student has a completed attempt
  const testsWithStatus = tests.map(test => {
    const lastAttempt = db.prepare(`
      SELECT ta.id, ta.status, ta.submitted_at, tr.score, tr.accuracy
      FROM test_attempts ta
      LEFT JOIN test_results tr ON tr.attempt_id = ta.id
      WHERE ta.student_id = ? AND ta.test_id = ?
      ORDER BY ta.started_at DESC
      LIMIT 1
    `).get(req.user.id, test.id);
    return { ...test, lastAttempt: lastAttempt || null };
  });

  res.json({ user: db_user, tests: testsWithStatus });
});

// ── Start a test attempt ────────────────────────────────────────────
router.post('/test/:testId/start', (req, res) => {
  const db = getDb();
  const test = db.prepare("SELECT * FROM tests WHERE id = ? AND status = 'published'").get(req.params.testId);
  if (!test) return res.status(404).json({ error: 'Test not found or not available' });

  // Check for an existing in-progress attempt
  const existing = db.prepare(`
    SELECT * FROM test_attempts WHERE student_id = ? AND test_id = ? AND status = 'in-progress'
  `).get(req.user.id, test.id);

  if (existing) {
    // Resume if not expired
    const now = new Date();
    const expires = new Date(existing.expires_at);
    if (now < expires) {
      // Fetch questions tied to this attempt
      const attemptQs = db.prepare(`
        SELECT q.id, q.word, q.question, q.context, q.options, q.difficulty, q.category, q.question_type, tq.section, tq.question_order
        FROM answers a
        JOIN questions q ON q.id = a.question_id
        JOIN test_questions tq ON tq.question_id = q.id AND tq.test_id = ?
        WHERE a.attempt_id = ?
        ORDER BY tq.question_order ASC
      `).all(test.id, existing.id);

      if (attemptQs.length > 0) {
        const safeQuestions = attemptQs.map(q => ({
          id: q.id, word: q.word, question: q.question, context: q.context,
          options: JSON.parse(q.options), difficulty: q.difficulty,
          category: q.category, question_type: q.question_type,
          section: q.section, question_order: q.question_order
        }));

        const questionsWithShuffledOptions = safeQuestions.map(q => {
          const { shuffledOptions, mapping } = shuffleOptions(q.options);
          return { ...q, options: shuffledOptions, optionMapping: mapping };
        });

        return res.json({
          attemptId: existing.id,
          resumed: true,
          expiresAt: existing.expires_at,
          testTitle: test.title,
          durationSeconds: test.duration_seconds,
          questions: questionsWithShuffledOptions
        });
      }
      
      // If attemptQs is empty, the answers were wiped out by a DB migration.
      // Mark it as corrupted and fall through to create a new attempt.
      db.prepare("UPDATE test_attempts SET status = 'corrupted' WHERE id = ?").run(existing.id);
    } else {
      // Mark as expired
      db.prepare("UPDATE test_attempts SET status = 'expired' WHERE id = ?").run(existing.id);
    }
  }

  // Fetch questions for this test in defined order
  const questions = db.prepare(`
    SELECT q.id, q.word, q.question, q.context, q.options, q.difficulty, q.category, q.question_type, tq.question_order, tq.section
    FROM test_questions tq
    JOIN questions q ON q.id = tq.question_id
    WHERE tq.test_id = ? AND q.is_active = 1
    ORDER BY tq.question_order ASC
  `).all(test.id);

  if (questions.length === 0) return res.status(400).json({ error: 'No active questions in this test' });

  // Randomize within each section (preserve section order)
  const shuffled = shuffleWithinSections(questions);

  const attemptId = uuidv4();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + test.duration_seconds * 1000).toISOString();

  db.prepare(`
    INSERT INTO test_attempts (id, student_id, test_id, test_type, started_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'in-progress')
  `).run(attemptId, req.user.id, test.id, test.test_type, now.toISOString(), expiresAt);

  // Pre-create answer rows (unanswered)
  const insertAnswer = db.prepare(`
    INSERT INTO answers (id, attempt_id, question_id, selected_answer, is_correct, answered_at)
    VALUES (?, ?, ?, NULL, NULL, NULL)
  `);
  const insertAll = db.transaction((qs) => {
    for (const q of qs) insertAnswer.run(uuidv4(), attemptId, q.id);
  });
  insertAll(shuffled);

  // Return questions WITHOUT correct answers
  const safeQuestions = shuffled.map(q => ({
    id: q.id,
    word: q.word,
    question: q.question,
    context: q.context,
    options: JSON.parse(q.options),
    difficulty: q.difficulty,
    category: q.category,
    question_type: q.question_type,
    section: q.section,
    question_order: q.question_order
  }));

  // Randomize answer choices (store mapping for scoring)
  const questionsWithShuffledOptions = safeQuestions.map(q => {
    const { shuffledOptions, mapping } = shuffleOptions(q.options);
    return { ...q, options: shuffledOptions, optionMapping: mapping };
  });

  // Store the option mapping so server can score correctly
  db.prepare("UPDATE test_attempts SET status = 'in-progress' WHERE id = ?").run(attemptId);

  res.json({
    attemptId,
    resumed: false,
    expiresAt,
    testTitle: test.title,
    durationSeconds: test.duration_seconds,
    questions: questionsWithShuffledOptions
  });
});

// ── Resume a specific attempt ───────────────────────────────────────
router.post('/attempt/:attemptId/resume', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT * FROM test_attempts WHERE id = ? AND student_id = ? AND status = 'in-progress'
  `).get(req.params.attemptId, req.user.id);
  
  if (!attempt) return res.status(404).json({ error: 'Attempt not found or expired' });

  const test = db.prepare("SELECT * FROM tests WHERE id = ?").get(attempt.test_id);

  const questions = db.prepare(`
    SELECT q.id, q.word, q.question, q.context, q.options, q.difficulty, q.category, q.question_type
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    WHERE a.attempt_id = ?
  `).all(attempt.id);

  const safeQuestions = questions.map(q => ({
    id: q.id,
    word: q.word,
    question: q.question,
    context: q.context,
    options: JSON.parse(q.options),
    difficulty: q.difficulty,
    category: q.category,
    question_type: q.question_type
  }));

  const questionsWithShuffledOptions = safeQuestions.map(q => {
    const { shuffledOptions, mapping } = shuffleOptions(q.options);
    return { ...q, options: shuffledOptions, optionMapping: mapping };
  });

  res.json({
    attemptId: attempt.id,
    resumed: true,
    expiresAt: attempt.expires_at,
    testTitle: test.title + (attempt.mastery_pass === 2 ? ' (Second Pass)' : ''),
    durationSeconds: test.duration_seconds,
    questions: questionsWithShuffledOptions
  });
});

// ── Get existing answers for an attempt ──────────────────────────────
router.get('/attempt/:attemptId/answers', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT * FROM test_attempts WHERE id = ? AND student_id = ?
  `).get(req.params.attemptId, req.user.id);
  if (!attempt) return res.status(404).json({ error: 'Not found' });

  const answers = db.prepare(`
    SELECT question_id, selected_answer FROM answers WHERE attempt_id = ?
  `).all(attempt.id);
  
  res.json({ answers });
});

// ── Autosave a single answer ────────────────────────────────────────
router.post('/attempt/:attemptId/answer', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT * FROM test_attempts WHERE id = ? AND student_id = ? AND status = 'in-progress'
  `).get(req.params.attemptId, req.user.id);

  if (!attempt) return res.status(404).json({ error: 'Attempt not found or already submitted' });

  // Check not expired
  if (new Date() > new Date(attempt.expires_at)) {
    db.prepare("UPDATE test_attempts SET status = 'expired' WHERE id = ?").run(attempt.id);
    return res.status(410).json({ error: 'Time expired' });
  }

  const { questionId, selectedAnswer } = req.body;
  if (!questionId) return res.status(400).json({ error: 'questionId required' });

  const validAnswers = ['A', 'B', 'C', 'D', null];
  if (!validAnswers.includes(selectedAnswer)) return res.status(400).json({ error: 'Invalid answer' });

  db.prepare(`
    UPDATE answers SET selected_answer = ?, answered_at = ?
    WHERE attempt_id = ? AND question_id = ?
  `).run(selectedAnswer, new Date().toISOString(), attempt.id, questionId);

  res.json({ ok: true });
});

// ── Log integrity event ─────────────────────────────────────────────
router.post('/attempt/:attemptId/integrity', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT * FROM test_attempts WHERE id = ? AND student_id = ?
  `).get(req.params.attemptId, req.user.id);

  if (!attempt) return res.status(404).json({ error: 'Not found' });

  const { eventType, questionNumber } = req.body;
  db.prepare(`
    INSERT INTO integrity_events (id, attempt_id, event_type, timestamp, question_number)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidv4(), attempt.id, eventType, new Date().toISOString(), questionNumber || null);

  res.json({ ok: true });
});

// ── Submit test ─────────────────────────────────────────────────────
router.post('/attempt/:attemptId/submit', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT * FROM test_attempts WHERE id = ? AND student_id = ?
  `).get(req.params.attemptId, req.user.id);

  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  if (attempt.status === 'submitted') return res.status(409).json({ error: 'Already submitted' });

  const submittedAt = new Date().toISOString();
  const timeUsedSeconds = Math.round((new Date(submittedAt) - new Date(attempt.started_at)) / 1000);

  // Score server-side
  const answers = db.prepare(`
    SELECT a.id, a.question_id, a.selected_answer, q.correct_answer, q.difficulty, q.category, q.question_type
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    WHERE a.attempt_id = ?
  `).all(attempt.id);

  let correct = 0, incorrect = 0, unanswered = 0;
  const diffBreakdown = {};
  const catBreakdown = {};
  const typeBreakdown = {};

  const updateAnswer = db.prepare(`
    UPDATE answers SET is_correct = ? WHERE id = ?
  `);

  const scoreAll = db.transaction(() => {
    for (const a of answers) {
      let isCorrect = null;
      if (!a.selected_answer) {
        unanswered++;
        isCorrect = null;
      } else if (a.selected_answer === a.correct_answer) {
        correct++;
        isCorrect = 1;
      } else {
        incorrect++;
        isCorrect = 0;
      }
      updateAnswer.run(isCorrect, a.id);

      // Breakdowns
      const d = a.difficulty;
      const c = a.category;
      const t = a.question_type;
      diffBreakdown[d] = diffBreakdown[d] || { correct: 0, incorrect: 0, unanswered: 0 };
      catBreakdown[c]  = catBreakdown[c]  || { correct: 0, incorrect: 0, unanswered: 0 };
      typeBreakdown[t] = typeBreakdown[t] || { correct: 0, incorrect: 0, unanswered: 0 };

      const key = isCorrect === 1 ? 'correct' : isCorrect === 0 ? 'incorrect' : 'unanswered';
      diffBreakdown[d][key]++;
      catBreakdown[c][key]++;
      typeBreakdown[t][key]++;
    }
  });

  scoreAll();

  const total = answers.length;
  const accuracy = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;

  // Update attempt
  db.prepare(`
    UPDATE test_attempts SET status = 'submitted', submitted_at = ? WHERE id = ?
  `).run(submittedAt, attempt.id);

  // Insert result
  const resultId = uuidv4();
  db.prepare(`
    INSERT OR REPLACE INTO test_results
      (id, attempt_id, correct_count, incorrect_count, unanswered_count, score, accuracy, time_used, difficulty_breakdown, category_breakdown, question_type_breakdown)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    resultId, attempt.id,
    correct, incorrect, unanswered, correct, accuracy, timeUsedSeconds,
    JSON.stringify(diffBreakdown), JSON.stringify(catBreakdown), JSON.stringify(typeBreakdown)
  );

  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(attempt.test_id);
  
  let reviewData = null;
  let nextAttemptId = null;

  if (test?.requires_mastery_pass === 1 && (attempt.mastery_pass || 1) === 1 && (incorrect > 0 || unanswered > 0)) {
    // Generate Pass 2
    nextAttemptId = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + test.duration_seconds * 1000).toISOString();
    db.prepare(`
      INSERT INTO test_attempts (id, student_id, test_id, test_type, started_at, expires_at, status, mastery_pass, parent_attempt_id)
      VALUES (?, ?, ?, ?, ?, ?, 'in-progress', 2, ?)
    `).run(nextAttemptId, attempt.student_id, attempt.test_id, attempt.test_type, now.toISOString(), expiresAt, attempt.id);
    
    const insertAnswer = db.prepare(`
      INSERT INTO answers (id, attempt_id, question_id) VALUES (?, ?, ?)
    `);
    const wrongAnswers = db.prepare('SELECT question_id FROM answers WHERE attempt_id = ? AND (is_correct = 0 OR is_correct IS NULL)').all(attempt.id);
    db.transaction(() => {
      for (const q of wrongAnswers) insertAnswer.run(uuidv4(), nextAttemptId, q.question_id);
    })();
  } else {
    // Show explanations only if no mastery pass required, or if this is pass 2, or if pass 1 was 100%
    const showExplanations = test?.show_explanations === 1;
    reviewData = showExplanations ? buildReview(db, attempt.id) : null;
  }

  res.json({
    ok: true,
    result: {
      attemptId: attempt.id,
      score: correct,
      total,
      correct,
      incorrect,
      unanswered,
      accuracy,
      timeUsed: timeUsedSeconds,
      submittedAt,
      difficultyBreakdown: diffBreakdown,
      categoryBreakdown: catBreakdown,
      questionTypeBreakdown: typeBreakdown,
      review: reviewData,
      nextAttemptId: nextAttemptId
    }
  });
});

// ── Get result for a submitted attempt ─────────────────────────────
router.get('/attempt/:attemptId/result', (req, res) => {
  const db = getDb();
  const attempt = db.prepare(`
    SELECT ta.*, t.title, t.show_explanations
    FROM test_attempts ta
    JOIN tests t ON t.id = ta.test_id
    WHERE ta.id = ? AND ta.student_id = ?
  `).get(req.params.attemptId, req.user.id);

  if (!attempt) return res.status(404).json({ error: 'Not found' });
  if (attempt.status !== 'submitted') return res.status(400).json({ error: 'Test not submitted yet' });

  const result = db.prepare('SELECT * FROM test_results WHERE attempt_id = ?').get(attempt.id);
  const review = attempt.show_explanations ? buildReview(db, attempt.id) : null;

  res.json({
    attempt: {
      id: attempt.id,
      testTitle: attempt.title,
      status: attempt.status,
      startedAt: attempt.started_at,
      submittedAt: attempt.submitted_at
    },
    result: { ...result, difficultyBreakdown: JSON.parse(result.difficulty_breakdown || '{}'), categoryBreakdown: JSON.parse(result.category_breakdown || '{}'), questionTypeBreakdown: JSON.parse(result.question_type_breakdown || '{}') },
    review
  });
});

// ── Student's own test history ──────────────────────────────────────
router.get('/history', (req, res) => {
  const db = getDb();
  const attempts = db.prepare(`
    SELECT ta.id, ta.test_id, ta.started_at, ta.submitted_at, ta.status,
           t.title, t.test_type,
           tr.score, tr.correct_count, tr.incorrect_count, tr.unanswered_count,
           tr.accuracy, tr.time_used
    FROM test_attempts ta
    JOIN tests t ON t.id = ta.test_id
    LEFT JOIN test_results tr ON tr.attempt_id = ta.id
    WHERE ta.student_id = ? AND ta.status = 'submitted'
    ORDER BY ta.submitted_at DESC
  `).all(req.user.id);

  res.json({ attempts });
});

// ── Helpers ─────────────────────────────────────────────────────────
function shuffleWithinSections(questions) {
  const sections = {};
  for (const q of questions) {
    if (!sections[q.section]) sections[q.section] = [];
    sections[q.section].push(q);
  }
  const result = [];
  const order = ['definition', 'isolated-word', 'passage-in-context'];
  for (const sec of order) {
    if (sections[sec]) {
      const arr = sections[sec];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      result.push(...arr);
    }
  }
  return result;
}

function shuffleOptions(options) {
  const letters = ['A', 'B', 'C', 'D'];
  const indices = [0, 1, 2, 3];
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const shuffledOptions = indices.map(i => options[i]);
  // mapping: new position letter -> original position letter
  const mapping = {};
  indices.forEach((origIdx, newIdx) => {
    mapping[letters[newIdx]] = letters[origIdx];
  });
  return { shuffledOptions, mapping };
}

function buildReview(db, attemptId) {
  return db.prepare(`
    SELECT a.question_id, a.selected_answer, a.is_correct,
           q.word, q.question, q.context, q.options, q.correct_answer,
           q.explanation, q.difficulty, q.category, q.question_type
    FROM answers a
    JOIN questions q ON q.id = a.question_id
    WHERE a.attempt_id = ?
  `).all(attemptId).map(r => ({
    ...r,
    options: JSON.parse(r.options)
  }));
}

module.exports = router;
