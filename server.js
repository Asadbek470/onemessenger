const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// If JWT_SECRET isn't set as an environment variable, generate one ONCE and
// save it next to the database file, then reuse it on every future start.
// This means logins survive server restarts/sleep-wake cycles without you
// having to set anything on Render manually. It only resets if the disk
// itself is wiped (e.g. a fresh deploy on a host with no persistent disk) —
// setting JWT_SECRET yourself in the environment is still the more durable
// option, but this removes the need to do that by hand.
const SECRET_FILE = path.join(__dirname, ".jwt-secret");

function loadOrCreatePersistedSecret() {
  try {
    if (fs.existsSync(SECRET_FILE)) {
      const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
      if (existing) return existing;
    }
  } catch {}

  const generated = crypto.randomBytes(48).toString("hex");
  try {
    fs.writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  } catch (e) {
    console.warn("[SECURITY WARNING] Could not persist a JWT secret to disk:", e.message);
  }
  return generated;
}

const EFFECTIVE_JWT_SECRET = JWT_SECRET || loadOrCreatePersistedSecret();
const APP_NAME = "One Messenger";

// ---------------- ADMIN CREDENTIALS ----------------
// The admin panel is a completely separate login, not tied to any regular
// user account. Set these in Render -> Environment. The values below are
// only fallbacks so the panel works out of the box — CHANGE THEM before
// this app is reachable by anyone else, because default credentials in a
// public GitHub repo are effectively public.
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin2026";
if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
  console.warn(
    "[SECURITY WARNING] ADMIN_LOGIN/ADMIN_PASSWORD are not set — using the " +
    "built-in defaults (admin / admin2026). Set both in your environment " +
    "before deploying anywhere public."
  );
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // still run a comparison of equal length to avoid leaking length via timing
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ---------------- UPLOAD SAFETY ----------------
// Never trust the extension the client sends. Map from the sniffed mimetype
// instead, so a crafted filename can never end up inside an
// <img src="..."> / <video src="..."> attribute unescaped.
const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/webm": ".webm",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav"
};

function fileFilter(req, file, cb) {
  if (MIME_EXT[file.mimetype]) return cb(null, true);
  cb(new Error("Недопустимый тип файла"));
}

const upload = multer({
  dest: uploadsDir,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 } // 25MB
});

const db = new sqlite3.Database("database.db");

const now = () => Date.now();
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r || [])));
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r || null)));
const dbRun = function (sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
};

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      passwordHash TEXT,
      displayName TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      avatarUrl TEXT DEFAULT '',
      birthDate TEXT DEFAULT '',
      banned INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Safe to run repeatedly against an existing DB; SQLite errors if a column
  // already exists, which we just swallow.
  const addCol = (col, def) => db.run(`ALTER TABLE users ADD COLUMN ${col} ${def}`, () => {});
  addCol("banned", "INTEGER NOT NULL DEFAULT 0");
  addCol("muted", "INTEGER NOT NULL DEFAULT 0");
  addCol("verified", "INTEGER NOT NULL DEFAULT 0");
  addCol("totpSecret", "TEXT NOT NULL DEFAULT ''");
  addCol("totpEnabled", "INTEGER NOT NULL DEFAULT 0");
  addCol("settings", "TEXT NOT NULL DEFAULT '{}'"); // { theme, wallpaper, accent }

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatType TEXT NOT NULL,          -- global|private|group
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,          -- 'global' | username | 'group:<id>'
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',   -- text|image|video|audio|list
      mediaUrl TEXT DEFAULT '',
      createdAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',
      mediaUrl TEXT DEFAULT '',
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      avatarUrl TEXT DEFAULT '',
      isChannel INTEGER NOT NULL DEFAULT 0,
      owner TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', -- owner|admin|member
      joinedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, username)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS verification_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      orgName TEXT NOT NULL,
      role TEXT NOT NULL,
      proofUrl TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
      createdAt INTEGER NOT NULL,
      decidedAt INTEGER
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_msg ON messages(chatType, sender, receiver, createdAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_st_exp ON stories(expiresAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(username)`);
});

function parseSettings(u) {
  try { return JSON.parse(u.settings || "{}"); } catch { return {}; }
}

function safeUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || "",
    avatarUrl: u.avatarUrl || "",
    birthDate: u.birthDate || "",
    verified: !!u.verified,
    totpEnabled: !!u.totpEnabled,
    settings: parseSettings(u)
  };
}

function signToken(username, extra = {}) {
  // Long-lived on purpose: this is a personal messenger, not a banking app —
  // people shouldn't be forced to log back in every couple of weeks. Signing
  // out (or deleting the account) in Settings is what actually ends a session.
  return jwt.sign({ username, ...extra }, EFFECTIVE_JWT_SECRET, { expiresIn: "365d" });
}

function verifyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (decoded.purpose) return res.status(401).json({ ok: false, error: "Неверный токен" }); // reject 2FA pending tokens here
    db.get(`SELECT * FROM users WHERE username=?`, [decoded.username], (err, user) => {
      if (!user) return res.status(401).json({ ok: false, error: "Пользователь не найден" });
      if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
      req.user = user;
      next();
    });
  } catch {
    return res.status(401).json({ ok: false, error: "Неверный токен" });
  }
}

// The admin panel authenticates separately from regular users — a fixed
// login/password pair (see ADMIN_LOGIN/ADMIN_PASSWORD above), completely
// independent of any user account. verifySuperAdmin checks that special
// session token; it never touches the `users` table.
function verifySuperAdmin(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена админа" });

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (decoded.role !== "superadmin") return res.status(403).json({ ok: false, error: "Доступ только для админов" });
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Сессия админа истекла, войди заново" });
  }
}

function guessMediaType(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.includes("audio")) return "audio";
  return "text";
}

function cleanupStories() {
  db.run(`DELETE FROM stories WHERE expiresAt <= ?`, [now()]);
}
setInterval(cleanupStories, 60 * 1000);

// ---------------- SIMPLE RATE LIMITER (auth endpoints) ----------------
const rateBuckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + ":" + req.path;
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now() + windowMs };
    if (now() > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now() + windowMs;
    }
    bucket.count++;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) {
      return res.status(429).json({ ok: false, error: "Слишком много попыток, попробуй позже" });
    }
    next();
  };
}
setInterval(() => {
  const t = now();
  for (const [k, v] of rateBuckets) if (t > v.resetAt) rateBuckets.delete(k);
}, 5 * 60 * 1000);

// ================================================================
// TOTP (RFC 6238) — implemented with only the built-in `crypto` module,
// no extra npm dependency required.
// ================================================================
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = "";
  for (const byte of buf) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length || i < bits.length; i += 5) {
    const chunk = bits.substr(i, 5).padEnd(5, "0");
    out += BASE32_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return Buffer.from(bytes);
}

function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160-bit secret
}

function totpAt(secretBase32, timeStepCounter) {
  const key = base32Decode(secretBase32);
  const msg = Buffer.alloc(8);
  msg.writeBigInt64BE(BigInt(timeStepCounter));
  const hmac = crypto.createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, "0");
}

function verifyTotp(secretBase32, code, window = 1) {
  const cleanCode = String(code || "").trim();
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const counter = Math.floor(now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (totpAt(secretBase32, counter + w) === cleanCode) return true;
  }
  return false;
}

function otpauthUrl(username, secret) {
  const label = encodeURIComponent(`${APP_NAME}:${username}`);
  const issuer = encodeURIComponent(APP_NAME);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;
}

// ---------------- AUTH ----------------
app.post("/api/auth/register", rateLimit(10, 60 * 1000), async (req, res) => {
  const usernameRaw = String(req.body.username || "").trim().replace(/^@+/, "").toLowerCase();
  const password = String(req.body.password || "").trim();

  if (!/^[a-z0-9_]{4,20}$/.test(usernameRaw)) {
    return res.status(400).json({ ok: false, error: "Юзернейм 4-20: a-z 0-9 _" });
  }
  if (password.length < 6) return res.status(400).json({ ok: false, error: "Пароль минимум 6 символов" });

  const hash = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users (username, passwordHash, displayName, createdAt) VALUES (?,?,?,?)`,
    [usernameRaw, hash, usernameRaw, now()],
    function (err) {
      if (err) return res.status(400).json({ ok: false, error: "Юзернейм занят" });

      db.get(`SELECT * FROM users WHERE username=?`, [usernameRaw], (e2, user) => {
        res.json({ ok: true, token: signToken(usernameRaw), user: safeUser(user) });
      });
    }
  );
});

