const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { createClient } = require("@libsql/client");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
let webpush = null;
try {
  webpush = require("web-push");
} catch {
  console.warn(
    "[PUSH] The 'web-push' package isn't installed yet — run `npm install` " +
    "after pulling this update (it's now in package.json). Real push " +
    "notifications will be disabled until then; everything else still works."
  );
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

// JWT secret and VAPID (push) keys used to live in local files — which was
// wrong for the exact same reason database.db was: Render's free tier wipes
// that disk on every restart. They now live in Turso too (a tiny key-value
// table), generated once and reused forever after. An explicit env var, if
// you set one, always takes priority.
let EFFECTIVE_JWT_SECRET = process.env.JWT_SECRET || "";
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

// Sends a real OS-level push notification to every device/browser this
// user has subscribed from — used specifically for people who are NOT
// currently connected over the websocket (site/tab actually closed).
// Expired/invalid subscriptions (410/404 from the push service) are
// cleaned up automatically.
async function sendPushToUser(username, payload) {
  if (!webpush) return;
  const subs = await dbAll(`SELECT * FROM push_subscriptions WHERE username=?`, [username]);
  for (const row of subs) {
    let sub;
    try { sub = JSON.parse(row.subscriptionJson); } catch { continue; }
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (err) {
      if (err && (err.statusCode === 410 || err.statusCode === 404)) {
        db.run(`DELETE FROM push_subscriptions WHERE endpoint=?`, [row.endpoint]);
      }
    }
  }
}
const APP_NAME = "One Messenger";

// ---------------- GIFTS (emoji gifts on profiles) ----------------
// Free to send every Friday, or any day at all if the sender knows one of
// these secret codes. Change this env var any time you like — it's read
// fresh on every request, so it never touches (or wipes) any existing
// user, story, or gift already in the database.
const GIFT_SECRET_CODES = String(process.env.GIFT_SECRET_CODES || "777,666")
  .split(",").map(s => s.trim()).filter(Boolean);
const GIFT_EMOJIS = ["🎁", "🌟", "💎", "🔥", "❤️", "🏆", "👑", "✨", "🎉", "🌹"];

function isGiftDay() {
  return new Date().getDay() === 5; // Friday
}

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

// Files are kept in memory only (never written to Render's ephemeral disk)
// and handed straight to saveUploadedFile() below, which stores them as
// blobs in Turso — the exact same always-on database everything else in
// this file already relies on. No separate storage provider to sign up for.
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 } // 20MB — see note by the /media/:id route below
});

// ---------------- FILE STORAGE (blobs inside Turso, no external service) ----------------
// Saves a file as a row in Turso and returns a URL (/media/<id>) that the
// GET route further down serves it back from. Since Turso IS the database
// this whole app already depends on, this needs no extra account, no extra
// env vars, and survives restarts exactly as well as everything else does.
async function saveUploadedFile(buffer, mimetype, keyPrefix) {
  const id = `${keyPrefix}-${crypto.randomBytes(16).toString("hex")}`;
  await dbRun(
    `INSERT INTO media_blobs (id, mimetype, data, createdAt) VALUES (?,?,?,?)`,
    [id, mimetype, buffer, now()]
  );
  return `/media/${id}`;
}

// Serves a previously uploaded file back out of Turso. No auth required —
// this plays the same public role the old /uploads static folder did (an
// <img>/<video>/<audio> src has to be fetchable without extra headers).
// IDs are random 32-hex-char tokens, so this isn't browsable/guessable.
app.get("/media/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-z]+-[0-9a-f]{32}$/.test(id)) return res.status(404).end();

  try {
    const row = await dbGet(`SELECT mimetype, data FROM media_blobs WHERE id=?`, [id]);
    if (!row) return res.status(404).end();

    res.setHeader("Content-Type", row.mimetype);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable"); // ids are random & content never changes
    res.send(Buffer.from(row.data));
  } catch {
    res.status(500).end();
  }
});

// ================================================================
// DATABASE — Turso (libSQL), not a local file.
//
// Render's Free plan wipes the whole local disk every time the service
// spins down from inactivity (~15 min) — that includes database.db itself,
// which is exactly why accounts/messages/sessions kept disappearing. Turso
// is a separate, always-on, SQLite-compatible database with a generous free
// tier, so data now survives restarts, redeploys, and sleep/wake cycles.
//
// Create one at https://turso.tech (free), then set on Render:
//   TURSO_DATABASE_URL   e.g. libsql://your-db-name.turso.io
//   TURSO_AUTH_TOKEN     the token Turso gives you for that database
//
// Everything below this block (db.run/db.get/db.all, dbRun/dbGet/dbAll)
// keeps the exact same shape as before — this is a compatibility shim, so
// none of the ~50 queries elsewhere in this file needed to change.
// ================================================================
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || "";
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || "";

