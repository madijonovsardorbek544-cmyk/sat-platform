require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { requireAuth, requireTeacher, requireStudent } = require('./middleware/auth');
const authRoutes    = require('./routes/auth');
const studentRoutes = require('./routes/student');
const teacherRoutes = require('./routes/teacher');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Static files ──────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── Student API (requires student auth) ───────────────────────────
app.use('/api/student', requireAuth, requireStudent, studentRoutes);

// ── Teacher API (requires teacher auth) ───────────────────────────
app.use('/api/teacher', requireAuth, requireTeacher, teacherRoutes);

// ── Protected page routing ────────────────────────────────────────
// Student pages
app.get('/student/*', requireAuth, requireStudent, (req, res, next) => next());

// Teacher pages
app.get('/teacher/*', requireAuth, requireTeacher, (req, res, next) => next());

// ── 404 handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send('Page not found');
});

// ── Error handler ─────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎓 SAT Platform running at http://localhost:${PORT}`);
  console.log(`   Teacher dashboard: http://localhost:${PORT}/teacher/dashboard.html`);
  console.log(`   Student dashboard: http://localhost:${PORT}/student/dashboard.html\n`);
});

module.exports = app;
