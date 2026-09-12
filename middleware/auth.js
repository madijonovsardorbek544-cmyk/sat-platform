const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'sat_platform_secret';

function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    return res.redirect('/');
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.clearCookie('token');
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Session expired' });
    }
    return res.redirect('/');
  }
}

function requireTeacher(req, res, next) {
  if (req.user?.role !== 'teacher') {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.redirect('/student/dashboard.html');
  }
  next();
}

function requireStudent(req, res, next) {
  if (req.user?.role !== 'student') {
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    return res.redirect('/teacher/dashboard.html');
  }
  next();
}

module.exports = { requireAuth, requireTeacher, requireStudent };