if (!TURSO_DATABASE_URL || !TURSO_AUTH_TOKEN) {
  console.error(
    "[FATAL] TURSO_DATABASE_URL and/or TURSO_AUTH_TOKEN are not set. " +
    "Create a free database at https://turso.tech and set both in Render " +
    "-> Environment. Without them, nothing can be saved anywhere."
  );
}

const turso = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });

function toArgs(params) {
  return Array.isArray(params) ? params : [];
}

const db = {
  run(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    turso.execute({ sql, args: toArgs(params) })
      .then((result) => {
        if (callback) {
          const ctx = { lastID: Number(result.lastInsertRowid || 0), changes: result.rowsAffected || 0 };
          callback.call(ctx, null);
        }
      })
      .catch((err) => { if (callback) callback(err); else console.error("[DB] run error:", err.message); });
  },
  get(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    turso.execute({ sql, args: toArgs(params) })
      .then((result) => callback(null, result.rows[0]))
      .catch((err) => callback(err));
  },
  all(sql, params, callback) {
    if (typeof params === "function") { callback = params; params = []; }
    turso.execute({ sql, args: toArgs(params) })
      .then((result) => callback(null, result.rows))
      .catch((err) => callback(err));
  },
  // sqlite3's serialize() just queued callbacks in order; the schema setup
  // below now awaits each statement directly instead, so this is a no-op
  // kept only so nothing else calling db.serialize(...) breaks.
  serialize(fn) { fn(); }
};

const now = () => Date.now();
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r || [])));
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r || null)));
const dbRun = function (sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
};

// Schema setup — sequential and awaited (unlike sqlite3's fire-and-forget
// .serialize(), a remote database needs each CREATE/ALTER to actually finish
// before the next one that might depend on it runs).
async function initSchema() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Uploaded photos/videos/voice notes/avatars, stored as blobs right here
  // in Turso — no separate storage provider needed. Served back by the
  // GET /media/:id route further down.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS media_blobs (
      id TEXT PRIMARY KEY,
      mimetype TEXT NOT NULL,
      data BLOB NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);

  await dbRun(`
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

  // Safe to run repeatedly against an existing DB; errors if a column
  // already exists, which we just swallow.
  const addCol = async (col, def) => { try { await dbRun(`ALTER TABLE users ADD COLUMN ${col} ${def}`); } catch {} };
  await addCol("banned", "INTEGER NOT NULL DEFAULT 0");
  await addCol("muted", "INTEGER NOT NULL DEFAULT 0");
  await addCol("verified", "INTEGER NOT NULL DEFAULT 0");
  await addCol("totpSecret", "TEXT NOT NULL DEFAULT ''");
  await addCol("totpEnabled", "INTEGER NOT NULL DEFAULT 0");
  await addCol("settings", "TEXT NOT NULL DEFAULT '{}'"); // { theme, wallpaper, accent, storyPrivacy, bioPrivacy }

  await dbRun(`
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

  await dbRun(`
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

  await dbRun(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      avatarUrl TEXT DEFAULT '',
      isChannel INTEGER NOT NULL DEFAULT 0,
      discoverable INTEGER NOT NULL DEFAULT 0,
      owner TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  { const addGroupCol = async (col, def) => { try { await dbRun(`ALTER TABLE groups ADD COLUMN ${col} ${def}`); } catch {} };
    await addGroupCol("discoverable", "INTEGER NOT NULL DEFAULT 0"); }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', -- owner|admin|member
      joinedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, username)
    )
  `);

  // Bans are separate from just removing someone: a banned username can't
  // rejoin a discoverable group or be re-added by an admin until unbanned.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS group_bans (
      groupId INTEGER NOT NULL,
      username TEXT NOT NULL,
      bannedBy TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, username)
    )
  `);

  // Purely cosmetic emoji "gifts" people can send to each other's profile.
  // Gating (Friday / secret code) lives entirely in application code below,
  // never in the schema — so changing the code or the day rule later never
  // touches this table or any existing row in it.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS gifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      recipient TEXT NOT NULL,
      emoji TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_gifts_recipient ON gifts(recipient, createdAt)`);

  // One-directional "friends" list: each user curates their own list of who
  // counts as a "friend" for THEIR privacy settings (bio/story visibility).
  // No approval flow — you decide who to add, same as a "close friends" list.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS friends (
      owner TEXT NOT NULL,
      friend TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (owner, friend)
    )
  `);

  // A login record per successful sign-in — powers both the admin panel's
  // "sessions" view and the person's own "Мои сессии" list. `jti` ties a
  // row to the actual JWT that was issued at that login, so "завершить
  // сессию" here is a REAL revocation (verifyAuth checks it below), not
  // just deleting a log line.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      jti TEXT,
      ip TEXT DEFAULT '',
      userAgent TEXT DEFAULT '',
      revoked INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL
    )
  `);
  { const addSessCol = async (col, def) => { try { await dbRun(`ALTER TABLE sessions ADD COLUMN ${col} ${def}`); } catch {} };
    await addSessCol("jti", "TEXT");
    await addSessCol("revoked", "INTEGER NOT NULL DEFAULT 0"); }
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username, createdAt)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sessions_jti ON sessions(jti)`);

  // Real push subscriptions (Web Push), so notifications can arrive even
  // when the site/tab is completely closed, not just while it's open.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      subscriptionJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_push_username ON push_subscriptions(username)`);

  await dbRun(`
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

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_msg ON messages(chatType, sender, receiver, createdAt)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_st_exp ON stories(expiresAt)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(username)`);
}