app.post("/api/auth/login", rateLimit(10, 60 * 1000), (req, res) => {
  const usernameRaw = String(req.body.identifier || req.body.username || "").trim().replace(/^@+/, "").toLowerCase();
  const password = String(req.body.password || "").trim();

  db.get(`SELECT * FROM users WHERE username=?`, [usernameRaw], async (err, user) => {
    if (!user) return res.status(400).json({ ok: false, error: "Пользователь не найден" });
    if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ ok: false, error: "Неверный пароль" });

    if (user.totpEnabled) {
      const pendingToken = signToken(usernameRaw, { purpose: "2fa" });
      return res.json({ ok: true, need2FA: true, pendingToken });
    }

    res.json({ ok: true, token: signToken(usernameRaw), user: safeUser(user) });
  });
});

app.post("/api/auth/2fa-verify", rateLimit(15, 60 * 1000), (req, res) => {
  const pendingToken = String(req.body.pendingToken || "");
  const code = String(req.body.code || "");

  let decoded;
  try {
    decoded = jwt.verify(pendingToken, EFFECTIVE_JWT_SECRET);
  } catch {
    return res.status(401).json({ ok: false, error: "Сессия истекла, войди заново" });
  }
  if (decoded.purpose !== "2fa") return res.status(401).json({ ok: false, error: "Неверный токен" });

  db.get(`SELECT * FROM users WHERE username=?`, [decoded.username], (err, user) => {
    if (!user || !user.totpEnabled) return res.status(400).json({ ok: false, error: "2FA не включена" });
    if (!verifyTotp(user.totpSecret, code)) return res.status(400).json({ ok: false, error: "Неверный код" });

    res.json({ ok: true, token: signToken(user.username), user: safeUser(user) });
  });
});

// ---------------- 2FA MANAGEMENT ----------------
app.post("/api/2fa/setup", verifyAuth, (req, res) => {
  const secret = generateTotpSecret();
  db.run(`UPDATE users SET totpSecret=? WHERE username=?`, [secret, req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка" });
    res.json({ ok: true, secret, otpauthUrl: otpauthUrl(req.user.username, secret) });
  });
});

