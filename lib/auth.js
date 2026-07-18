const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH; // bcrypt hash, not plaintext

if (!JWT_SECRET) {
  throw new Error('Missing JWT_SECRET env var (any long random string).');
}
if (!ADMIN_USERNAME || !ADMIN_PASSWORD_HASH) {
  throw new Error(
    'Missing ADMIN_USERNAME / ADMIN_PASSWORD_HASH env vars. Generate a hash with: ' +
    `node -e "console.log(require('bcryptjs').hashSync('yourpassword', 10))"`
  );
}

async function login(req, res) {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (username !== ADMIN_USERNAME) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const valid = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ sub: username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, expires_in: '7d' });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { login, requireAuth };