const schemaReady = initSchema()
  .then(() => console.log("[DB] Turso schema ready"))
  .catch((e) => console.error("[DB] Schema initialization failed:", e.message));

// Load (or generate, once) the JWT secret and VAPID push keys from that
// app_secrets table, instead of local disk files. An env var, if set,
// always wins and skips the DB entirely for that one value.
async function getOrCreateSecret(key, generator) {
  const row = await dbGet(`SELECT value FROM app_secrets WHERE key=?`, [key]);
  if (row && row.value) return row.value;

  const value = generator();
  await dbRun(`INSERT INTO app_secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, [key, value]);
  // Someone else (a concurrent boot) may have inserted first — re-read to
  // make sure every instance ends up agreeing on the same secret.
  const confirmed = await dbGet(`SELECT value FROM app_secrets WHERE key=?`, [key]);
  return confirmed ? confirmed.value : value;
}

const secretsReady = schemaReady.then(async () => {
  if (!EFFECTIVE_JWT_SECRET) {
    EFFECTIVE_JWT_SECRET = await getOrCreateSecret("jwt_secret", () => crypto.randomBytes(48).toString("hex"));
  }

  if (webpush && (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY)) {
    const stored = await getOrCreateSecret("vapid_keys", () => JSON.stringify(webpush.generateVAPIDKeys()));
    try {
      const parsed = JSON.parse(stored);
      VAPID_PUBLIC_KEY = parsed.publicKey;
      VAPID_PRIVATE_KEY = parsed.privateKey;
    } catch (e) {
      console.warn("[PUSH] Could not parse stored VAPID keys, push disabled:", e.message);
    }
  }
  if (webpush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  }
}).catch((e) => console.error("[SECRETS] Failed to load/create secrets:", e.message));


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

    const proceed = (user) => {
      if (!user) return res.status(401).json({ ok: false, error: "Пользователь не найден" });
      if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
      req.user = user;
      req.sessionJti = decoded.jti || null;
      next();
    };

    if (decoded.jti) {
      // A session someone revoked from "Мои сессии" (or an admin ban that
      // closes it) must stop working immediately, not just disappear from
      // a list — so every request re-checks this.
      db.get(`SELECT revoked FROM sessions WHERE jti=?`, [decoded.jti], (e1, sessRow) => {
        if (sessRow && sessRow.revoked) return res.status(401).json({ ok: false, error: "Эта сессия была завершена, войди заново" });
        db.get(`SELECT * FROM users WHERE username=?`, [decoded.username], (e2, user) => proceed(user));
      });
    } else {
      db.get(`SELECT * FROM users WHERE username=?`, [decoded.username], (e2, user) => proceed(user));
    }
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

// 'support' is a reserved pseudo-account (see RESERVED_USERNAMES) — talking
// to it works exactly like a private DM, except the other party isn't a
// real row in `users`; admin replies use sender='support'.
function resolveChatType(receiver) {
  if (receiver.startsWith("group:")) return "group";
  if (receiver === "global") return "global";
  if (receiver === "support") return "support";
  return "private";
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
const RESERVED_USERNAMES = ["global", "support", "admin", "one", "onemessenger"];

app.post("/api/auth/register", rateLimit(10, 60 * 1000), async (req, res) => {
  const usernameRaw = String(req.body.username || "").trim().replace(/^@+/, "").toLowerCase();
  const password = String(req.body.password || "").trim();

  if (!/^[a-z0-9_]{4,20}$/.test(usernameRaw)) {
    return res.status(400).json({ ok: false, error: "Юзернейм 4-20: a-z 0-9 _" });
  }
  if (RESERVED_USERNAMES.includes(usernameRaw)) {
    return res.status(400).json({ ok: false, error: "Этот юзернейм зарезервирован системой" });
  }
  if (password.length < 6) return res.status(400).json({ ok: false, error: "Пароль минимум 6 символов" });

  const hash = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users (username, passwordHash, displayName, createdAt) VALUES (?,?,?,?)`,
    [usernameRaw, hash, usernameRaw, now()],
    function (err) {
      if (err) return res.status(400).json({ ok: false, error: "Юзернейм занят" });

      db.get(`SELECT * FROM users WHERE username=?`, [usernameRaw], async (e2, user) => {
        const jti = await recordSession(req, usernameRaw);
        res.json({ ok: true, token: signToken(usernameRaw, { jti }), user: safeUser(user) });
      });
    }
  );
});