app.post("/api/2fa/confirm", verifyAuth, (req, res) => {
  const code = String(req.body.code || "");
  if (!req.user.totpSecret) return res.status(400).json({ ok: false, error: "Сначала вызови /api/2fa/setup" });
  if (!verifyTotp(req.user.totpSecret, code)) return res.status(400).json({ ok: false, error: "Неверный код" });

  db.run(`UPDATE users SET totpEnabled=1 WHERE username=?`, [req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка" });
    res.json({ ok: true });
  });
});

app.post("/api/2fa/disable", verifyAuth, async (req, res) => {
  const password = String(req.body.password || "");
  const ok = await bcrypt.compare(password, req.user.passwordHash);
  if (!ok) return res.status(400).json({ ok: false, error: "Неверный пароль" });

  db.run(`UPDATE users SET totpEnabled=0, totpSecret='' WHERE username=?`, [req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка" });
    res.json({ ok: true });
  });
});

// ---------------- PROFILE ----------------
app.get("/api/me", verifyAuth, (req, res) => res.json({ ok: true, profile: safeUser(req.user) }));

// Self-service account deletion — requires the account's own password as
// confirmation. Wipes everything tied to the username: messages, stories,
// group memberships, then the user row itself, and disconnects any open
// sessions for that account.
app.delete("/api/me", verifyAuth, async (req, res) => {
  const password = String(req.body.password || "");
  const ok = await bcrypt.compare(password, req.user.passwordHash);
  if (!ok) return res.status(400).json({ ok: false, error: "Неверный пароль" });

  const u = req.user.username;
  await dbRun(`DELETE FROM messages WHERE sender=? OR receiver=?`, [u, u]);
  await dbRun(`DELETE FROM stories WHERE owner=?`, [u]);
  await dbRun(`DELETE FROM group_members WHERE username=?`, [u]);
  await dbRun(`DELETE FROM users WHERE username=?`, [u]);

  closeAllConnections(u);
  res.json({ ok: true });
});

app.put("/api/me", verifyAuth, (req, res) => {
  const displayName = String(req.body.displayName || "").trim().slice(0, 40);
  const bio = String(req.body.bio || "").trim().slice(0, 200);
  const birthDate = String(req.body.birthDate || "").trim().slice(0, 20);
  const avatarUrl = String(req.body.avatarUrl || "").trim().slice(0, 300);

  db.run(
    `UPDATE users SET displayName=?, bio=?, birthDate=?, avatarUrl=? WHERE username=?`,
    [displayName, bio, birthDate, avatarUrl, req.user.username],
    (err) => {
      if (err) return res.status(500).json({ ok: false, error: "Ошибка обновления" });
      db.get(`SELECT * FROM users WHERE username=?`, [req.user.username], (e2, user) => {
        res.json({ ok: true, profile: safeUser(user) });
      });
    }
  );
});

// Theme / wallpaper / accent color — small free-form JSON blob per user,
// synced across their devices.
app.put("/api/me/settings", verifyAuth, (req, res) => {
  const current = parseSettings(req.user);
  const incoming = req.body && typeof req.body === "object" ? req.body : {};
  const allowed = ["theme", "wallpaper", "accent"];
  const merged = { ...current };
  for (const k of allowed) {
    if (typeof incoming[k] === "string" && incoming[k].length <= 4000) merged[k] = incoming[k];
  }

  db.run(`UPDATE users SET settings=? WHERE username=?`, [JSON.stringify(merged), req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения настроек" });
    res.json({ ok: true, settings: merged });
  });
});

// Upload a profile picture straight from the device's gallery/camera,
// instead of forcing the person to paste an image URL. Reuses the same
// upload safety rules as chat media (mimetype whitelist, size limit,
// mimetype-derived extension) but writes only to the user's own avatarUrl —
// it never creates a chat message.
app.post("/api/me/avatar", verifyAuth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || "Ошибка загрузки" });
    next();
  });
}, (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  if (guessMediaType(req.file.mimetype) !== "image") {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ ok: false, error: "Аватар должен быть изображением" });
  }

  const ext = MIME_EXT[req.file.mimetype] || "";
  const newName = `avatar-${req.file.filename}${ext}`;
  fs.renameSync(req.file.path, path.join(uploadsDir, newName));
  const avatarUrl = `/uploads/${newName}`;

  db.run(`UPDATE users SET avatarUrl=? WHERE username=?`, [avatarUrl, req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения" });
    res.json({ ok: true, avatarUrl });
  });
});

// search users
app.get("/api/users/search", verifyAuth, (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^@+/, "").toLowerCase();
  if (!q) return res.json({ ok: true, users: [] });

  db.all(
    `SELECT username, displayName, bio, avatarUrl, verified
     FROM users
     WHERE username LIKE ? AND username != ? AND banned=0
     ORDER BY username ASC LIMIT 20`,
    [`%${q}%`, req.user.username],
    (err, rows) => res.json({ ok: true, users: rows || [] })
  );
});

app.get("/api/users/:username", verifyAuth, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  // birthDate is intentionally left out here — only the owner sees it via /api/me.
  db.get(
    `SELECT username, displayName, bio, avatarUrl, verified FROM users WHERE username=? AND banned=0`,
    [u],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: "Не найден" });
      res.json({ ok: true, user: row });
    }
  );
});

