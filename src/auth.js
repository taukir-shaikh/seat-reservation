const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { HttpError } = require('./errors');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';

const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Demo login: there is no user store, so anyone can get a token for a user id.
// What matters for the exercise is that every request afterwards trusts only
// the token — never a user_id sent in the body.
function issueToken(userId) {
  if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) {
    throw new HttpError(400, 'invalid_user_id', 'user_id must be 1-64 chars of [A-Za-z0-9_-]');
  }
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '24h' });
}

// Middleware: reads "Authorization: Bearer <token>" and sets req.userId.
function requireUser(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return next(new HttpError(401, 'unauthorized', 'missing bearer token'));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    next(new HttpError(401, 'unauthorized', 'invalid or expired token'));
  }
}

// Middleware: admin routes need the shared "x-admin-key" header.
function requireAdmin(req, res, next) {
  const given = Buffer.from(req.get('x-admin-key') || '');
  const expected = Buffer.from(ADMIN_KEY);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) {
    return next(new HttpError(401, 'unauthorized', 'admin key required'));
  }
  next();
}

module.exports = { issueToken, requireUser, requireAdmin };