async function recordSession(req, username) {
  const ip = String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const userAgent = String(req.headers["user-agent"] || "").slice(0, 300);
  const jti = crypto.randomUUID();
  await dbRun(`INSERT INTO sessions (username, jti, ip, userAgent, createdAt) VALUES (?,?,?,?,?)`, [username, jti, ip, userAgent, now()]).catch(() => {});
  return jti;
}

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

    const jti = await recordSession(req, usernameRaw);
    res.json({ ok: true, token: signToken(usernameRaw, { jti }), user: safeUser(user) });
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

  db.get(`SELECT * FROM users WHERE username=?`, [decoded.username], async (err, user) => {
    if (!user || !user.totpEnabled) return res.status(400).json({ ok: false, error: "2FA не включена" });
    if (!verifyTotp(user.totpSecret, code)) return res.status(400).json({ ok: false, error: "Неверный код" });

    const jti = await recordSession(req, user.username);
    res.json({ ok: true, token: signToken(user.username, { jti }), user: safeUser(user) });
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

// Theme / wallpaper / accent color, plus privacy choices (who can see your
// bio and stories) — all a small free-form JSON blob per user, synced
// across devices.
app.put("/api/me/settings", verifyAuth, (req, res) => {
  const current = parseSettings(req.user);
  const incoming = req.body && typeof req.body === "object" ? req.body : {};
  const merged = { ...current };

  const freeform = ["theme", "wallpaper", "accent"];
  for (const k of freeform) {
    if (typeof incoming[k] === "string" && incoming[k].length <= 4000) merged[k] = incoming[k];
  }

  const privacyEnum = ["everyone", "friends", "nobody"];
  for (const k of ["storyPrivacy", "bioPrivacy"]) {
    if (privacyEnum.includes(incoming[k])) merged[k] = incoming[k];
  }

  db.run(`UPDATE users SET settings=? WHERE username=?`, [JSON.stringify(merged), req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения настроек" });
    res.json({ ok: true, settings: merged });
  });
});

// ---------------- FRIENDS (your own "who counts as close to me" list) ----------------
// One-directional by design: you decide who's in this list for the purpose
// of YOUR OWN privacy settings (bio/story visibility) — no request/approval
// flow, same as e.g. Instagram's "close friends".
app.get("/api/friends", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT u.username, u.displayName, u.avatarUrl, u.verified
     FROM friends f JOIN users u ON u.username=f.friend
     WHERE f.owner=? ORDER BY u.username ASC`,
    [req.user.username]
  );
  res.json({ ok: true, friends: rows });
});

app.post("/api/friends", verifyAuth, async (req, res) => {
  const friend = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  if (friend === req.user.username) return res.status(400).json({ ok: false, error: "Нельзя добавить самого себя" });

  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [friend]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  await dbRun(`INSERT OR IGNORE INTO friends (owner, friend, createdAt) VALUES (?,?,?)`, [req.user.username, friend, now()]);
  res.json({ ok: true });
});

app.delete("/api/friends/:username", verifyAuth, async (req, res) => {
  const friend = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  await dbRun(`DELETE FROM friends WHERE owner=? AND friend=?`, [req.user.username, friend]);
  res.json({ ok: true });
});

async function isFriendOf(ownerUsername, viewerUsername) {
  if (ownerUsername === viewerUsername) return true;
  const row = await dbGet(`SELECT 1 FROM friends WHERE owner=? AND friend=?`, [ownerUsername, viewerUsername]);
  return !!row;
}

// Checks a privacy setting ('everyone'|'friends'|'nobody', default
// 'everyone') stored on the OWNER's account against who's asking.
async function isAllowedByPrivacy(ownerUser, viewerUsername, settingKey) {
  if (ownerUser.username === viewerUsername) return true;
  const setting = parseSettings(ownerUser)[settingKey] || "everyone";
  if (setting === "everyone") return true;
  if (setting === "nobody") return false;
  return isFriendOf(ownerUser.username, viewerUsername);
}

// ---------------- WEB PUSH SUBSCRIPTIONS ----------------
app.get("/api/push/public-key", verifyAuth, (req, res) => {
  if (!webpush || !VAPID_PUBLIC_KEY) return res.json({ ok: true, publicKey: null });
  res.json({ ok: true, publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", verifyAuth, async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: "Некорректная подписка" });

  await dbRun(
    `INSERT INTO push_subscriptions (endpoint, username, subscriptionJson, createdAt) VALUES (?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET username=excluded.username, subscriptionJson=excluded.subscriptionJson`,
    [sub.endpoint, req.user.username, JSON.stringify(sub), now()]
  );
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", verifyAuth, async (req, res) => {
  const endpoint = String(req.body.endpoint || "");
  if (endpoint) await dbRun(`DELETE FROM push_subscriptions WHERE endpoint=?`, [endpoint]);
  res.json({ ok: true });
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
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  if (guessMediaType(req.file.mimetype) !== "image") {
    return res.status(400).json({ ok: false, error: "Аватар должен быть изображением" });
  }

  const avatarUrl = await saveUploadedFile(req.file.buffer, req.file.mimetype, "avatar");

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

app.get("/api/users/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  // birthDate is intentionally left out here — only the owner sees it via /api/me.
  const row = await dbGet(
    `SELECT username, displayName, bio, avatarUrl, verified, settings FROM users WHERE username=? AND banned=0`,
    [u]
  );
  if (!row) return res.status(404).json({ ok: false, error: "Не найден" });

  const bioAllowed = await isAllowedByPrivacy(row, req.user.username, "bioPrivacy");
  res.json({
    ok: true,
    user: {
      username: row.username,
      displayName: row.displayName,
      avatarUrl: row.avatarUrl,
      verified: row.verified,
      bio: bioAllowed ? row.bio : ""
    }
  });
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
  const discoverable = req.body.discoverable ? 1 : 0;
  const members = Array.isArray(req.body.members) ? req.body.members : [];

  if (!name) return res.status(400).json({ ok: false, error: "Название обязательно" });

  const createdAt = now();
  const result = await dbRun(
    `INSERT INTO groups (name, description, isChannel, discoverable, owner, createdAt) VALUES (?,?,?,?,?,?)`,
    [name, description, isChannel, discoverable, req.user.username, createdAt]
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

// Public discovery: popular public groups/channels (owner opted in via
// "discoverable"), ranked by member count, with optional name search.
// Excludes ones the person is already in.
app.get("/api/groups/discover", verifyAuth, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const rows = await dbAll(
    `
    SELECT g.id, g.name, g.description, g.avatarUrl, g.isChannel,
           (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.groupId=g.id) AS memberCount
    FROM groups g
    WHERE g.discoverable=1
      AND g.id NOT IN (SELECT groupId FROM group_members WHERE username=?)
      AND (? = '' OR LOWER(g.name) LIKE '%' || ? || '%')
    ORDER BY memberCount DESC
    LIMIT 50
    `,
    [req.user.username, q, q]
  );
  res.json({ ok: true, groups: rows });
});

async function isBanned(groupId, username) {
  const row = await dbGet(`SELECT 1 FROM group_bans WHERE groupId=? AND username=?`, [groupId, username]);
  return !!row;
}

app.post("/api/groups/:id/join", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const group = await dbGet(`SELECT * FROM groups WHERE id=?`, [groupId]);
  if (!group) return res.status(404).json({ ok: false, error: "Не найдено" });
  if (!group.discoverable) return res.status(403).json({ ok: false, error: "Эта группа закрытая — нужно приглашение" });
  if (await isBanned(groupId, req.user.username)) return res.status(403).json({ ok: false, error: "Ты забанен(а) в этой группе" });

  await dbRun(`INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?,?,'member',?)`, [groupId, req.user.username, now()]);
  res.json({ ok: true });
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

  let bans = [];
  if (role === "owner" || role === "admin") {
    bans = await dbAll(
      `SELECT gb.username, gb.bannedBy, gb.createdAt, u.displayName, u.avatarUrl
       FROM group_bans gb LEFT JOIN users u ON u.username=gb.username
       WHERE gb.groupId=? ORDER BY gb.createdAt DESC`,
      [groupId]
    );
  }

  res.json({ ok: true, group, members, bans, myRole: role });
});

app.post("/api/groups/:id/members", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const role = await isMember(groupId, req.user.username);
  if (role !== "owner" && role !== "admin") return res.status(403).json({ ok: false, error: "Недостаточно прав" });

  const username = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [username]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });
  if (await isBanned(groupId, username)) return res.status(403).json({ ok: false, error: "Этот пользователь забанен — сначала разбань его" });

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
  // Admins ("moderators") may only manage regular members — not each other,
  // and never the owner. Only the owner outranks another admin.
  if (!selfLeave && role === "admin" && targetRole === "admin") {
    return res.status(403).json({ ok: false, error: "Админ не может убрать другого админа — только владелец" });
  }

  await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [groupId, target]);
  res.json({ ok: true });
});

// Ban = remove + block from rejoining/being re-added, until unbanned.
// Same escalation rule as removing: an admin can ban regular members but
// not other admins or the owner; the owner can ban anyone but themselves.
app.post("/api/groups/:id/members/:username/ban", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const target = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const role = await isMember(groupId, req.user.username);
  if (role !== "owner" && role !== "admin") return res.status(403).json({ ok: false, error: "Недостаточно прав" });
  if (target === req.user.username) return res.status(400).json({ ok: false, error: "Нельзя забанить самого себя" });

  const targetRole = await isMember(groupId, target);
  if (targetRole === "owner") return res.status(400).json({ ok: false, error: "Нельзя забанить владельца группы" });
  if (role === "admin" && targetRole === "admin") return res.status(403).json({ ok: false, error: "Админ не может забанить другого админа" });

  await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [groupId, target]);
  await dbRun(
    `INSERT INTO group_bans (groupId, username, bannedBy, createdAt) VALUES (?,?,?,?)
     ON CONFLICT(groupId, username) DO UPDATE SET bannedBy=excluded.bannedBy, createdAt=excluded.createdAt`,
    [groupId, target, req.user.username, now()]
  );
  res.json({ ok: true });
});

app.post("/api/groups/:id/members/:username/unban", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const target = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const role = await isMember(groupId, req.user.username);
  if (role !== "owner" && role !== "admin") return res.status(403).json({ ok: false, error: "Недостаточно прав" });

  await dbRun(`DELETE FROM group_bans WHERE groupId=? AND username=?`, [groupId, target]);
  res.json({ ok: true });
});

// Deletes the whole group/channel — owner only, irreversible.
app.delete("/api/groups/:id", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const role = await isMember(groupId, req.user.username);
  if (role !== "owner") return res.status(403).json({ ok: false, error: "Удалить может только владелец" });

  await dbRun(`DELETE FROM messages WHERE chatType='group' AND receiver=?`, [`group:${groupId}`]);
  await dbRun(`DELETE FROM group_members WHERE groupId=?`, [groupId]);
  await dbRun(`DELETE FROM group_bans WHERE groupId=?`, [groupId]);
  await dbRun(`DELETE FROM groups WHERE id=?`, [groupId]);
  res.json({ ok: true });
});

// Promote a member to admin, or demote an admin back to member. Only the
// group's owner can do this — admins granting/revoking other admins would
// let them lock the owner out, so it's kept a single-person decision.
app.post("/api/groups/:id/members/:username/role", verifyAuth, async (req, res) => {
  const groupId = Number(req.params.id);
  const target = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const newRole = String(req.body.role || "");

  if (!["admin", "member"].includes(newRole)) return res.status(400).json({ ok: false, error: "Недопустимая роль" });

  const myRole = await isMember(groupId, req.user.username);
  if (myRole !== "owner") return res.status(403).json({ ok: false, error: "Менять роли может только владелец" });

  const targetRole = await isMember(groupId, target);
  if (!targetRole) return res.status(404).json({ ok: false, error: "Не участник группы" });
  if (targetRole === "owner") return res.status(400).json({ ok: false, error: "Нельзя менять роль владельца" });

  await dbRun(`UPDATE group_members SET role=? WHERE groupId=? AND username=?`, [newRole, groupId, target]);
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

  if (chat === "support") {
    const rows = await dbAll(
      `SELECT * FROM messages WHERE chatType='support' AND ((sender=? AND receiver='support') OR (sender='support' AND receiver=?)) ORDER BY createdAt ASC LIMIT 500`,
      [me, me]
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
  const chatType = resolveChatType(receiver);
  const text = String(req.body.text || "").trim().slice(0, 2000);

  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  const perm = await canPostTo(chatType, receiver, me);
  if (!perm.canPost) return res.status(403).json({ ok: false, error: perm.error || "Нет доступа" });

  const mediaType = guessMediaType(req.file.mimetype);
  const mediaUrl = await saveUploadedFile(req.file.buffer, req.file.mimetype, "msg");

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
app.get("/api/stories", verifyAuth, async (req, res) => {
  cleanupStories();
  const rows = await dbAll(
    `
    SELECT s.*, u.displayName, u.avatarUrl, u.verified, u.settings AS ownerSettings
    FROM stories s
    LEFT JOIN users u ON u.username=s.owner
    WHERE s.expiresAt > ? AND u.banned=0
    ORDER BY s.createdAt DESC
    LIMIT 200
    `,
    [now()]
  );

  const visible = [];
  for (const row of rows) {
    const ownerLike = { username: row.owner, settings: row.ownerSettings };
    if (await isAllowedByPrivacy(ownerLike, req.user.username, "storyPrivacy")) {
      delete row.ownerSettings;
      visible.push(row);
    }
  }
  res.json({ ok: true, stories: visible });
});

// A specific person's currently-active stories, for viewing "their full
// profile with their stories" — respects the same storyPrivacy setting as
// the main feed above.
app.get("/api/stories/user/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const owner = await dbGet(`SELECT username, settings FROM users WHERE username=? AND banned=0`, [u]);
  if (!owner) return res.status(404).json({ ok: false, error: "Не найден" });

  if (!(await isAllowedByPrivacy(owner, req.user.username, "storyPrivacy"))) {
    return res.json({ ok: true, stories: [] });
  }

  const rows = await dbAll(
    `SELECT * FROM stories WHERE owner=? AND expiresAt > ? ORDER BY createdAt DESC LIMIT 50`,
    [u, now()]
  );
  res.json({ ok: true, stories: rows });
});

// Full personal archive — every story you've ever posted, active or
// long expired, so you can always look back at what you shared. Only
// the owner can see their own archive this way (others still only ever
// see the active-story preview via the endpoints above).
app.get("/api/stories/mine", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT * FROM stories WHERE owner=? ORDER BY createdAt DESC LIMIT 500`,
    [req.user.username]
  );
  const withStatus = rows.map(s => ({ ...s, active: s.expiresAt > now() }));
  res.json({ ok: true, stories: withStatus });
});