// ---------------- VERIFICATION (official badge) ----------------
app.post("/api/verification/request", verifyAuth, rateLimit(5, 60 * 60 * 1000), (req, res) => {
  const orgName = String(req.body.orgName || "").trim().slice(0, 120);
  const role = String(req.body.role || "").trim().slice(0, 80);
  const proofUrl = String(req.body.proofUrl || "").trim().slice(0, 300);

  if (!orgName || !role || !proofUrl) {
    return res.status(400).json({ ok: false, error: "Заполни организацию, должность и ссылку-подтверждение" });
  }
  if (!/^https?:\/\//i.test(proofUrl)) {
    return res.status(400).json({ ok: false, error: "Ссылка должна начинаться с http(s)://" });
  }

  db.run(
    `INSERT INTO verification_requests (username, orgName, role, proofUrl, status, createdAt) VALUES (?,?,?,?, 'pending', ?)`,
    [req.user.username, orgName, role, proofUrl, now()],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: "Ошибка отправки заявки" });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

app.get("/api/verification/mine", verifyAuth, (req, res) => {
  db.all(
    `SELECT * FROM verification_requests WHERE username=? ORDER BY createdAt DESC LIMIT 10`,
    [req.user.username],
    (err, rows) => res.json({ ok: true, requests: rows || [] })
  );
});

app.get("/api/admin/verification-requests", verifySuperAdmin, (req, res) => {
  db.all(
    `SELECT * FROM verification_requests WHERE status='pending' ORDER BY createdAt ASC LIMIT 100`,
    (err, rows) => res.json({ ok: true, requests: rows || [] })
  );
});

app.post("/api/admin/verification-requests/:id/approve", verifySuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.get(`SELECT * FROM verification_requests WHERE id=?`, [id], (err, reqRow) => {
    if (!reqRow || reqRow.status !== "pending") return res.status(404).json({ ok: false, error: "Заявка не найдена" });

    db.run(`UPDATE verification_requests SET status='approved', decidedAt=? WHERE id=?`, [now(), id]);
    db.run(`UPDATE users SET verified=1 WHERE username=?`, [reqRow.username], (e2) => {
      if (e2) return res.status(500).json({ ok: false, error: "Ошибка" });
      res.json({ ok: true });
    });
  });
});

app.post("/api/admin/verification-requests/:id/reject", verifySuperAdmin, (req, res) => {
  const id = Number(req.params.id);
  db.run(`UPDATE verification_requests SET status='rejected', decidedAt=? WHERE id=? AND status='pending'`, [now(), id], function (err) {
    if (err || this.changes === 0) return res.status(404).json({ ok: false, error: "Заявка не найдена" });
    res.json({ ok: true });
  });
});

// ================================================================
// GROUPS & CHANNELS
// A channel is just a group with isChannel=1: only owner/admins may post,
// everyone else can only read.
// ================================================================
async function isMember(groupId, username) {
  const row = await dbGet(`SELECT role FROM group_members WHERE groupId=? AND username=?`, [groupId, username]);
  return row ? row.role : null; // null | 'member' | 'admin' | 'owner'
}

