const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const { OAuth2Client } = require('google-auth-library');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'sat_platform_secret';
const IS_PROD = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, username: user.username },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
}

function setCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 8 * 60 * 60 * 1000
  });
}

// ── Teacher login ──────────────────────────────────────────────────
router.post('/login/teacher', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email.trim().toLowerCase(), 'teacher');
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  setCookie(res, signToken(user));
  res.json({ ok: true, role: 'teacher' });
});

// ── Student email/password login (fallback when Google OAuth not configured) ──
router.post('/login/student', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email.trim().toLowerCase(), 'student');
  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  setCookie(res, signToken(user));
  res.json({ ok: true, role: 'student' });
});

// ── Student self-registration (used when Google OAuth not configured) ──
router.post('/register/student', (req, res) => {
  const { name, email, password, username } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.trim().toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const usernameCheck = username ? db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim()) : null;
  if (usernameCheck) return res.status(409).json({ error: 'Username already taken' });

  // Generate unique student ID
  const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;
  const studentId = `SAT-${String(count + 1).padStart(5, '0')}`;

  const hash = bcrypt.hashSync(password, 12);
  const id = uuidv4();
  const finalUsername = username?.trim() || name.trim().split(' ')[0].toLowerCase() + studentId;

  db.prepare(`
    INSERT INTO users (id, name, email, username, role, password_hash, student_id)
    VALUES (?, ?, ?, ?, 'student', ?, ?)
  `).run(id, name.trim(), email.trim().toLowerCase(), finalUsername, hash, studentId);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  setCookie(res, signToken(user));
  res.status(201).json({ ok: true, role: 'student' });
});

// ── Get current session ────────────────────────────────────────────
router.get('/me', (req, res) => {
  const token = req.cookies?.token;
  if (!token) return res.json({ authenticated: false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, username: user.username }, GOOGLE_CLIENT_ID: GOOGLE_CLIENT_ID || null });
  } catch {
    res.json({ authenticated: false });
  }
});

// ── Google Sign-In ────────────────────────────────────────────────
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'Missing credential' });
  if (!GOOGLE_CLIENT_ID) return res.status(500).json({ error: 'Google Sign-In is not configured' });

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email.toLowerCase();
    
    const db = getDb();
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    
    if (!user) {
      // Auto-register student via Google
      const count = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'student'").get().c;
      const studentId = `SAT-${String(count + 1).padStart(5, '0')}`;
      const id = uuidv4();
      
      db.prepare(`
        INSERT INTO users (id, name, email, role, google_id, student_id)
        VALUES (?, ?, ?, 'student', ?, ?)
      `).run(id, payload.name, email, payload.sub, studentId);
      
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    } else {
      // Update google_id if logging in via Google for the first time
      if (!user.google_id) {
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(payload.sub, user.id);
      }
    }

    setCookie(res, signToken(user));
    res.json({ ok: true, role: user.role });
  } catch (err) {
    console.error('Google Auth Error:', err);
    res.status(401).json({ error: 'Invalid Google Token' });
  }
});

// ── Logout ─────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

module.exports = router;