app.delete("/api/stories/:id", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = await dbGet(`SELECT * FROM stories WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ ok: false, error: "Не найдена" });
  if (row.owner !== req.user.username) return res.status(403).json({ ok: false, error: "Можно удалить только свою историю" });

  await dbRun(`DELETE FROM stories WHERE id=?`, [id]);
  res.json({ ok: true });
});

app.post("/api/stories", verifyAuth, (req, res, next) => {
  upload.single("story")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || "Ошибка загрузки" });
    next();
  });
}, async (req, res) => {
  const me = req.user.username;
  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено публиковать сторис" });

  const text = String(req.body.text || "").trim().slice(0, 120);

  const createdAt = now();
  const expiresAt = createdAt + 2 * 60 * 60 * 1000; // stories now expire after 2h (no cap on how many you can post)

  let mediaType = "text";
  let mediaUrl = "";

  if (req.file) {
    mediaType = guessMediaType(req.file.mimetype);
    mediaUrl = await saveUploadedFile(req.file.buffer, req.file.mimetype, "story");
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

// ---------------- GIFTS ----------------
app.get("/api/gifts/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const rows = await dbAll(
    `SELECT sender, emoji, createdAt FROM gifts WHERE recipient=? ORDER BY createdAt DESC LIMIT 100`,
    [u]
  );
  res.json({ ok: true, gifts: rows });
});

app.post("/api/gifts/send", verifyAuth, rateLimit(30, 60 * 1000), async (req, res) => {
  const recipient = String(req.body.recipient || "").replace(/^@+/, "").toLowerCase();
  const emoji = String(req.body.emoji || "");
  const code = String(req.body.code || "").trim();

  if (!GIFT_EMOJIS.includes(emoji)) return res.status(400).json({ ok: false, error: "Недопустимый подарок" });
  if (recipient === req.user.username) return res.status(400).json({ ok: false, error: "Нельзя подарить самому себе" });

  const exists = await dbGet(`SELECT username FROM users WHERE username=? AND banned=0`, [recipient]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  const codeOk = code && GIFT_SECRET_CODES.includes(code);
  if (!isGiftDay() && !codeOk) {
    return res.status(403).json({ ok: false, error: "Подарки бесплатно — только по пятницам, либо по секретному коду" });
  }

  await dbRun(
    `INSERT INTO gifts (sender, recipient, emoji, createdAt) VALUES (?,?,?,?)`,
    [req.user.username, recipient, emoji, now()]
  );

  wsSendToUser(recipient, { type: "giftReceived", from: req.user.username, emoji });
  if (!isOnline(recipient)) {
    sendPushToUser(recipient, { title: "Подарок 🎁", body: `@${req.user.username} подарил тебе ${emoji}`, url: "/chat.html" }).catch(() => {});
  }
  res.json({ ok: true });
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

// All logins across every user — a global "sessions" feed for the admin
// panel: who logged in, when, and from what IP/device.
app.get("/api/admin/sessions", verifySuperAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const rows = await dbAll(
    q
      ? `SELECT * FROM sessions WHERE username LIKE ? ORDER BY createdAt DESC LIMIT 200`
      : `SELECT * FROM sessions ORDER BY createdAt DESC LIMIT 200`,
    q ? [`%${q}%`] : []
  );
  const withOnline = rows.map(r => ({ ...r, online: isOnline(r.username) }));
  res.json({ ok: true, sessions: withOnline });
});

app.post("/api/admin/sessions/:id/revoke", verifySuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await dbRun(`UPDATE sessions SET revoked=1 WHERE id=?`, [id]);
  res.json({ ok: true });
});

// One user's own login history (used by the account-level "Sessions" view
// in Settings, not just the admin panel).
app.get("/api/me/sessions", verifyAuth, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM sessions WHERE username=? AND revoked=0 ORDER BY createdAt DESC LIMIT 50`, [req.user.username]);
  const withCurrent = rows.map(s => ({ ...s, current: !!req.sessionJti && s.jti === req.sessionJti }));
  res.json({ ok: true, sessions: withCurrent });
});