app.get("/api/groups", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT g.*, gm.role AS myRole
     FROM groups g JOIN group_members gm ON gm.groupId=g.id
     WHERE gm.username=?
     ORDER BY g.createdAt DESC`,
    [req.user.username]
  );
  res.json({ ok: true, groups: rows });
});

app.post("/api/groups", verifyAuth, async (req, res) => {
  const name = String(req.body.name || "").trim().slice(0, 60);
  const description = String(req.body.description || "").trim().slice(0, 300);
  const isChannel = req.body.isChannel ? 1 : 0;
  const members = Array.isArray(req.body.members) ? req.body.members : [];

  if (!name) return res.status(400).json({ ok: false, error: "Название обязательно" });

  const createdAt = now();
  const result = await dbRun(
    `INSERT INTO groups (name, description, isChannel, owner, createdAt) VALUES (?,?,?,?,?)`,
    [name, description, isChannel, req.user.username, createdAt]
  );
  const groupId = result.lastID;

  await dbRun(`INSERT INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,'owner',?)`, [groupId, req.user.username, createdAt]);

  const cleanMembers = [...new Set(members.map(m => String(m || "").replace(/^@+/, "").toLowerCase()))].filter(m => m && m !== req.user.username);
  for (const m of cleanMembers) {
    const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [m]);
    if (exists) await dbRun(`INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,'member',?)`, [groupId, m, createdAt]);
  }

  res.json({ ok: true, id: groupId });
});

app.get("/api/groups/:id", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const role = await isMember(groupId, req.user.username);
  if (!role) return res.status(403).json({ ok: false, error: "Ты не участник" });

  const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [groupId]);
  if (!group) return res.status(404).json({ ok: false, error: "Не найдено" });

  const members = await dbAll(
    `SELECT gm.username, gm.role, u.displayName, u.avatarUrl, u.verified
     FROM group_members gm JOIN users u ON u.username=gm.username
     WHERE gm.groupId=? ORDER BY (gm.role='owner') DESC, (gm.role='admin') DESC, gm.username ASC`,
    [groupId]
  );

  res.json({ ok: true, group, members, myRole: role });
});

app.post("/api/groups/:id/members", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const role = await isMember(groupId, req.user.username);
  if (role !== "owner" && role !== "admin") return res.status(403).json({ ok: false, error: "Недостаточно прав" });

  const username = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [username]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  await dbRun(`INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,'member',?)`, [groupId, username, now()]);
  res.json({ ok: true });
});

app.delete("/api/groups/:id/members/:username", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const target = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const role = await isMember(groupId, req.user.username);

  const selfLeave = target === req.user.username;
  if (!selfLeave && role !== "owner" && role !== "admin") {
    return res.status(403).json({ ok: false, error: "Недостаточно прав" });
  }
  const targetRole = await isMember(groupId, target);
  if (targetRole === "owner" && !selfLeave) {
    return res.status(400).json({ ok: false, error: "Нельзя удалить владельца группы" });
  }

  await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [groupId, target]);
  res.json({ ok: true });
});

// ---------------- CHATS (private list) ----------------
app.get("/api/chats", verifyAuth, (req, res) => {
  const me = req.user.username;

  db.all(
    `
    SELECT other, MAX(createdAt) AS lastAt
    FROM (
      SELECT CASE WHEN sender=? THEN receiver ELSE sender END AS other, createdAt
      FROM messages
      WHERE chatType='private' AND (sender=? OR receiver=?)
    )
    GROUP BY other
    ORDER BY lastAt DESC
    LIMIT 50
    `,
    [me, me, me],
    (err, rows) => {
      const others = (rows || []).map(r => r.other).filter(Boolean);
      if (others.length === 0) return res.json({ ok: true, chats: [] });

      const placeholders = others.map(() => "?").join(",");
      db.all(
        `SELECT username, displayName, avatarUrl, verified FROM users WHERE username IN (${placeholders})`,
        others,
        (e2, users) => {
          const map = new Map((users || []).map(u => [u.username, u]));
          db.all(
            `
            SELECT sender, receiver, text, mediaType, createdAt
            FROM messages
            WHERE chatType='private' AND (sender=? OR receiver=?)
            ORDER BY createdAt DESC
            LIMIT 400
            `,
            [me, me],
            (e3, msgs) => {
              const preview = new Map();
              (msgs || []).forEach(m => {
                const other = m.sender === me ? m.receiver : m.sender;
                if (!preview.has(other)) {
                  preview.set(other, (m.mediaType !== "text" ? `[${m.mediaType}]` : (m.text || "")));
                }
              });

              const out = others.map(o => {
                const u = map.get(o) || { username: o, displayName: o, avatarUrl: "", verified: 0 };
                return {
                  username: u.username,
                  displayName: u.displayName || u.username,
                  avatarUrl: u.avatarUrl || "",
                  verified: !!u.verified,
                  preview: preview.get(o) || ""
                };
              });

              res.json({ ok: true, chats: out });
            }
          );
        }
      );
    }
  );
});

// ---------------- MESSAGES ----------------
app.get("/api/messages", verifyAuth, async (req, res) => {
  const chat = String(req.query.chat || "global").replace(/^@+/, "").toLowerCase();
  const me = req.user.username;

  if (chat === "global") {
    const rows = await dbAll(`SELECT * FROM messages WHERE chatType='global' ORDER BY createdAt ASC LIMIT 500`);
    return res.json({ ok: true, messages: rows });
  }

  if (chat.startsWith("group:")) {
    const groupId = Number(chat.slice(6));
    const role = await isMember(groupId, me);
    if (!role) return res.status(403).json({ ok: false, error: "Ты не участник этой группы" });

    const rows = await dbAll(
      `SELECT * FROM messages WHERE chatType='group' AND receiver=? ORDER BY createdAt ASC LIMIT 800`,
      [chat]
    );
    return res.json({ ok: true, messages: rows });
  }

  const other = chat;
  const rows = await dbAll(
    `
    SELECT * FROM messages
    WHERE chatType='private'
      AND ((sender=? AND receiver=?) OR (sender=? AND receiver=?))
    ORDER BY createdAt ASC
    LIMIT 800
    `,
    [me, other, other, me]
  );
  res.json({ ok: true, messages: rows });
});

app.delete("/api/messages/:id", verifyAuth, (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;

  db.get(`SELECT * FROM messages WHERE id=?`, [id], (err, row) => {
    if (!row) return res.status(404).json({ ok: false, error: "Не найдено" });
    if (row.sender !== me) return res.status(403).json({ ok: false, error: "Можно удалить только своё" });

    db.run(`DELETE FROM messages WHERE id=?`, [id], async (e2) => {
      if (e2) return res.status(500).json({ ok: false, error: "Ошибка удаления" });

      await broadcastDelete(row, id);
      res.json({ ok: true });
    });
  });
});

// Shopping / to-do list toggle (REST fallback; the primary path is via WS,
// see 'list-toggle' below).
app.post("/api/messages/:id/list-toggle", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const itemIndex = Number(req.body.itemIndex);
  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row || row.mediaType !== "list") return res.status(404).json({ ok: false, error: "Список не найден" });

  const allowed = await canPostTo(row.chatType, row.receiver, req.user.username);
  if (!allowed.canRead) return res.status(403).json({ ok: false, error: "Нет доступа" });

  let list;
  try { list = JSON.parse(row.text); } catch { return res.status(500).json({ ok: false, error: "Повреждённые данные" }); }
  if (!list.items || !list.items[itemIndex]) return res.status(400).json({ ok: false, error: "Неверный пункт" });

  list.items[itemIndex].checked = !list.items[itemIndex].checked;
  await dbRun(`UPDATE messages SET text=? WHERE id=?`, [JSON.stringify(list), id]);

  await broadcastToChat(row.chatType, row.receiver, req.user.username, { type: "listUpdated", id, list });
  res.json({ ok: true, list });
});

// ---------------- UPLOAD ----------------
app.post("/api/upload", verifyAuth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || "Ошибка загрузки" });
    next();
  });
}, async (req, res) => {
  const me = req.user.username;

  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено отправлять сообщения" });

  const receiver = String(req.body.receiver || "global").replace(/^@+/, "").toLowerCase();
  const chatType = receiver.startsWith("group:") ? "group" : (receiver === "global" ? "global" : "private");
  const text = String(req.body.text || "").trim().slice(0, 2000);

  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  const perm = await canPostTo(chatType, receiver, me);
  if (!perm.canPost) return res.status(403).json({ ok: false, error: perm.error || "Нет доступа" });

  const mediaType = guessMediaType(req.file.mimetype);
  const ext = MIME_EXT[req.file.mimetype] || "";
  const newName = `${req.file.filename}${ext}`;
  fs.renameSync(req.file.path, path.join(uploadsDir, newName));
  const mediaUrl = `/uploads/${newName}`;

  const createdAt = now();
  db.run(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt)
     VALUES (?,?,?,?,?,?,?)`,
    [chatType, me, receiver, text, mediaType, mediaUrl, createdAt],
    async function (err) {
      if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения" });

      const msg = { id: this.lastID, chatType, sender: me, receiver, text, mediaType, mediaUrl, createdAt };
      await broadcastToChat(chatType, receiver, me, { type: "message", message: msg });
      res.json({ ok: true, message: msg });
    }
  );
});

