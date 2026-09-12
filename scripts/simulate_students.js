const { getDb } = require('../database/db');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');

const db = getDb();

function simulate() {
  console.log('🤖 Starting student simulation...');

  // 1. Create Students
  const students = [
    { name: 'Alex Johnson', email: 'alex@example.com', username: 'alexj' },
    { name: 'Maria Garcia', email: 'maria@example.com', username: 'mariag' },
    { name: 'Sam Smith', email: 'sam@example.com', username: 'sams' }
  ];

  const hash = bcrypt.hashSync('password123', 10);
  let studentCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;

  const createdStudents = [];
  
  for (const s of students) {
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(s.email);
    if (existing) {
      createdStudents.push(existing);
      continue;
    }
    
    studentCount++;
    const id = uuidv4();
    const studentId = `SAT-${String(studentCount).padStart(5, '0')}`;
    db.prepare(`
      INSERT INTO users (id, name, email, username, role, password_hash, student_id)
      VALUES (?, ?, ?, ?, 'student', ?, ?)
    `).run(id, s.name, s.email, s.username, hash, studentId);
    
    createdStudents.push(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  // 2. Fetch the Vocabulary Test and Questions
  const test = db.prepare("SELECT * FROM tests WHERE test_type = 'vocabulary' LIMIT 1").get();
  if (!test) {
    console.error('❌ No vocabulary test found. Run seed script first.');
    process.exit(1);
  }

  const questions = db.prepare(`
    SELECT q.*, tq.question_order, tq.section
    FROM test_questions tq
    JOIN questions q ON q.id = tq.question_id
    WHERE tq.test_id = ?
    ORDER BY tq.question_order ASC
  `).all(test.id);

  // Helper to generate a fake attempt
  function generateAttempt(student, dateOffsetDays, accuracyTarget, timeUsedSeconds) {
    const attemptId = uuidv4();
    const date = new Date();
    date.setDate(date.getDate() - dateOffsetDays);
    const startedAt = date.toISOString();
    
    date.setSeconds(date.getSeconds() + timeUsedSeconds);
    const submittedAt = date.toISOString();
    
    // Expires at was started + 45 min
    const expiresAt = new Date(new Date(startedAt).getTime() + 45 * 60000).toISOString();

    db.prepare(`
      INSERT INTO test_attempts (id, student_id, test_id, test_type, started_at, submitted_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted')
    `).run(attemptId, student.id, test.id, 'vocabulary', startedAt, submittedAt, expiresAt);

    let correct = 0, incorrect = 0, unanswered = 0;
    const diffBreakdown = {};
    const catBreakdown = {};
    const typeBreakdown = {};

    const insertAnswer = db.prepare(`
      INSERT INTO answers (id, attempt_id, question_id, selected_answer, is_correct, answered_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const q of questions) {
      let selectedAnswer = null;
      let isCorrect = null;
      
      const rand = Math.random() * 100;
      
      if (rand > accuracyTarget + 5) {
        // Unanswered (5% chance if they miss the target)
        if (Math.random() < 0.2) {
          unanswered++;
        } else {
          // Incorrect
          const wrongOptions = ['A', 'B', 'C', 'D'].filter(opt => opt !== q.correct_answer);
          selectedAnswer = wrongOptions[Math.floor(Math.random() * wrongOptions.length)];
          isCorrect = 0;
          incorrect++;
        }
      } else {
        // Correct
        selectedAnswer = q.correct_answer;
        isCorrect = 1;
        correct++;
      }

      insertAnswer.run(uuidv4(), attemptId, q.id, selectedAnswer, isCorrect, submittedAt);

      // Breakdowns
      const d = q.difficulty;
      const c = q.category;
      const t = q.question_type;
      diffBreakdown[d] = diffBreakdown[d] || { correct: 0, incorrect: 0, unanswered: 0 };
      catBreakdown[c]  = catBreakdown[c]  || { correct: 0, incorrect: 0, unanswered: 0 };
      typeBreakdown[t] = typeBreakdown[t] || { correct: 0, incorrect: 0, unanswered: 0 };

      const key = isCorrect === 1 ? 'correct' : isCorrect === 0 ? 'incorrect' : 'unanswered';
      diffBreakdown[d][key]++;
      catBreakdown[c][key]++;
      typeBreakdown[t][key]++;
    }

    const accuracy = Math.round((correct / questions.length) * 1000) / 10;

    db.prepare(`
      INSERT INTO test_results
        (id, attempt_id, correct_count, incorrect_count, unanswered_count, score, accuracy, time_used, difficulty_breakdown, category_breakdown, question_type_breakdown)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), attemptId,
      correct, incorrect, unanswered, correct, accuracy, timeUsedSeconds,
      JSON.stringify(diffBreakdown), JSON.stringify(catBreakdown), JSON.stringify(typeBreakdown)
    );
    
    return attemptId;
  }

  db.transaction(() => {
    // Alex: Took it 3 times, improving steadily
    generateAttempt(createdStudents[0], 14, 55, 2700);
    generateAttempt(createdStudents[0], 7, 75, 2400);
    generateAttempt(createdStudents[0], 1, 90, 2100);

    // Maria: Took it 1 time, did excellent, but had an integrity event
    const mariaAttemptId = generateAttempt(createdStudents[1], 2, 95, 1800);
    db.prepare(`
      INSERT INTO integrity_events (id, attempt_id, event_type, timestamp, question_number)
      VALUES (?, ?, 'tab_switch', ?, 14)
    `).run(uuidv4(), mariaAttemptId, new Date(Date.now() - 2 * 86400000 + 600000).toISOString());

    // Sam: Took it 2 times, struggling with hard questions
    generateAttempt(createdStudents[2], 10, 40, 2700);
    generateAttempt(createdStudents[2], 3, 45, 2700);
  })();

  console.log('✅ Simulated data generated successfully!');
  console.log('Check the Teacher Dashboard to view results.');
}

try {
  simulate();
} catch (e) {
  console.error(e);
}