// Self-service: end any OTHER session (a device that isn't this one) —
// no admin rights needed, just proof it's your own account. Marks it
// revoked so that device's token is rejected on its very next request,
// not just removed from this list.
app.delete("/api/me/sessions/:id", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const session = await dbGet(`SELECT * FROM sessions WHERE id=?`, [id]);
  if (!session || session.username !== req.user.username) return res.status(404).json({ ok: false, error: "Сессия не найдена" });
  if (req.sessionJti && session.jti === req.sessionJti) {
    return res.status(400).json({ ok: false, error: "Это твоя текущая сессия — используй «Выйти», а не это" });
  }

  await dbRun(`UPDATE sessions SET revoked=1 WHERE id=?`, [id]);
  res.json({ ok: true });
});

// ---------------- SUPPORT (tied into the admin panel) ----------------
// Every user can message the reserved 'support' pseudo-account from their
// own chat list; every conversation shows up here for an admin to answer.
app.get("/api/admin/support/conversations", verifySuperAdmin, async (req, res) => {
  const rows = await dbAll(
    `
    SELECT other AS username, MAX(createdAt) AS lastAt, COUNT(*) AS total,
           SUM(CASE WHEN sender != 'support' THEN 1 ELSE 0 END) AS fromUser
    FROM (
      SELECT CASE WHEN sender='support' THEN receiver ELSE sender END AS other, sender, createdAt
      FROM messages WHERE chatType='support'
    )
    GROUP BY other
    ORDER BY lastAt DESC
    LIMIT 100
    `
  );
  res.json({ ok: true, conversations: rows });
});