// ---------------- STORIES ----------------
app.get("/api/stories", verifyAuth, (req, res) => {
  cleanupStories();
  db.all(
    `
    SELECT s.*, u.displayName, u.avatarUrl, u.verified
    FROM stories s
    LEFT JOIN users u ON u.username=s.owner
    WHERE s.expiresAt > ? AND u.banned=0
    ORDER BY s.createdAt DESC
    LIMIT 200
    `,
    [now()],
    (err, rows) => res.json({ ok: true, stories: rows || [] })
  );
});

app.post("/api/stories", verifyAuth, (req, res, next) => {
  upload.single("story")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || "Ошибка загрузки" });
    next();
  });
}, (req, res) => {
  const me = req.user.username;
  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено публиковать сторис" });

  const text = String(req.body.text || "").trim().slice(0, 120);

  const createdAt = now();
  const expiresAt = createdAt + 2 * 60 * 60 * 1000; // stories now expire after 2h (no cap on how many you can post)

  let mediaType = "text";
  let mediaUrl = "";

  if (req.file) {
    mediaType = guessMediaType(req.file.mimetype);
    const ext = MIME_EXT[req.file.mimetype] || "";
    const newName = `story-${req.file.filename}${ext}`;
    fs.renameSync(req.file.path, path.join(uploadsDir, newName));
    mediaUrl = `/uploads/${newName}`;
  }

  if (!text && !mediaUrl) return res.status(400).json({ ok: false, error: "Сторис пустая" });

  db.run(
    `INSERT INTO stories (owner,text,mediaType,mediaUrl,createdAt,expiresAt) VALUES (?,?,?,?,?,?)`,
    [me, text, mediaType, mediaUrl, createdAt, expiresAt],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: "Ошибка сторис" });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ---------------- BIRTHDAYS ----------------
app.get("/api/birthdays/today", verifyAuth, (req, res) => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");

  db.all(
    `SELECT username, displayName, avatarUrl
     FROM users
     WHERE substr(birthDate,6,2)=? AND substr(birthDate,9,2)=? AND banned=0`,
    [mm, dd],
    (err, rows) => res.json({ ok: true, list: rows || [] })
  );
});

// ================================================================
// ADMIN — separate credential-based login, independent of user accounts
// ================================================================
app.post("/api/admin/login", rateLimit(10, 5 * 60 * 1000), (req, res) => {
  const login = String(req.body.login || "");
  const password = String(req.body.password || "");

  const loginOk = timingSafeStrEqual(login, ADMIN_LOGIN);
  const passOk = timingSafeStrEqual(password, ADMIN_PASSWORD);

  if (!loginOk || !passOk) {
    return res.status(401).json({ ok: false, error: "Неверный логин или пароль" });
  }

  const token = jwt.sign({ role: "superadmin" }, EFFECTIVE_JWT_SECRET, { expiresIn: "12h" });
  res.json({ ok: true, token });
});

// Every /api/admin/* route below requires the superadmin session token —
// it has nothing to do with any user's own login token.

app.get("/api/admin/users", verifySuperAdmin, (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const where = q ? `WHERE username LIKE ?` : "";
  const params = q ? [`%${q}%`] : [];

  db.all(
    `SELECT username, displayName, avatarUrl, banned, muted, verified, createdAt FROM users ${where} ORDER BY createdAt DESC LIMIT 200`,
    params,
    (err, rows) => res.json({ ok: true, users: rows || [] })
  );
});

app.get("/api/admin/user/:username", verifySuperAdmin, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  db.get(
    `SELECT username, displayName, bio, avatarUrl, birthDate, banned, muted, verified, createdAt FROM users WHERE username=?`,
    [u],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: "Не найден" });
      res.json({ ok: true, user: row });
    }
  );
});

// "С кем общается" — every private chat partner (with last message time and
// preview) plus every group/channel this user belongs to. This is the
// unrestricted moderation view: it does not filter by any block/privacy
// setting, by design, since it's meant for investigating reports/abuse.
app.get("/api/admin/user/:username/overview", verifySuperAdmin, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();

  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
  if (!exists) return res.status(404).json({ ok: false, error: "Не найден" });

  const partners = await dbAll(
    `
    SELECT other AS username, MAX(createdAt) AS lastAt, COUNT(*) AS total
    FROM (
      SELECT CASE WHEN sender=? THEN receiver ELSE sender END AS other, createdAt
      FROM messages WHERE chatType='private' AND (sender=? OR receiver=?)
    )
    GROUP BY other
    ORDER BY lastAt DESC
    `,
    [u, u, u]
  );

  const groups = await dbAll(
    `SELECT g.id, g.name, g.isChannel, gm.role
     FROM groups g JOIN group_members gm ON gm.groupId=g.id
     WHERE gm.username=?
     ORDER BY g.createdAt DESC`,
    [u]
  );

  const globalCount = await dbGet(`SELECT COUNT(*) AS c FROM messages WHERE chatType='global' AND sender=?`, [u]);

  res.json({ ok: true, partners, groups, globalMessageCount: globalCount.c });
});

// Full thread between two specific users — the actual "переписка" view.
app.get("/api/admin/messages/private/:userA/:userB", verifySuperAdmin, async (req, res) => {
  const a = String(req.params.userA || "").replace(/^@+/, "").toLowerCase();
  const b = String(req.params.userB || "").replace(/^@+/, "").toLowerCase();

  const rows = await dbAll(
    `SELECT * FROM messages WHERE chatType='private' AND ((sender=? AND receiver=?) OR (sender=? AND receiver=?)) ORDER BY createdAt ASC LIMIT 2000`,
    [a, b, b, a]
  );
  res.json({ ok: true, messages: rows });
});

app.get("/api/admin/messages/group/:id", verifySuperAdmin, async (req, res) => {
  const groupId = Number(req.params.id);
  const rows = await dbAll(
    `SELECT * FROM messages WHERE chatType='group' AND receiver=? ORDER BY createdAt ASC LIMIT 2000`,
    [`group:${groupId}`]
  );
  res.json({ ok: true, messages: rows });
});