app.get("/api/admin/support/:username", verifySuperAdmin, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const rows = await dbAll(
    `SELECT * FROM messages WHERE chatType='support' AND ((sender=? AND receiver='support') OR (sender='support' AND receiver=?)) ORDER BY createdAt ASC LIMIT 500`,
    [u, u]
  );
  res.json({ ok: true, messages: rows });
});

app.post("/api/admin/support/:username/reply", verifySuperAdmin, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const text = String(req.body.text || "").trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: "Пустое сообщение" });

  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  const createdAt = now();
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES ('support','support',?,?,?,?,?)`,
    [u, text, "text", "", createdAt]
  );
  const msg = { id: result.lastID, chatType: "support", sender: "support", receiver: u, text, mediaType: "text", mediaUrl: "", createdAt };

  await broadcastMessage(msg);
  res.json({ ok: true, message: msg });
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
  if (chatType === "private" || chatType === "support") return { canPost: true, canRead: true }; // either side of a DM (or support thread) can always post
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
  if (chatType === "private" || chatType === "support") return [sender, receiver];
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
  pushNotifyMessage(msg); // fire-and-forget; never blocks the realtime path above
}

// Real push notifications are only for people who are genuinely offline
// (no open tab at all) — anyone with the app open already gets it instantly
// over the websocket. Skipped for the public global chat to avoid spamming
// every single user on every message there.
async function pushNotifyMessage(msg) {
  if (!webpush || msg.chatType === "global") return;

  const recipients = (await recipientsFor(msg.chatType, msg.receiver, msg.sender))
    .filter(u => u !== msg.sender && !isOnline(u));
  if (recipients.length === 0) return;

  const body = msg.mediaType !== "text" ? (msg.mediaType === "list" ? "📋 Список" : `[${msg.mediaType}]`) : (msg.text || "");
  const title = msg.chatType === "group" ? `Группа · @${msg.sender}` : `@${msg.sender}`;

  for (const u of recipients) {
    sendPushToUser(u, { title, body, url: "/chat.html" }).catch(() => {});
  }
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

    const proceedConnection = (user) => {
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
          const chatType = resolveChatType(receiver);
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
          const chatType = resolveChatType(receiver);
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
    };

    const startConnection = () => {
      db.get(`SELECT * FROM users WHERE username=?`, [username], (err, user) => proceedConnection(user));
    };

    if (decoded.jti) {
      db.get(`SELECT revoked FROM sessions WHERE jti=?`, [decoded.jti], (e1, sessRow) => {
        if (sessRow && sessRow.revoked) return ws.close();
        startConnection();
      });
    } else {
      startConnection();
    }
  } catch {
    ws.close();
  }
});

// Wait for the schema AND the JWT/VAPID secrets before accepting any
// traffic — matters most on a brand-new Turso database's very first boot.
secretsReady.finally(() => {
  server.listen(PORT, () => console.log("Server running on", PORT));
});