app.get("/api/admin/messages/global", verifySuperAdmin, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM messages WHERE chatType='global' ORDER BY createdAt DESC LIMIT 500`);
  res.json({ ok: true, messages: rows });
});

// Admin can remove any single message while reviewing a thread (separate
// from a user deleting their own message via /api/messages/:id).
app.delete("/api/admin/messages/:id", verifySuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ ok: false, error: "Не найдено" });

  await dbRun(`DELETE FROM messages WHERE id=?`, [id]);
  await broadcastDelete(row, id);
  res.json({ ok: true });
});

function adminSetFlag(field, value) {
  return (req, res) => {
    const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();

    db.run(`UPDATE users SET ${field}=? WHERE username=?`, [value, u], function (err) {
      if (err || this.changes === 0) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

      if (field === "banned" && value === 1) {
        closeAllConnections(u);
      }
      res.json({ ok: true });
    });
  };
}

app.post("/api/admin/ban/:username", verifySuperAdmin, adminSetFlag("banned", 1));
app.post("/api/admin/unban/:username", verifySuperAdmin, adminSetFlag("banned", 0));
app.post("/api/admin/mute/:username", verifySuperAdmin, adminSetFlag("muted", 1));
app.post("/api/admin/unmute/:username", verifySuperAdmin, adminSetFlag("muted", 0));

app.delete("/api/admin/delete/:username", verifySuperAdmin, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();

  db.run(`DELETE FROM users WHERE username=?`, [u], function (err) {
    if (err || this.changes === 0) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

    db.run(`DELETE FROM messages WHERE sender=? OR receiver=?`, [u, u]);
    db.run(`DELETE FROM stories WHERE owner=?`, [u]);
    db.run(`DELETE FROM group_members WHERE username=?`, [u]);

    closeAllConnections(u);

    res.json({ ok: true });
  });
});

// ================================================================
// WEBSOCKET (messages + typing + presence + calls + groups + lists)
// ================================================================
// online: username -> Set<ws>. A person can have several tabs/devices open
// at once; we only consider them offline once EVERY connection for that
// username has closed, not just the most recent one.
const online = new Map();

function addOnline(username, ws) {
  if (!online.has(username)) online.set(username, new Set());
  online.get(username).add(ws);
}
function removeOnline(username, ws) {
  const set = online.get(username);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) online.delete(username);
}
function isOnline(username) {
  const set = online.get(username);
  return !!set && set.size > 0;
}
function wsSendToUser(username, payload) {
  const set = online.get(username);
  if (!set) return;
  for (const ws of set) wsSend(ws, payload);
}
function closeAllConnections(username) {
  const set = online.get(username);
  if (!set) return;
  for (const ws of [...set]) { try { ws.close(); } catch {} }
}

function wsSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastAll(payload) {
  for (const set of online.values()) for (const ws of set) wsSend(ws, payload);
}

function broadcastPresence() {
  const list = Array.from(online.keys());
  broadcastAll({ type: "presence", online: list });
}

// Central permission check for posting/reading a chat target.
// chatType: 'global' | 'private' | 'group'; receiver: 'global' | username | 'group:<id>'
async function canPostTo(chatType, receiver, username) {
  if (chatType === "global") return { canPost: true, canRead: true };
  if (chatType === "private") return { canPost: true, canRead: true }; // either side of a DM can always post
  if (chatType === "group") {
    const groupId = Number(String(receiver).slice(6));
    const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [groupId]);
    if (!group) return { canPost: false, canRead: false, error: "Группа не найдена" };
    const role = await isMember(groupId, username);
    if (!role) return { canPost: false, canRead: false, error: "Ты не участник этой группы" };
    if (group.isChannel && role === "member") return { canPost: false, canRead: true, error: "В этом канале писать могут только администраторы" };
    return { canPost: true, canRead: true };
  }
  return { canPost: false, canRead: false };
}

async function recipientsFor(chatType, receiver, sender) {
  if (chatType === "global") return Array.from(online.keys());
  if (chatType === "private") return [sender, receiver];
  if (chatType === "group") {
    const groupId = Number(String(receiver).slice(6));
    const rows = await dbAll(`SELECT username FROM group_members WHERE groupId=?`, [groupId]);
    return rows.map(r => r.username);
  }
  return [];
}

async function broadcastToChat(chatType, receiver, sender, payload) {
  const usernames = await recipientsFor(chatType, receiver, sender);
  for (const u of usernames) wsSendToUser(u, payload);
}

async function broadcastMessage(msg) {
  await broadcastToChat(msg.chatType, msg.receiver, msg.sender, { type: "message", message: msg });
}

async function broadcastDelete(row, id) {
  await broadcastToChat(row.chatType, row.receiver, row.sender, { type: "messageDeleted", id });
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || "";
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (decoded.purpose) return ws.close(); // reject 2FA pending tokens
    const username = String(decoded.username || "");

    db.get(`SELECT * FROM users WHERE username=?`, [username], (err, user) => {
      if (!user || user.banned) return ws.close();

      ws.username = username;
      addOnline(username, ws);

      wsSend(ws, { type: "ws-ready", username });
      broadcastPresence();

      ws.on("message", async (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || !data.type) return;

        const from = ws.username;

        // typing indicator
        if (data.type === "typing") {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          if (to.startsWith("group:")) {
            const groupId = Number(to.slice(6));
            const members = await dbAll(`SELECT username FROM group_members WHERE groupId=?`, [groupId]);
            for (const m of members) if (m.username !== from) wsSendToUser(m.username, { type: "typing", from, to, isTyping: !!data.isTyping });
          } else {
            wsSendToUser(to, { type: "typing", from, isTyping: !!data.isTyping });
          }
          return;
        }

        // WebRTC audio call signaling (private calls only)
        if (["call-offer", "call-answer", "ice", "call-end", "call-reject"].includes(data.type)) {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          if (!isOnline(to)) return wsSend(ws, { type: "call-error", message: "Пользователь не онлайн" });
          wsSendToUser(to, { ...data, from });
          return;
        }

        // plain text message (works for global / private / group)
        if (data.type === "text-message") {
          const user = await dbGet(`SELECT muted, banned FROM users WHERE username=?`, [from]);
          if (!user || user.banned || user.muted) return;

          const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
          const chatType = receiver.startsWith("group:") ? "group" : (receiver === "global" ? "global" : "private");
          const text = String(data.text || "").trim().slice(0, 2000);
          if (!text) return;

          const perm = await canPostTo(chatType, receiver, from);
          if (!perm.canPost) return wsSend(ws, { type: "call-error", message: perm.error || "Нет доступа" });

          const createdAt = now();
          const result = await dbRun(
            `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES (?,?,?,?,?,?,?)`,
            [chatType, from, receiver, text, "text", "", createdAt]
          );
          const msg = { id: result.lastID, chatType, sender: from, receiver, text, mediaType: "text", mediaUrl: "", createdAt };
          await broadcastMessage(msg);
          return;
        }

        // shopping / to-do list message: { receiver, title, items: [string, ...] }
        if (data.type === "list-message") {
          const user = await dbGet(`SELECT muted, banned FROM users WHERE username=?`, [from]);
          if (!user || user.banned || user.muted) return;

          const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
          const chatType = receiver.startsWith("group:") ? "group" : (receiver === "global" ? "global" : "private");
          const title = String(data.title || "Список").trim().slice(0, 80);
          const items = (Array.isArray(data.items) ? data.items : [])
            .map(t => String(t || "").trim().slice(0, 200))
            .filter(Boolean)
            .slice(0, 50)
            .map(text => ({ text, checked: false }));
          if (items.length === 0) return;

          const perm = await canPostTo(chatType, receiver, from);
          if (!perm.canPost) return wsSend(ws, { type: "call-error", message: perm.error || "Нет доступа" });

          const list = { title, items };
          const createdAt = now();
          const result = await dbRun(
            `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES (?,?,?,?,?,?,?)`,
            [chatType, from, receiver, JSON.stringify(list), "list", "", createdAt]
          );
          const msg = { id: result.lastID, chatType, sender: from, receiver, text: JSON.stringify(list), mediaType: "list", mediaUrl: "", createdAt };
          await broadcastMessage(msg);
          return;
        }

        // toggle one item in a shopping/to-do list
        if (data.type === "list-toggle") {
          const id = Number(data.id);
          const itemIndex = Number(data.itemIndex);
          const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
          if (!row || row.mediaType !== "list") return;

          const perm = await canPostTo(row.chatType, row.receiver, from);
          if (!perm.canRead) return;

          let list;
          try { list = JSON.parse(row.text); } catch { return; }
          if (!list.items || !list.items[itemIndex]) return;

          list.items[itemIndex].checked = !list.items[itemIndex].checked;
          await dbRun(`UPDATE messages SET text=? WHERE id=?`, [JSON.stringify(list), id]);
          await broadcastToChat(row.chatType, row.receiver, from, { type: "listUpdated", id, list });
          return;
        }
      });

      ws.on("close", () => {
        if (ws.username) removeOnline(ws.username, ws);
        broadcastPresence();
      });
    });
  } catch {
    ws.close();
  }
});

server.listen(PORT, () => console.log("Server running on", PORT));
