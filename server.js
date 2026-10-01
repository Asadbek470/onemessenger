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

// Часовой пояс для дней рождения (в минутах от UTC). По умолчанию Ташкент (UTC+5).
const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || 300);

let EFFECTIVE_JWT_SECRET = process.env.JWT_SECRET || "";
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";

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
const APP_NAME = "UzMessenger";

// ---------------- GIFTS ----------------
const GIFT_SECRET_CODES = String(process.env.GIFT_SECRET_CODES || "777,666")
  .split(",").map(s => s.trim()).filter(Boolean);
const GIFT_EMOJIS = ["🎁", "🌟", "💎", "🔥", "❤️", "🏆", "👑", "✨", "🎉", "🌹"];

function isGiftDay() {
  return new Date().getDay() === 5; // Friday
}

// ---------------- ADMIN CREDENTIALS ----------------
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin2026";
if (!process.env.ADMIN_LOGIN || !process.env.ADMIN_PASSWORD) {
  console.warn(
    "[SECURITY WARNING] ADMIN_LOGIN/ADMIN_PASSWORD are not set — using the " +
    "built-in defaults (admin / admin2026). Set both in your environment " +
    "before deploying anywhere public."
  );
}

// Отдельный, очень длинный код для разблокировки чтения чужих переписок
// в админке. Даже вошедший в панель админ не может открыть чей-то чат,
// пока не введёт этот код — он не то же самое, что пароль от админки.
const ADMIN_MSG_UNLOCK_CODE = process.env.ADMIN_MSG_UNLOCK_CODE || "67411555361557";
if (!process.env.ADMIN_MSG_UNLOCK_CODE) {
  console.warn(
    "[SECURITY WARNING] ADMIN_MSG_UNLOCK_CODE is not set — using the " +
    "built-in default code for unlocking private message reading in the " +
    "admin panel. Set it in your environment before deploying anywhere public."
  );
}

function timingSafeStrEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

app.use(express.json({ limit: "2mb" }));

// ================================================================
// ЛОГОТИП «OM» — рисуется прямо здесь, в коде.
// ================================================================
const zlib = require("zlib");

function pngCrc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const rowLen = size * 4 + 1;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0;
    rgba.copy(raw, y * rowLen + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function isLetterPixel(x, y, S) {
  const cy = 0.5 * S, hh = 0.165 * S, t = 0.07 * S;

  // ---- U ----
  const ux0 = 0.175 * S, ux1 = 0.415 * S;
  const utop = cy - hh;
  const ur = (ux1 - ux0) / 2;
  const ucx = (ux0 + ux1) / 2;
  const ubendY = cy + hh - ur;
  if (segDist(x, y, ux0, utop, ux0, ubendY) <= t / 2) return true;
  if (segDist(x, y, ux1, utop, ux1, ubendY) <= t / 2) return true;
  if (y >= ubendY) {
    const ud = Math.hypot(x - ucx, y - ubendY);
    if (Math.abs(ud - ur) <= t / 2) return true;
  }

  // ---- M ----
  const x0 = 0.56 * S, x1 = 0.84 * S, xm = (x0 + x1) / 2;
  const top = cy - hh, bot = cy + hh, mid = cy + hh * 0.35, w = t / 2;
  if (segDist(x, y, x0, bot, x0, top) <= w) return true;
  if (segDist(x, y, x1, bot, x1, top) <= w) return true;
  if (segDist(x, y, x0, top, xm, mid) <= w) return true;
  if (segDist(x, y, xm, mid, x1, top) <= w) return true;
  return false;
}

function isInsideRoundedSquare(x, y, S, r) {
  const cx = Math.min(Math.max(x, r), S - r);
  const cy = Math.min(Math.max(y, r), S - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

const iconCache = new Map();

function buildIcon(S) {
  if (iconCache.has(S)) return iconCache.get(S);

  const px = Buffer.alloc(S * S * 4);
  const radius = S * 0.23;
  const AA = 3;
  const c1 = [42, 157, 244];
  const c2 = [106, 92, 255];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let inside = 0, letter = 0;
      for (let sy = 0; sy < AA; sy++) {
        for (let sx = 0; sx < AA; sx++) {
          const fx = x + (sx + 0.5) / AA, fy = y + (sy + 0.5) / AA;
          if (isInsideRoundedSquare(fx, fy, S, radius)) {
            inside++;
            if (isLetterPixel(fx, fy, S)) letter++;
          }
        }
      }
      const n = AA * AA;
      const alpha = inside / n;
      const white = letter / n / Math.max(alpha, 0.0001);
      const grad = (x + y) / (2 * (S - 1));
      const i = (y * S + x) * 4;
      for (let k = 0; k < 3; k++) {
        const bg = c1[k] * (1 - grad) + c2[k] * grad;
        px[i + k] = Math.round(bg * (1 - white) + 255 * white);
      }
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  const out = encodePng(S, px);
  iconCache.set(S, out);
  return out;
}

function serveIcon(size) {
  return (req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=604800");
    res.send(buildIcon(size));
  };
}

app.get("/icon-192.png", serveIcon(192));
app.get("/icon-512.png", serveIcon(512));
app.get("/favicon.ico", serveIcon(64));

app.get("/manifest.json", (req, res) => {
  res.json({
    name: APP_NAME,
    short_name: "UM",
    start_url: "/chat.html",
    display: "standalone",
    background_color: "#0b1420",
    theme_color: "#0b1420",
    icons: [
      { src: "/icon-192.png?v=2", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png?v=2", sizes: "512x512", type: "image/png", purpose: "any" }
    ]
  });
});

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // HTML и JS — часто меняются, браузер не должен кэшировать их надолго,
    // иначе после деплоя люди продолжают видеть старую версию (старые
    // переводы, старый код) пока сами не сделают hard-refresh.
    if (/\.(html|js)$/i.test(filePath)) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

// ---------------- CUSTOMIZATION HELPERS ----------------
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const WALLPAPER_PRESETS = ["default", "night", "ocean", "sunset", "forest", "aurora", "rose", "graphite", "lavender", "mint"];
function isValidWallpaper(v) {
  return typeof v === "string" && (WALLPAPER_PRESETS.includes(v) || /^\/media\/[a-z]+-[0-9a-f]{32}$/.test(v));
}
function cleanEmojiStatus(v) {
  const s = String(v || "").replace(/[<>&"'`\\]/g, "").trim();
  return Array.from(s).slice(0, 8).join("");
}

function pad2(n) { return String(n).padStart(2, "0"); }
function localToday() {
  const d = new Date(Date.now() + TZ_OFFSET_MINUTES * 60000);
  return { yyyy: d.getUTCFullYear(), mm: pad2(d.getUTCMonth() + 1), dd: pad2(d.getUTCDate()) };
}
function isBirthdayToday(bd) {
  if (!bd || !/^\d{4}-\d{2}-\d{2}$/.test(bd)) return false;
  const t = localToday();
  return bd.slice(5) === `${t.mm}-${t.dd}`;
}

// ---------------- UPLOAD SAFETY ----------------
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
  "audio/x-wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac"
};

function normMime(m) {
  return String(m || "").toLowerCase().split(";")[0].trim();
}

function fileFilter(req, file, cb) {
  cb(null, true);
}

function decodeFileName(name) {
  let n = String(name || "");
  try { n = Buffer.from(n, "latin1").toString("utf8"); } catch {}
  n = n.replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_").trim().slice(0, 150);
  return n || "file";
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});

async function saveUploadedFile(buffer, mimetype, keyPrefix, fileName = "") {
  const id = `${keyPrefix}-${crypto.randomBytes(16).toString("hex")}`;
  await dbRun(
    `INSERT INTO media_blobs (id, mimetype, data, createdAt, fileName) VALUES (?,?,?,?,?)`,
    [id, normMime(mimetype) || "application/octet-stream", buffer, now(), fileName]
  );
  return `/media/${id}`;
}

app.get("/media/:id", async (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[a-z]+-[0-9a-f]{32}$/.test(id)) return res.status(404).end();

  try {
    const row = await dbGet(`SELECT mimetype, data, fileName FROM media_blobs WHERE id=?`, [id]);
    if (!row) return res.status(404).end();

    const mime = normMime(row.mimetype);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    if (MIME_EXT[mime]) {
      res.setHeader("Content-Type", mime);
    } else {
      const fname = row.fileName || "file";
      const asciiName = fname.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
      res.setHeader("Content-Security-Policy", "sandbox");
    }
    res.send(Buffer.from(row.data));
  } catch {
    res.status(500).end();
  }
});

// ================================================================
// DATABASE — Turso (libSQL)
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
  serialize(fn) { fn(); }
};

const now = () => Date.now();
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r || [])));
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r || null)));
const dbRun = function (sql, params = []) {
  return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
};

async function initSchema() {
  const addColumn = async (table, col, def) => { try { await dbRun(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch {} };

  await dbRun(`
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS media_blobs (
      id TEXT PRIMARY KEY,
      mimetype TEXT NOT NULL,
      data BLOB NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  await addColumn("media_blobs", "fileName", "TEXT NOT NULL DEFAULT ''");

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

  await addColumn("users", "banned", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("users", "muted", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("users", "verified", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("users", "totpSecret", "TEXT NOT NULL DEFAULT ''");
  await addColumn("users", "totpEnabled", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("users", "settings", "TEXT NOT NULL DEFAULT '{}'");
  await addColumn("users", "lastSeen", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("users", "googleSub", "TEXT NOT NULL DEFAULT ''");
  await addColumn("users", "googleEmail", "TEXT NOT NULL DEFAULT ''");
  await addColumn("users", "tosAcceptedAt", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("users", "lastTosReminderAt", "INTEGER NOT NULL DEFAULT 0");

  await dbRun(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatType TEXT NOT NULL,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',
      mediaUrl TEXT DEFAULT '',
      createdAt INTEGER NOT NULL
    )
  `);
  await addColumn("messages", "fileName", "TEXT NOT NULL DEFAULT ''");
  await addColumn("messages", "fileSize", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("messages", "forwardedFrom", "TEXT NOT NULL DEFAULT ''");
  await addColumn("messages", "replyTo", "INTEGER NOT NULL DEFAULT 0");
  await addColumn("messages", "edited", "INTEGER NOT NULL DEFAULT 0");

  await dbRun(`
    CREATE TABLE IF NOT EXISTS message_reads (
      messageId INTEGER NOT NULL,
      reader TEXT NOT NULL,
      readAt INTEGER NOT NULL,
      PRIMARY KEY (messageId, reader)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_reads_msg ON message_reads(messageId)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_reads_reader ON message_reads(reader)`);

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
  // Репост чужой истории к себе — храним, у кого она была изначально
  await addColumn("stories", "repostOfId", "INTEGER");
  await addColumn("stories", "repostOfOwner", "TEXT DEFAULT ''");

  // Просмотры историй + реакции на них
  await dbRun(`
    CREATE TABLE IF NOT EXISTS story_views (
      storyId INTEGER NOT NULL,
      viewer TEXT NOT NULL,
      viewedAt INTEGER NOT NULL,
      reaction TEXT NOT NULL DEFAULT '',
      reactedAt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (storyId, viewer)
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_story_views_story ON story_views(storyId)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_story_views_viewer ON story_views(viewer)`);

  // Комментарии к историям
  await dbRun(`
    CREATE TABLE IF NOT EXISTS story_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      storyId INTEGER NOT NULL,
      username TEXT NOT NULL,
      text TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    )
  `);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_story_comments_story ON story_comments(storyId)`);

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
  await addColumn("groups", "discoverable", "INTEGER NOT NULL DEFAULT 0");

  await dbRun(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId INTEGER NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      joinedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, username)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS group_bans (
      groupId INTEGER NOT NULL,
      username TEXT NOT NULL,
      bannedBy TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, username)
    )
  `);

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

  await dbRun(`
    CREATE TABLE IF NOT EXISTS friends (
      owner TEXT NOT NULL,
      friend TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (owner, friend)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      owner TEXT NOT NULL,
      blocked TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (owner, blocked)
    )
  `);

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
  await addColumn("sessions", "jti", "TEXT");
  await addColumn("sessions", "revoked", "INTEGER NOT NULL DEFAULT 0");
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sessions_username ON sessions(username, createdAt)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_sessions_jti ON sessions(jti)`);

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
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt INTEGER NOT NULL,
      decidedAt INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS dm_exceptions (
      owner TEXT NOT NULL,
      allowed TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (owner, allowed)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS contact_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fromUser TEXT NOT NULL,
      toUser TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt INTEGER NOT NULL,
      decidedAt INTEGER
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS chat_wallpapers (
      owner TEXT NOT NULL,
      chat TEXT NOT NULL,
      value TEXT NOT NULL,
      setBy TEXT NOT NULL DEFAULT '',
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (owner, chat)
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS birthday_log (
      username TEXT NOT NULL,
      year INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (username, year)
    )
  `);

  // Личные контакты — как в телефонной книге: свой ярлык (имя) на чужой
  // юзернейм, видимый только владельцу.
  await dbRun(`
    CREATE TABLE IF NOT EXISTS contacts (
      owner TEXT NOT NULL,
      username TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (owner, username)
    )
  `);

  await dbRun(`CREATE INDEX IF NOT EXISTS idx_msg ON messages(chatType, sender, receiver, createdAt)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_st_exp ON stories(expiresAt)`);
  await dbRun(`CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(username)`);
}

const schemaReady = initSchema()
  .then(() => console.log("[DB] Turso schema ready"))
  .catch((e) => console.error("[DB] Schema initialization failed:", e.message));

async function getOrCreateSecret(key, generator) {
  const row = await dbGet(`SELECT value FROM app_secrets WHERE key=?`, [key]);
  if (row && row.value) return row.value;

  const value = generator();
  await dbRun(`INSERT INTO app_secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`, [key, value]);
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
  try { return JSON.parse((u && u.settings) || "{}"); } catch { return {}; }
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
    tosAcceptedAt: u.tosAcceptedAt || 0,
    settings: parseSettings(u)
  };
}

const SUPPORT_CARD = {
  username: "support",
  displayName: "Поддержка UzMessenger",
  avatarUrl: "/icon-192.png?v=2",
  verified: true,
  emojiStatus: "",
  birthdayToday: false
};

function userCardFromRow(u) {
  const s = parseSettings(u);
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    avatarUrl: u.avatarUrl || "",
    verified: !!u.verified,
    emojiStatus: cleanEmojiStatus(s.emojiStatus || ""),
    birthdayToday: isBirthdayToday(u.birthDate),
    headerTop: HEX_COLOR.test(s.headerTop || "") ? s.headerTop : "",
    headerBottom: HEX_COLOR.test(s.headerBottom || "") ? s.headerBottom : "",
    headerPattern: cleanEmojiStatus(s.headerPattern || "")
  };
}

async function getUserCards(usernames) {
  const uniq = [...new Set((usernames || []).filter(Boolean))];
  const out = {};
  if (uniq.includes("support")) out.support = SUPPORT_CARD;
  const rest = uniq.filter(u => u !== "support");
  if (rest.length) {
    const rows = await dbAll(
      `SELECT username, displayName, avatarUrl, verified, settings, birthDate FROM users WHERE username IN (${rest.map(() => "?").join(",")})`,
      rest
    );
    rows.forEach(r => { out[r.username] = userCardFromRow(r); });
  }
  return out;
}

async function getUserCard(username) {
  const map = await getUserCards([username]);
  return map[username] || { username, displayName: username, avatarUrl: "", verified: false, emojiStatus: "", birthdayToday: false };
}

function previewText(m) {
  if (m.mediaType === "gift") return "🎁 Подарок";
  if (m.mediaType === "round") return "⭕ Видеосообщение";
  if (m.mediaType === "list") return "📋 Список";
  if (m.mediaType === "location") return "📍 Геолокация";
  if (m.mediaType === "file") return "📎 " + (m.fileName || "Файл");
  if (m.mediaType === "image") return "🖼 Фото";
  if (m.mediaType === "video") return "🎬 Видео";
  if (m.mediaType === "audio") return "🎤 Голосовое";
  return m.text || "";
}

function signToken(username, extra = {}) {
  return jwt.sign({ username, ...extra }, EFFECTIVE_JWT_SECRET, { expiresIn: "365d" });
}

function verifyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (decoded.purpose) return res.status(401).json({ ok: false, error: "Неверный токен" });

    const proceed = (user) => {
      if (!user) return res.status(401).json({ ok: false, error: "Пользователь не найден" });
      if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
      req.user = user;
      req.sessionJti = decoded.jti || null;
      next();
    };

    if (decoded.jti) {
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

function verifySuperAdmin(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена админа" });

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (decoded.role !== "superadmin") return res.status(403).json({ ok: false, error: "Доступ только для админов" });
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: "Сессия админа истекла, войди заново" });
  }
}

// Доп. защита: чтение реального текста переписок (личка/группа/общий чат)
// требует, чтобы токен админа был ещё и «разблокирован» отдельным длинным
// кодом через /api/admin/unlock-messages. Обычного входа в админку мало.
function requireMsgUnlock(req, res, next) {
  if (!req.admin || req.admin.msgUnlock !== true) {
    return res.status(403).json({
      ok: false,
      error: "Нужен код разблокировки переписок",
      needUnlock: true
    });
  }
  next();
}

function resolveChatType(receiver) {
  if (receiver.startsWith("group:")) return "group";
  if (receiver === "global") return "global";
  if (receiver === "support") return "support";
  return "private";
}

function guessMediaType(mime) {
  const m = normMime(mime);
  if (!MIME_EXT[m]) return "file";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "file";
}

function cleanupStories() {
  db.run(`DELETE FROM stories WHERE expiresAt <= ?`, [now()]);
  // подчищаем просмотры/реакции/комментарии историй, которых уже нет (истекли/удалены)
  db.run(`DELETE FROM story_views WHERE storyId NOT IN (SELECT id FROM stories)`);
  db.run(`DELETE FROM story_comments WHERE storyId NOT IN (SELECT id FROM stories)`);
}
setInterval(cleanupStories, 60 * 1000);

// ---------------- SIMPLE RATE LIMITER ----------------
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
// TOTP (RFC 6238)
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
  return base32Encode(crypto.randomBytes(20));
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
const RESERVED_USERNAMES = ["global", "support", "admin", "one", "onemessenger", "uz", "uzmessenger"];

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
  if (req.body.acceptedTerms !== true) {
    return res.status(400).json({ ok: false, error: "Нужно принять Условия использования и Политику конфиденциальности" });
  }

  const hash = await bcrypt.hash(password, 10);
  const acceptedAt = now();

  db.run(
    `INSERT INTO users (username, passwordHash, displayName, createdAt, tosAcceptedAt) VALUES (?,?,?,?,?)`,
    [usernameRaw, hash, usernameRaw, now(), acceptedAt],
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

async function wipeUserData(u) {
  await dbRun(`DELETE FROM messages WHERE sender=? OR receiver=?`, [u, u]);
  await dbRun(`DELETE FROM story_views WHERE storyId IN (SELECT id FROM stories WHERE owner=?)`, [u]);
  await dbRun(`DELETE FROM story_views WHERE viewer=?`, [u]);
  await dbRun(`DELETE FROM story_comments WHERE storyId IN (SELECT id FROM stories WHERE owner=?)`, [u]);
  await dbRun(`DELETE FROM story_comments WHERE username=?`, [u]);
  await dbRun(`DELETE FROM stories WHERE owner=?`, [u]);
  await dbRun(`DELETE FROM group_members WHERE username=?`, [u]);
  await dbRun(`DELETE FROM friends WHERE owner=? OR friend=?`, [u, u]);
  await dbRun(`DELETE FROM dm_exceptions WHERE owner=? OR allowed=?`, [u, u]);
  await dbRun(`DELETE FROM contact_requests WHERE fromUser=? OR toUser=?`, [u, u]);
  await dbRun(`DELETE FROM chat_wallpapers WHERE owner=? OR chat=?`, [u, u]);
  await dbRun(`DELETE FROM message_reads WHERE reader=?`, [u]);
  await dbRun(`DELETE FROM blocked_users WHERE owner=? OR blocked=?`, [u, u]);
  await dbRun(`DELETE FROM contacts WHERE owner=? OR username=?`, [u, u]);
  await dbRun(`DELETE FROM users WHERE username=?`, [u]);
}

app.delete("/api/me", verifyAuth, async (req, res) => {
  const password = String(req.body.password || "");
  const ok = await bcrypt.compare(password, req.user.passwordHash);
  if (!ok) return res.status(400).json({ ok: false, error: "Неверный пароль" });

  const u = req.user.username;
  await wipeUserData(u);

  closeAllConnections(u);
  res.json({ ok: true });
});

app.put("/api/me", verifyAuth, (req, res) => {
  const displayName = String(req.body.displayName || "").trim().slice(0, 40);
  const bio = String(req.body.bio || "").trim().slice(0, 200);
  const birthDate = String(req.body.birthDate || "").trim().slice(0, 10);
  const avatarUrl = String(req.body.avatarUrl || "").trim().slice(0, 300);

  if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) {
    return res.status(400).json({ ok: false, error: "Дата рождения в формате ГГГГ-ММ-ДД" });
  }

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

// ---------------- СМЕНА ЮЗЕРНЕЙМА ----------------
app.post("/api/me/username", verifyAuth, rateLimit(3, 60 * 60 * 1000), async (req, res) => {
  const newUsername = String(req.body.username || "").trim().replace(/^@+/, "").toLowerCase();
  const password = String(req.body.password || "");

  if (!/^[a-z0-9_]{4,20}$/.test(newUsername)) {
    return res.status(400).json({ ok: false, error: "Юзернейм: 4-20 символов, латиница/цифры/подчёркивание" });
  }
  if (RESERVED_USERNAMES.includes(newUsername)) {
    return res.status(400).json({ ok: false, error: "Этот юзернейм зарезервирован" });
  }
  const passOk = await bcrypt.compare(password, req.user.passwordHash);
  if (!passOk) return res.status(400).json({ ok: false, error: "Неверный пароль" });

  const old = req.user.username;
  if (newUsername === old) return res.json({ ok: true, username: old });

  const taken = await dbGet(`SELECT username FROM users WHERE username=?`, [newUsername]);
  if (taken) return res.status(409).json({ ok: false, error: "Этот юзернейм уже занят" });

  try {
    await dbRun(`UPDATE users SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE messages SET sender=? WHERE sender=?`, [newUsername, old]);
    await dbRun(`UPDATE messages SET receiver=? WHERE receiver=?`, [newUsername, old]);
    await dbRun(`UPDATE messages SET forwardedFrom=? WHERE forwardedFrom=?`, [newUsername, old]);
    await dbRun(`UPDATE stories SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE story_views SET viewer=? WHERE viewer=?`, [newUsername, old]);
    await dbRun(`UPDATE groups SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE group_members SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE group_bans SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE group_bans SET bannedBy=? WHERE bannedBy=?`, [newUsername, old]);
    await dbRun(`UPDATE gifts SET sender=? WHERE sender=?`, [newUsername, old]);
    await dbRun(`UPDATE gifts SET recipient=? WHERE recipient=?`, [newUsername, old]);
    await dbRun(`UPDATE friends SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE friends SET friend=? WHERE friend=?`, [newUsername, old]);
    await dbRun(`UPDATE blocked_users SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE blocked_users SET blocked=? WHERE blocked=?`, [newUsername, old]);
    await dbRun(`UPDATE sessions SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE push_subscriptions SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE verification_requests SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE dm_exceptions SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE dm_exceptions SET allowed=? WHERE allowed=?`, [newUsername, old]);
    await dbRun(`UPDATE contact_requests SET fromUser=? WHERE fromUser=?`, [newUsername, old]);
    await dbRun(`UPDATE contact_requests SET toUser=? WHERE toUser=?`, [newUsername, old]);
    await dbRun(`UPDATE chat_wallpapers SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE chat_wallpapers SET chat=? WHERE chat=?`, [newUsername, old]);
    await dbRun(`UPDATE birthday_log SET username=? WHERE username=?`, [newUsername, old]);
    await dbRun(`UPDATE message_reads SET reader=? WHERE reader=?`, [newUsername, old]);
    await dbRun(`UPDATE contacts SET owner=? WHERE owner=?`, [newUsername, old]);
    await dbRun(`UPDATE contacts SET username=? WHERE username=?`, [newUsername, old]);
  } catch (e) {
    console.error("[USERNAME CHANGE]", e.message);
    return res.status(500).json({ ok: false, error: "Ошибка смены юзернейма" });
  }

  closeAllConnections(old);
  const user = await dbGet(`SELECT * FROM users WHERE username=?`, [newUsername]);
  const jti = await recordSession(req, newUsername);
  res.json({ ok: true, username: newUsername, token: signToken(newUsername, { jti }), profile: safeUser(user) });
});

// ---------------- GOOGLE OAUTH ----------------
app.get("/api/oauth/google-client-id", (req, res) => {
  res.json({ ok: true, clientId: process.env.GOOGLE_CLIENT_ID || "" });
});

// Проверяет id_token от Google и возвращает { sub, email, name, picture } или бросает ошибку с понятным текстом
async function verifyGoogleCredential(credential) {
  if (!credential) throw new Error("Нет токена Google");
  if (!process.env.GOOGLE_CLIENT_ID) throw new Error("Google-вход не настроен на сервере");

  let payload;
  try {
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    if (!r.ok) throw new Error("bad token");
    payload = await r.json();
  } catch {
    throw new Error("Не удалось проверить токен Google");
  }

  if (payload.aud !== process.env.GOOGLE_CLIENT_ID) throw new Error("Неверный клиент Google");
  if (payload.email_verified !== "true" && payload.email_verified !== true) {
    throw new Error("Email в Google не подтверждён");
  }

  const sub = String(payload.sub || "");
  const email = String(payload.email || "").toLowerCase();
  if (!sub || !email) throw new Error("Неполные данные Google");

  return { sub, email, name: String(payload.name || ""), picture: String(payload.picture || "") };
}

// ---------------- УСЛОВИЯ ИСПОЛЬЗОВАНИЯ / ПОЛИТИКА КОНФИДЕНЦИАЛЬНОСТИ ----------------
app.post("/api/me/accept-terms", verifyAuth, async (req, res) => {
  await dbRun(`UPDATE users SET tosAcceptedAt=?, lastTosReminderAt=0 WHERE username=?`, [now(), req.user.username]);
  res.json({ ok: true, tosAcceptedAt: now() });
});

// ---------------- ПРИВЯЗКА / ОТВЯЗКА GOOGLE К УЖЕ СУЩЕСТВУЮЩЕМУ АККАУНТУ ----------------
app.get("/api/me/google", verifyAuth, (req, res) => {
  res.json({ ok: true, linked: !!req.user.googleSub, email: req.user.googleEmail || "" });
});

app.post("/api/me/google", verifyAuth, rateLimit(15, 60 * 1000), async (req, res) => {
  let g;
  try {
    g = await verifyGoogleCredential(String(req.body.credential || ""));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }

  const other = await dbGet(`SELECT username FROM users WHERE googleSub=? AND username!=?`, [g.sub, req.user.username]);
  if (other) return res.status(409).json({ ok: false, error: `Этот Google-аккаунт уже привязан к @${other.username}` });

  await dbRun(`UPDATE users SET googleSub=?, googleEmail=? WHERE username=?`, [g.sub, g.email, req.user.username]);
  res.json({ ok: true, email: g.email });
});

app.delete("/api/me/google", verifyAuth, async (req, res) => {
  await dbRun(`UPDATE users SET googleSub='', googleEmail='' WHERE username=?`, [req.user.username]);
  res.json({ ok: true });
});

app.post("/api/auth/google", rateLimit(15, 60 * 1000), async (req, res) => {
  let g;
  try {
    g = await verifyGoogleCredential(String(req.body.credential || ""));
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message });
  }
  const { sub, email } = g;
  const payload = { name: g.name, picture: g.picture };

  let user = await dbGet(`SELECT * FROM users WHERE googleSub=?`, [sub]);

  if (!user) {
    user = await dbGet(`SELECT * FROM users WHERE googleEmail=? AND googleSub=''`, [email]);
    if (user) await dbRun(`UPDATE users SET googleSub=? WHERE username=?`, [sub, user.username]);
  }

  if (!user) {
    if (req.body.acceptedTerms !== true) {
      return res.status(400).json({ ok: false, error: "Нужно принять Условия использования и Политику конфиденциальности" });
    }

    let base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 16) || "user";
    if (base.length < 4) base = (base + "user").slice(0, 16);
    let candidate = base, i = 0;
    while (
      RESERVED_USERNAMES.includes(candidate) ||
      (await dbGet(`SELECT username FROM users WHERE username=?`, [candidate]))
    ) {
      i++; candidate = (base.slice(0, 16 - String(i).length) + i);
    }
    const randomPass = crypto.randomBytes(24).toString("hex");
    const hash = await bcrypt.hash(randomPass, 10);
    const displayName = String(payload.name || candidate).trim().slice(0, 40);
    const avatarUrl = String(payload.picture || "").slice(0, 300);
    await dbRun(
      `INSERT INTO users (username, passwordHash, displayName, avatarUrl, googleSub, googleEmail, createdAt, tosAcceptedAt) VALUES (?,?,?,?,?,?,?,?)`,
      [candidate, hash, displayName, avatarUrl, sub, email, now(), now()]
    );
    user = await dbGet(`SELECT * FROM users WHERE username=?`, [candidate]);
  }

  if (user.banned) return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });

  const jti = await recordSession(req, user.username);
  res.json({ ok: true, token: signToken(user.username, { jti }), user: safeUser(user) });
});

app.put("/api/me/settings", verifyAuth, (req, res) => {
  const current = parseSettings(req.user);
  const incoming = req.body && typeof req.body === "object" ? req.body : {};
  const merged = { ...current };

  if (typeof incoming.theme === "string" && incoming.theme.length <= 40) merged.theme = incoming.theme;
  if (isValidWallpaper(incoming.wallpaper)) merged.wallpaper = incoming.wallpaper;
  if (typeof incoming.accent === "string" && HEX_COLOR.test(incoming.accent)) merged.accent = incoming.accent;
  if (["ru", "en", "uz"].includes(incoming.language)) merged.language = incoming.language;

  // шапка профиля — цвет градиента (верх/низ) и фоновый узор (эмодзи), видны всем, кто смотрит профиль
  if (typeof incoming.headerTop === "string") {
    if (incoming.headerTop === "") delete merged.headerTop;
    else if (HEX_COLOR.test(incoming.headerTop)) merged.headerTop = incoming.headerTop;
  }
  if (typeof incoming.headerBottom === "string") {
    if (incoming.headerBottom === "") delete merged.headerBottom;
    else if (HEX_COLOR.test(incoming.headerBottom)) merged.headerBottom = incoming.headerBottom;
  }
  if (typeof incoming.headerPattern === "string") {
    const hp = cleanEmojiStatus(incoming.headerPattern);
    if (hp) merged.headerPattern = hp; else delete merged.headerPattern;
  }

  delete merged.nameColor;
  delete merged.profileColor;

  if (typeof incoming.emojiStatus === "string") {
    const s = cleanEmojiStatus(incoming.emojiStatus);
    if (s) merged.emojiStatus = s; else delete merged.emojiStatus;
  }

  if (typeof incoming.dmGate === "boolean") merged.dmGate = incoming.dmGate;

  const privacyEnum = ["everyone", "friends", "nobody"];
  for (const k of [
    "storyPrivacy", "bioPrivacy", "lastSeenPrivacy",
    "birthdayPrivacy", "photoPrivacy", "forwardPrivacy", "callsPrivacy", "giftsPrivacy"
  ]) {
    if (privacyEnum.includes(incoming[k])) merged[k] = incoming[k];
  }

  db.run(`UPDATE users SET settings=? WHERE username=?`, [JSON.stringify(merged), req.user.username], (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения настроек" });
    res.json({ ok: true, settings: merged });
  });
});

// ---------------- FRIENDS ----------------
app.get("/api/friends", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT u.username, u.displayName, u.avatarUrl, u.verified, u.settings, u.birthDate
     FROM friends f JOIN users u ON u.username=f.friend
     WHERE f.owner=? ORDER BY u.username ASC`,
    [req.user.username]
  );
  res.json({ ok: true, friends: rows.map(userCardFromRow) });
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

// ---------------- ЛИЧНЫЕ КОНТАКТЫ (свой ярлык на чужой юзернейм) ----------------
app.get("/api/contacts", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT c.username, c.name, c.note, c.createdAt, u.displayName, u.avatarUrl, u.verified, u.settings, u.birthDate
     FROM contacts c JOIN users u ON u.username=c.username
     WHERE c.owner=? ORDER BY c.name COLLATE NOCASE ASC, u.username ASC`,
    [req.user.username]
  );
  res.json({
    ok: true,
    contacts: rows.map(r => ({
      ...userCardFromRow(r),
      contactName: r.name || r.displayName || r.username,
      note: r.note || "",
      savedAt: r.createdAt
    }))
  });
});

app.post("/api/contacts", verifyAuth, async (req, res) => {
  const u = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  const name = String(req.body.name || "").trim().slice(0, 40);
  const note = String(req.body.note || "").trim().slice(0, 120);
  if (!u || u === req.user.username) return res.status(400).json({ ok: false, error: "Неверный юзернейм" });

  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  await dbRun(
    `INSERT INTO contacts (owner, username, name, note, createdAt) VALUES (?,?,?,?,?)
     ON CONFLICT(owner, username) DO UPDATE SET name=excluded.name, note=excluded.note`,
    [req.user.username, u, name, note, now()]
  );
  res.json({ ok: true });
});

app.delete("/api/contacts/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  await dbRun(`DELETE FROM contacts WHERE owner=? AND username=?`, [req.user.username, u]);
  res.json({ ok: true });
});

// ---------------- ЧЁРНЫЙ СПИСОК ----------------
app.get("/api/me/blocked", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT u.username, u.displayName, u.avatarUrl, u.verified, u.settings, u.birthDate
     FROM blocked_users b JOIN users u ON u.username=b.blocked
     WHERE b.owner=? ORDER BY u.username ASC`,
    [req.user.username]
  );
  res.json({ ok: true, blocked: rows.map(userCardFromRow) });
});

app.post("/api/me/blocked", verifyAuth, async (req, res) => {
  const u = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  if (!u || u === req.user.username) return res.status(400).json({ ok: false, error: "Неверный юзернейм" });
  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });
  await dbRun(`INSERT OR IGNORE INTO blocked_users (owner, blocked, createdAt) VALUES (?,?,?)`, [req.user.username, u, now()]);
  await dbRun(`DELETE FROM friends WHERE owner=? AND friend=?`, [req.user.username, u]);
  await dbRun(`DELETE FROM friends WHERE owner=? AND friend=?`, [u, req.user.username]);
  res.json({ ok: true });
});

app.delete("/api/me/blocked/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  await dbRun(`DELETE FROM blocked_users WHERE owner=? AND blocked=?`, [req.user.username, u]);
  res.json({ ok: true });
});

async function isFriendOf(ownerUsername, viewerUsername) {
  if (ownerUsername === viewerUsername) return true;
  const row = await dbGet(`SELECT 1 FROM friends WHERE owner=? AND friend=?`, [ownerUsername, viewerUsername]);
  return !!row;
}

async function isAllowedByPrivacy(ownerUser, viewerUsername, settingKey) {
  if (ownerUser.username === viewerUsername) return true;
  const setting = parseSettings(ownerUser)[settingKey] || "everyone";
  if (setting === "everyone") return true;
  if (setting === "nobody") return false;
  return isFriendOf(ownerUser.username, viewerUsername);
}

async function visibleLastSeen(row, viewer) {
  if (!(await isAllowedByPrivacy(row, viewer, "lastSeenPrivacy"))) return { lastSeen: null, lastSeenHidden: true };
  return { lastSeen: Number(row.lastSeen || 0) || null, lastSeenHidden: false };
}

// ---------------- ЧЁРНЫЙ СПИСОК ----------------
async function isBlocked(a, b) {
  const row = await dbGet(
    `SELECT 1 FROM blocked_users WHERE (owner=? AND blocked=?) OR (owner=? AND blocked=?)`,
    [a, b, b, a]
  );
  return !!row;
}

async function canCallUser(ownerUsername, callerUsername) {
  if (ownerUsername === callerUsername) return true;
  if (await isBlocked(ownerUsername, callerUsername)) return false;
  const owner = await dbGet(`SELECT username, settings FROM users WHERE username=?`, [ownerUsername]);
  if (!owner) return false;
  return isAllowedByPrivacy(owner, callerUsername, "callsPrivacy");
}

// ---------------- OFFICIAL ACCOUNT DM GATE ----------------
function dmGateOn(u) {
  return !!(u && u.verified) && parseSettings(u).dmGate !== false;
}

async function dmAllowed(target, sender) {
  if (!target || target.username === sender) return true;
  if (await isBlocked(target.username, sender)) return false;
  if (!dmGateOn(target)) return true;
  if (await dbGet(`SELECT 1 FROM dm_exceptions WHERE owner=? AND allowed=?`, [target.username, sender])) return true;
  const wrote = await dbGet(`SELECT 1 FROM messages WHERE chatType='private' AND sender=? AND receiver=? LIMIT 1`, [target.username, sender]);
  return !!wrote;
}

app.get("/api/me/dm-exceptions", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT u.username, u.displayName, u.avatarUrl, u.verified, u.settings, u.birthDate
     FROM dm_exceptions e JOIN users u ON u.username=e.allowed
     WHERE e.owner=? ORDER BY e.createdAt DESC`,
    [req.user.username]
  );
  res.json({ ok: true, users: rows.map(userCardFromRow) });
});

app.post("/api/me/dm-exceptions", verifyAuth, async (req, res) => {
  const u = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  if (!u || u === req.user.username) return res.status(400).json({ ok: false, error: "Неверный юзернейм" });
  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });
  await dbRun(`INSERT OR IGNORE INTO dm_exceptions (owner, allowed, createdAt) VALUES (?,?,?)`, [req.user.username, u, now()]);
  res.json({ ok: true });
});

app.delete("/api/me/dm-exceptions/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  await dbRun(`DELETE FROM dm_exceptions WHERE owner=? AND allowed=?`, [req.user.username, u]);
  res.json({ ok: true });
});

app.post("/api/contact-requests", verifyAuth, rateLimit(10, 60 * 60 * 1000), async (req, res) => {
  const to = String(req.body.to || "").replace(/^@+/, "").toLowerCase();
  const text = String(req.body.text || "").trim().slice(0, 1000);
  if (!text) return res.status(400).json({ ok: false, error: "Напиши, по какому вопросу обращаешься" });
  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено отправлять сообщения" });

  const target = await dbGet(`SELECT username, verified, settings FROM users WHERE username=? AND banned=0`, [to]);
  if (!target) return res.status(404).json({ ok: false, error: "Пользователь не найден" });
  if (await dmAllowed(target, req.user.username)) return res.status(400).json({ ok: false, error: "Этому человеку можно писать напрямую" });

  const pending = await dbGet(`SELECT id FROM contact_requests WHERE fromUser=? AND toUser=? AND status IN ('pending','forwarded')`, [req.user.username, to]);
  if (pending) return res.status(400).json({ ok: false, error: "Заявка уже отправлена, дождись ответа администрации" });

  await dbRun(
    `INSERT INTO contact_requests (fromUser, toUser, text, status, createdAt) VALUES (?,?,?,'pending',?)`,
    [req.user.username, to, text, now()]
  );
  res.json({ ok: true });
});

app.get("/api/contact-requests/mine", verifyAuth, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM contact_requests WHERE fromUser=? ORDER BY createdAt DESC LIMIT 20`, [req.user.username]);
  res.json({ ok: true, requests: rows });
});

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

function singleUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        const msg = err.code === "LIMIT_FILE_SIZE" ? "Файл больше 20 МБ" : (err.message || "Ошибка загрузки");
        return res.status(400).json({ ok: false, error: msg });
      }
      next();
    });
  };
}

app.post("/api/me/avatar", verifyAuth, singleUpload("file"), async (req, res) => {
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

app.post("/api/upload-image", verifyAuth, singleUpload("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });
  if (guessMediaType(req.file.mimetype) !== "image") {
    return res.status(400).json({ ok: false, error: "Нужна картинка (jpg, png, webp, gif)" });
  }
  const url = await saveUploadedFile(req.file.buffer, req.file.mimetype, "wp");
  res.json({ ok: true, url });
});

// ---------------- CHAT WALLPAPERS ----------------
function normChatKey(chat) {
  const c = String(chat || "").replace(/^@+/, "").toLowerCase();
  if (c === "global" || c === "support" || /^group:\d+$/.test(c) || /^[a-z0-9_]{1,20}$/.test(c)) return c;
  return "";
}

app.get("/api/wallpaper", verifyAuth, async (req, res) => {
  const chat = normChatKey(req.query.chat);
  if (!chat) return res.json({ ok: true, value: "" });
  const row = await dbGet(`SELECT value, setBy FROM chat_wallpapers WHERE owner=? AND chat=?`, [req.user.username, chat]);
  res.json({ ok: true, value: row ? row.value : "", setBy: row ? row.setBy : "" });
});

app.put("/api/wallpaper", verifyAuth, async (req, res) => {
  const chat = normChatKey(req.body.chat);
  const value = String(req.body.value || "");
  const forBoth = !!req.body.forBoth;
  if (!chat) return res.status(400).json({ ok: false, error: "Неверный чат" });
  if (value && !isValidWallpaper(value)) return res.status(400).json({ ok: false, error: "Неверные обои" });

  const me = req.user.username;
  const setFor = async (owner, chatKey) => {
    if (!value) await dbRun(`DELETE FROM chat_wallpapers WHERE owner=? AND chat=?`, [owner, chatKey]);
    else await dbRun(
      `INSERT INTO chat_wallpapers (owner, chat, value, setBy, updatedAt) VALUES (?,?,?,?,?)
       ON CONFLICT(owner, chat) DO UPDATE SET value=excluded.value, setBy=excluded.setBy, updatedAt=excluded.updatedAt`,
      [owner, chatKey, value, me, now()]
    );
  };

  await setFor(me, chat);

  const isPrivate = resolveChatType(chat) === "private" && chat !== me;
  if (forBoth && isPrivate) {
    const other = await dbGet(`SELECT username FROM users WHERE username=?`, [chat]);
    if (other) {
      await setFor(chat, me);
      wsSendToUser(chat, { type: "wallpaperChanged", chat: me, value, by: me });
    }
  }
  res.json({ ok: true });
});

app.get("/api/users/search", verifyAuth, async (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^@+/, "").toLowerCase();
  if (!q) return res.json({ ok: true, users: [] });

  const rows = await dbAll(
    `SELECT username, displayName, bio, avatarUrl, verified, settings, birthDate
     FROM users
     WHERE username LIKE ? AND username != ? AND banned=0
     ORDER BY username ASC LIMIT 20`,
    [`%${q}%`, req.user.username]
  );
  res.json({ ok: true, users: rows.map(userCardFromRow) });
});

app.get("/api/users/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  if (u === "support") return res.json({ ok: true, user: { ...SUPPORT_CARD, bio: "Официальная поддержка UzMessenger", online: true, canMessage: true, dmGated: false } });

  const row = await dbGet(
    `SELECT username, displayName, bio, avatarUrl, verified, settings, birthDate, lastSeen FROM users WHERE username=? AND banned=0`,
    [u]
  );
  if (!row) return res.status(404).json({ ok: false, error: "Не найден" });

  const viewer = req.user.username;
  const bioAllowed = await isAllowedByPrivacy(row, viewer, "bioPrivacy");
  const photoAllowed = await isAllowedByPrivacy(row, viewer, "photoPrivacy");
  const birthdayAllowed = await isAllowedByPrivacy(row, viewer, "birthdayPrivacy");
  const s = parseSettings(row);
  const ls = await visibleLastSeen(row, viewer);
  const blocked = await isBlocked(row.username, viewer);

  res.json({
    ok: true,
    user: {
      ...userCardFromRow(row),
      avatarUrl: photoAllowed ? (row.avatarUrl || "") : "",
      birthdayToday: birthdayAllowed ? isBirthdayToday(row.birthDate) : false,
      bio: bioAllowed ? row.bio : "",
      online: isOnline(row.username),
      ...ls,
      dmGated: dmGateOn(row) && row.username !== viewer,
      canMessage: blocked ? false : await dmAllowed(row, viewer),
      blocked,
      iBlockedThem: !!(await dbGet(`SELECT 1 FROM blocked_users WHERE owner=? AND blocked=?`, [viewer, row.username]))
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
// ================================================================
async function isMember(groupId, username) {
  const row = await dbGet(`SELECT role FROM group_members WHERE groupId=? AND username=?`, [groupId, username]);
  return row ? row.role : null;
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
    `SELECT gm.username, gm.role, u.displayName, u.avatarUrl, u.verified, u.settings, u.birthDate
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

  res.json({
    ok: true,
    group,
    members: members.map(m => ({ ...userCardFromRow(m), role: m.role })),
    bans,
    myRole: role
  });
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
  if (!selfLeave && role === "admin" && targetRole === "admin") {
    return res.status(403).json({ ok: false, error: "Админ не может убрать другого админа — только владелец" });
  }

  await dbRun(`DELETE FROM group_members WHERE groupId=? AND username=?`, [groupId, target]);
  res.json({ ok: true });
});

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
app.get("/api/chats", verifyAuth, async (req, res) => {
  const me = req.user.username;

  const rows = await dbAll(
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
    [me, me, me]
  );

  const others = rows.map(r => r.other).filter(Boolean);
  if (others.length === 0) return res.json({ ok: true, chats: [] });

  const placeholders = others.map(() => "?").join(",");
  const users = await dbAll(
    `SELECT username, displayName, avatarUrl, verified, settings, birthDate, lastSeen FROM users WHERE username IN (${placeholders})`,
    others
  );
  const map = new Map(users.map(u => [u.username, u]));

  const msgs = await dbAll(
    `
    SELECT sender, receiver, text, mediaType, fileName, createdAt
    FROM messages
    WHERE chatType='private' AND (sender=? OR receiver=?)
    ORDER BY createdAt DESC
    LIMIT 400
    `,
    [me, me]
  );
  const preview = new Map();
  msgs.forEach(m => {
    const other = m.sender === me ? m.receiver : m.sender;
    if (!preview.has(other)) preview.set(other, previewText(m));
  });

  const out = [];
  for (const o of others) {
    const u = map.get(o);
    if (!u) {
      out.push({ username: o, displayName: o, avatarUrl: "", verified: false, emojiStatus: "", preview: preview.get(o) || "" });
      continue;
    }
    out.push({ ...userCardFromRow(u), ...(await visibleLastSeen(u, me)), preview: preview.get(o) || "" });
  }

  res.json({ ok: true, chats: out });
});

// ---------------- MESSAGES ----------------
async function attachReadAndReply(rows, me) {
  const myIds = rows.filter(r => r.sender === me).length ? rows.filter(r => r.sender === me).map(r => r.id) : [];
  let readMap = {}; // messageId -> count of OTHER readers
  if (myIds.length) {
    const placeholders = myIds.map(() => "?").join(",");
    const readRows = await dbAll(
      `SELECT messageId, COUNT(DISTINCT reader) c FROM message_reads WHERE messageId IN (${placeholders}) AND reader!=? GROUP BY messageId`,
      [...myIds, me]
    );
    readRows.forEach(r => { readMap[r.messageId] = r.c; });
  }

  const replyIds = [...new Set(rows.map(r => Number(r.replyTo) || 0).filter(Boolean))];
  let replyMap = {};
  if (replyIds.length) {
    const placeholders = replyIds.map(() => "?").join(",");
    const replyRows = await dbAll(`SELECT id, sender, text, mediaType FROM messages WHERE id IN (${placeholders})`, replyIds);
    replyRows.forEach(r => { replyMap[r.id] = r; });
  }

  return rows.map(r => ({
    ...r,
    readCount: r.sender === me ? (readMap[r.id] || 0) : undefined,
    replyPreview: r.replyTo ? (replyMap[r.replyTo] || null) : null
  }));
}

async function sendMessagesWithUsers(res, rows, me) {
  const users = await getUserCards(rows.map(r => r.sender));
  const withExtra = me ? await attachReadAndReply(rows, me) : rows;
  res.json({ ok: true, messages: withExtra, users });
}

// Кто и когда прочитал конкретное сообщение (для долгого нажатия на сообщение)
app.get("/api/messages/:id/reads", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row || !(await canReadMessage(row, req.user.username))) return res.status(404).json({ ok: false, error: "Не найдено" });

  const rows = await dbAll(
    `SELECT r.reader, r.readAt, u.displayName, u.avatarUrl FROM message_reads r JOIN users u ON u.username=r.reader WHERE r.messageId=? ORDER BY r.readAt ASC`,
    [id]
  );
  res.json({ ok: true, reads: rows });
});

// Редактирование своего текстового сообщения
app.put("/api/messages/:id", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  const text = String(req.body.text || "").trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: "Пустой текст" });

  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row) return res.status(404).json({ ok: false, error: "Не найдено" });
  if (row.sender !== me) return res.status(403).json({ ok: false, error: "Можно редактировать только своё" });
  if (row.mediaType !== "text") return res.status(400).json({ ok: false, error: "Можно редактировать только текстовые сообщения" });

  await dbRun(`UPDATE messages SET text=?, edited=1 WHERE id=?`, [text, id]);
  await broadcastToChat(row.chatType, row.receiver, row.sender, { type: "messageEdited", id, text, edited: true });
  res.json({ ok: true });
});

// Переслать сообщение в любой чат (личка/группа/канал/избранное)
app.post("/api/messages/:id/forward", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  const to = String(req.body.to || "").replace(/^@+/, "").toLowerCase();
  if (!to) return res.status(400).json({ ok: false, error: "Не указан чат" });

  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row || !(await canReadMessage(row, me))) return res.status(404).json({ ok: false, error: "Сообщение не найдено" });

  if (row.sender !== me && row.sender !== "support") {
    const senderUser = await dbGet(`SELECT username, settings FROM users WHERE username=?`, [row.sender]);
    if (senderUser && !(await isAllowedByPrivacy(senderUser, me, "forwardPrivacy"))) {
      return res.status(403).json({ ok: false, error: "Автор запретил пересылку своих сообщений" });
    }
  }

  const chatType = resolveChatType(to);
  const perm = await canPostTo(chatType, to, me);
  if (!perm.canPost) return res.status(403).json({ ok: false, error: perm.error || "Нет доступа" });

  const createdAt = now();
  const forwardedFrom = row.sender === me ? "" : row.sender;
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt, fileName, fileSize, forwardedFrom)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [chatType, me, to, row.text || "", row.mediaType || "text", row.mediaUrl || "", createdAt, row.fileName || "", Number(row.fileSize || 0), forwardedFrom]
  );
  const msg = {
    id: result.lastID, chatType, sender: me, receiver: to, text: row.text || "",
    mediaType: row.mediaType || "text", mediaUrl: row.mediaUrl || "", createdAt,
    fileName: row.fileName || "", fileSize: Number(row.fileSize || 0), forwardedFrom, replyTo: 0
  };
  await broadcastMessage(msg);
  res.json({ ok: true });
});

app.get("/api/messages", verifyAuth, async (req, res) => {
  const chat = String(req.query.chat || "global").replace(/^@+/, "").toLowerCase();
  const me = req.user.username;

  if (chat === "global") {
    const rows = await dbAll(`SELECT * FROM messages WHERE chatType='global' ORDER BY createdAt ASC LIMIT 500`);
    return sendMessagesWithUsers(res, rows, me);
  }

  if (chat.startsWith("group:")) {
    const groupId = Number(chat.slice(6));
    const role = await isMember(groupId, me);
    if (!role) return res.status(403).json({ ok: false, error: "Ты не участник этой группы" });

    const rows = await dbAll(
      `SELECT * FROM messages WHERE chatType='group' AND receiver=? ORDER BY createdAt ASC LIMIT 800`,
      [chat]
    );
    return sendMessagesWithUsers(res, rows, me);
  }

  if (chat === "support") {
    const rows = await dbAll(
      `SELECT * FROM messages WHERE chatType='support' AND ((sender=? AND receiver='support') OR (sender='support' AND receiver=?)) ORDER BY createdAt ASC LIMIT 500`,
      [me, me]
    );
    return sendMessagesWithUsers(res, rows, me);
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
  sendMessagesWithUsers(res, rows, me);
});

async function canReadMessage(row, username) {
  if (!row) return false;
  if (row.chatType === "global") return true;
  if (row.chatType === "private" || row.chatType === "support") return row.sender === username || row.receiver === username;
  if (row.chatType === "group") return !!(await isMember(Number(String(row.receiver).slice(6)), username));
  return false;
}

app.delete("/api/messages/:id", verifyAuth, (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;

  db.get(`SELECT * FROM messages WHERE id=?`, [id], (err, row) => {
    if (!row) return res.status(404).json({ ok: false, error: "Не найдено" });
    if (row.sender !== me) return res.status(403).json({ ok: false, error: "Можно удалить только своё" });

    db.run(`DELETE FROM messages WHERE id=?`, [id], async (e2) => {
      if (e2) return res.status(500).json({ ok: false, error: "Ошибка удаления" });

      dbRun(`DELETE FROM message_reads WHERE messageId=?`, [id]).catch(() => {});
      await broadcastDelete(row, id);
      res.json({ ok: true });
    });
  });
});

app.post("/api/messages/:id/save", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row || !(await canReadMessage(row, me))) return res.status(404).json({ ok: false, error: "Сообщение не найдено" });

  if (row.sender !== me && row.sender !== "support") {
    const senderUser = await dbGet(`SELECT username, settings FROM users WHERE username=?`, [row.sender]);
    if (senderUser && !(await isAllowedByPrivacy(senderUser, me, "forwardPrivacy"))) {
      return res.status(403).json({ ok: false, error: "Автор запретил пересылку своих сообщений" });
    }
  }

  const createdAt = now();
  const forwardedFrom = row.sender === me ? "" : row.sender;
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt, fileName, fileSize, forwardedFrom)
     VALUES ('private',?,?,?,?,?,?,?,?,?)`,
    [me, me, row.text || "", row.mediaType || "text", row.mediaUrl || "", createdAt, row.fileName || "", Number(row.fileSize || 0), forwardedFrom]
  );
  const msg = {
    id: result.lastID, chatType: "private", sender: me, receiver: me, text: row.text || "",
    mediaType: row.mediaType || "text", mediaUrl: row.mediaUrl || "", createdAt,
    fileName: row.fileName || "", fileSize: Number(row.fileSize || 0), forwardedFrom
  };
  await broadcastMessage(msg);
  res.json({ ok: true });
});

app.post("/api/messages/:id/list-toggle", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const itemIndex = Number(req.body.itemIndex);
  const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
  if (!row || row.mediaType !== "list") return res.status(404).json({ ok: false, error: "Список не найден" });

  if (!(await canReadMessage(row, req.user.username))) return res.status(403).json({ ok: false, error: "Нет доступа" });

  let list;
  try { list = JSON.parse(row.text); } catch { return res.status(500).json({ ok: false, error: "Повреждённые данные" }); }
  if (!list.items || !list.items[itemIndex]) return res.status(400).json({ ok: false, error: "Неверный пункт" });

  list.items[itemIndex].checked = !list.items[itemIndex].checked;
  await dbRun(`UPDATE messages SET text=? WHERE id=?`, [JSON.stringify(list), id]);

  await broadcastToChat(row.chatType, row.receiver, row.sender, { type: "listUpdated", id, list });
  res.json({ ok: true, list });
});

// ---------------- UPLOAD (фото, видео, голосовые, ЛЮБЫЕ файлы) ----------------
app.post("/api/upload", verifyAuth, singleUpload("file"), async (req, res) => {
  const me = req.user.username;

  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено отправлять сообщения" });

  const receiver = String(req.body.receiver || "global").replace(/^@+/, "").toLowerCase();
  const chatType = resolveChatType(receiver);
  const text = String(req.body.text || "").trim().slice(0, 2000);

  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  const perm = await canPostTo(chatType, receiver, me);
  if (!perm.canPost) return res.status(403).json({ ok: false, error: perm.error || "Нет доступа", gated: !!perm.gated });

  let mediaType = guessMediaType(req.file.mimetype);
  // кружочек (видео-сообщение как в Telegram) — тот же /api/upload, но с пометкой kind=round
  if (String(req.body.kind || "") === "round" && mediaType === "video") mediaType = "round";

  const fileName = decodeFileName(req.file.originalname);
  const fileSize = req.file.size || req.file.buffer.length;
  const mediaUrl = await saveUploadedFile(req.file.buffer, req.file.mimetype, "msg", fileName);

  const createdAt = now();
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt, fileName, fileSize)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [chatType, me, receiver, text, mediaType, mediaUrl, createdAt, fileName, fileSize]
  );

  const msg = { id: result.lastID, chatType, sender: me, receiver, text, mediaType, mediaUrl, createdAt, fileName, fileSize, forwardedFrom: "" };
  await broadcastMessage(msg);
  res.json({ ok: true, message: msg });
});

// ---------------- STORIES ----------------
app.get("/api/stories", verifyAuth, async (req, res) => {
  cleanupStories();
  const me = req.user.username;
  const rows = await dbAll(
    `
    SELECT s.*, u.displayName, u.avatarUrl, u.verified, u.settings AS ownerSettings,
           COALESCE(sv.reaction, '') AS myReaction,
           (SELECT COUNT(*) FROM story_comments sc WHERE sc.storyId=s.id) AS commentCount
    FROM stories s
    LEFT JOIN users u ON u.username=s.owner
    LEFT JOIN story_views sv ON sv.storyId=s.id AND sv.viewer=?
    WHERE s.expiresAt > ? AND u.banned=0
    ORDER BY s.createdAt DESC
    LIMIT 200
    `,
    [me, now()]
  );

  const visible = [];
  for (const row of rows) {
    const ownerLike = { username: row.owner, settings: row.ownerSettings };
    if (await isAllowedByPrivacy(ownerLike, me, "storyPrivacy")) {
      delete row.ownerSettings;
      visible.push(row);
    }
  }
  res.json({ ok: true, stories: visible });
});

app.get("/api/stories/user/:username", verifyAuth, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const me = req.user.username;
  const owner = await dbGet(`SELECT username, settings FROM users WHERE username=? AND banned=0`, [u]);
  if (!owner) return res.status(404).json({ ok: false, error: "Не найден" });

  if (!(await isAllowedByPrivacy(owner, me, "storyPrivacy"))) {
    return res.json({ ok: true, stories: [] });
  }

  const rows = await dbAll(
    `
    SELECT s.*, COALESCE(sv.reaction, '') AS myReaction,
           (SELECT COUNT(*) FROM story_comments sc WHERE sc.storyId=s.id) AS commentCount
    FROM stories s
    LEFT JOIN story_views sv ON sv.storyId=s.id AND sv.viewer=?
    WHERE s.owner=? AND s.expiresAt > ?
    ORDER BY s.createdAt DESC LIMIT 50
    `,
    [me, u, now()]
  );
  res.json({ ok: true, stories: rows });
});

app.get("/api/stories/mine", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `
    SELECT s.*,
           (SELECT COUNT(*) FROM story_views sv WHERE sv.storyId=s.id) AS viewCount,
           (SELECT COUNT(*) FROM story_views sv WHERE sv.storyId=s.id AND sv.reaction<>'') AS reactionCount
    FROM stories s
    WHERE s.owner=? ORDER BY s.createdAt DESC LIMIT 500
    `,
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
  await dbRun(`DELETE FROM story_views WHERE storyId=?`, [id]);
  res.json({ ok: true });
});

// ---------------- ПРОСМОТРЫ И РЕАКЦИИ НА ИСТОРИИ ----------------

// Отмечаем историю как просмотренную (вызывается при открытии чужой сторис)
app.post("/api/stories/:id/view", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;

  const story = await dbGet(`SELECT id, owner FROM stories WHERE id=?`, [id]);
  if (!story) return res.status(404).json({ ok: false, error: "Не найдена" });
  if (story.owner === me) return res.json({ ok: true }); // свою сторис не считаем просмотром

  const existing = await dbGet(`SELECT storyId FROM story_views WHERE storyId=? AND viewer=?`, [id, me]);
  if (!existing) {
    await dbRun(
      `INSERT INTO story_views (storyId, viewer, viewedAt, reaction, reactedAt) VALUES (?,?,?,'',0)`,
      [id, me, now()]
    );
  }
  res.json({ ok: true });
});

// Поставить/поменять реакцию (любой эмодзи) на чужую историю
app.post("/api/stories/:id/react", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  const reaction = cleanEmojiStatus(req.body.reaction);
  if (!reaction) return res.status(400).json({ ok: false, error: "Пустая реакция" });

  const story = await dbGet(`SELECT id, owner FROM stories WHERE id=? AND expiresAt > ?`, [id, now()]);
  if (!story) return res.status(404).json({ ok: false, error: "История не найдена или уже истекла" });
  if (story.owner === me) return res.status(400).json({ ok: false, error: "Нельзя ставить реакцию на свою историю" });

  const t = now();
  await dbRun(
    `INSERT INTO story_views (storyId, viewer, viewedAt, reaction, reactedAt) VALUES (?,?,?,?,?)
     ON CONFLICT(storyId, viewer) DO UPDATE SET
       reaction=excluded.reaction,
       reactedAt=excluded.reactedAt`,
    [id, me, t, reaction, t]
  );

  const viewer = await dbGet(`SELECT displayName FROM users WHERE username=?`, [me]);
  wsSendToUser(story.owner, {
    type: "storyReaction",
    storyId: id,
    from: me,
    fromDisplayName: (viewer && viewer.displayName) || me,
    reaction
  });
  sendPushToUser(story.owner, {
    title: "Реакция на историю",
    body: `${reaction} @${me} отреагировал(а) на твою историю`,
    url: "/chat.html"
  }).catch(() => {});

  res.json({ ok: true, reaction });
});

// Убрать свою реакцию с истории
app.delete("/api/stories/:id/react", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  await dbRun(`UPDATE story_views SET reaction='', reactedAt=0 WHERE storyId=? AND viewer=?`, [id, me]);
  res.json({ ok: true });
});

// Список тех, кто посмотрел историю (и их реакции) — видит только автор
app.get("/api/stories/:id/viewers", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;

  const story = await dbGet(`SELECT id, owner FROM stories WHERE id=?`, [id]);
  if (!story) return res.status(404).json({ ok: false, error: "Не найдена" });
  if (story.owner !== me) return res.status(403).json({ ok: false, error: "Список просмотров видит только автор истории" });

  const rows = await dbAll(
    `
    SELECT sv.viewer AS username, sv.viewedAt, sv.reaction, sv.reactedAt,
           u.displayName, u.avatarUrl, u.verified
    FROM story_views sv
    LEFT JOIN users u ON u.username = sv.viewer
    WHERE sv.storyId=?
    ORDER BY (sv.reaction <> '') DESC, sv.reactedAt DESC, sv.viewedAt DESC
    `,
    [id]
  );
  res.json({ ok: true, viewers: rows, count: rows.length });
});

// ---------------- КОММЕНТАРИИ К ИСТОРИЯМ ----------------
app.get("/api/stories/:id/comments", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const story = await dbGet(`SELECT id FROM stories WHERE id=?`, [id]);
  if (!story) return res.status(404).json({ ok: false, error: "Не найдена" });

  const rows = await dbAll(
    `
    SELECT sc.id, sc.username, sc.text, sc.createdAt, u.displayName, u.avatarUrl, u.verified
    FROM story_comments sc
    LEFT JOIN users u ON u.username = sc.username
    WHERE sc.storyId=?
    ORDER BY sc.createdAt ASC LIMIT 300
    `,
    [id]
  );
  res.json({ ok: true, comments: rows });
});

app.post("/api/stories/:id/comments", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено писать комментарии" });
  const text = String(req.body.text || "").trim().slice(0, 300);
  if (!text) return res.status(400).json({ ok: false, error: "Пустой комментарий" });

  const story = await dbGet(`SELECT id, owner FROM stories WHERE id=? AND expiresAt > ?`, [id, now()]);
  if (!story) return res.status(404).json({ ok: false, error: "История не найдена или уже истекла" });

  const createdAt = now();
  const result = await dbRun(
    `INSERT INTO story_comments (storyId, username, text, createdAt) VALUES (?,?,?,?)`,
    [id, me, text, createdAt]
  );
  const comment = { id: result.lastID, storyId: id, username: me, text, createdAt };

  if (story.owner !== me) {
    const commenter = await dbGet(`SELECT displayName FROM users WHERE username=?`, [me]);
    wsSendToUser(story.owner, {
      type: "storyComment",
      storyId: id,
      from: me,
      fromDisplayName: (commenter && commenter.displayName) || me,
      text
    });
    sendPushToUser(story.owner, {
      title: "Комментарий к истории",
      body: `@${me}: ${text}`,
      url: "/chat.html"
    }).catch(() => {});
  }

  res.json({ ok: true, comment });
});

// ---------------- РЕПОСТ ИСТОРИИ ----------------
app.post("/api/stories/:id/repost", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;
  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено публиковать сторис" });

  const story = await dbGet(`SELECT * FROM stories WHERE id=? AND expiresAt > ?`, [id, now()]);
  if (!story) return res.status(404).json({ ok: false, error: "История не найдена или уже истекла" });
  if (story.owner === me) return res.status(400).json({ ok: false, error: "Нельзя репостить свою же историю" });

  const owner = await dbGet(`SELECT username, settings FROM users WHERE username=? AND banned=0`, [story.owner]);
  if (!owner || !(await isAllowedByPrivacy(owner, me, "storyPrivacy"))) {
    return res.status(403).json({ ok: false, error: "Нет доступа к этой истории" });
  }

  const createdAt = now();
  const expiresAt = createdAt + 100 * 365 * 24 * 60 * 60 * 1000;
  const originOwner = story.repostOfOwner || story.owner;
  const originId = story.repostOfId || story.id;

  const result = await dbRun(
    `INSERT INTO stories (owner,text,mediaType,mediaUrl,createdAt,expiresAt,repostOfId,repostOfOwner)
     VALUES (?,?,?,?,?,?,?,?)`,
    [me, story.text, story.mediaType, story.mediaUrl, createdAt, expiresAt, originId, originOwner]
  );

  if (originOwner !== me) {
    const reposter = await dbGet(`SELECT displayName FROM users WHERE username=?`, [me]);
    wsSendToUser(originOwner, {
      type: "storyRepost",
      storyId: originId,
      from: me,
      fromDisplayName: (reposter && reposter.displayName) || me
    });
    sendPushToUser(originOwner, {
      title: "Репост истории",
      body: `@${me} репостнул(а) твою историю`,
      url: "/chat.html"
    }).catch(() => {});
  }

  res.json({ ok: true, id: result.lastID });
});

app.post("/api/stories", verifyAuth, singleUpload("story"), async (req, res) => {
  const me = req.user.username;
  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено публиковать сторис" });

  const text = String(req.body.text || "").trim().slice(0, 120);

  const createdAt = now();
  const expiresAt = createdAt + 100 * 365 * 24 * 60 * 60 * 1000; // сторис больше не удаляется сама — «вечная» (100 лет)

  let mediaType = "text";
  let mediaUrl = "";

  if (req.file) {
    mediaType = guessMediaType(req.file.mimetype);
    if (mediaType !== "image" && mediaType !== "video") {
      return res.status(400).json({ ok: false, error: "В сторис можно только фото или видео" });
    }
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

  const target = await dbGet(`SELECT username, settings FROM users WHERE username=? AND banned=0`, [recipient]);
  if (!target) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  if (await isBlocked(recipient, req.user.username)) {
    return res.status(403).json({ ok: false, error: "Недоступно" });
  }
  if (!(await isAllowedByPrivacy(target, req.user.username, "giftsPrivacy"))) {
    return res.status(403).json({ ok: false, error: "Этот пользователь ограничил получение подарков" });
  }

  const codeOk = code && GIFT_SECRET_CODES.includes(code);
  if (!isGiftDay() && !codeOk) {
    return res.status(403).json({ ok: false, error: "Подарки бесплатно — только по пятницам, либо по секретному коду" });
  }

  const createdAt = now();
  await dbRun(
    `INSERT INTO gifts (sender, recipient, emoji, createdAt) VALUES (?,?,?,?)`,
    [req.user.username, recipient, emoji, createdAt]
  );

  // Подарок также приходит обычным сообщением в чат — красивая рамка на клиенте (mediaType 'gift')
  const giftText = JSON.stringify({ emoji });
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES ('private',?,?,?,?,?,?)`,
    [req.user.username, recipient, giftText, "gift", "", createdAt]
  );
  const msg = {
    id: result.lastID, chatType: "private", sender: req.user.username, receiver: recipient,
    text: giftText, mediaType: "gift", mediaUrl: "", createdAt, fileName: "", fileSize: 0, forwardedFrom: ""
  };
  await broadcastMessage(msg);
  wsSendToUser(recipient, { type: "giftReceived", from: req.user.username, emoji });
  res.json({ ok: true });
});

// ---------------- BIRTHDAYS ----------------
app.get("/api/birthdays/today", verifyAuth, (req, res) => {
  const t = localToday();

  db.all(
    `SELECT username, displayName, avatarUrl
     FROM users
     WHERE substr(birthDate,6,2)=? AND substr(birthDate,9,2)=? AND banned=0`,
    [t.mm, t.dd],
    (err, rows) => res.json({ ok: true, list: rows || [], today: `${t.mm}-${t.dd}` })
  );
});

async function birthdayContacts(username) {
  const rows = await dbAll(
    `
    SELECT DISTINCT other FROM (
      SELECT CASE WHEN sender=? THEN receiver ELSE sender END AS other
      FROM messages WHERE chatType='private' AND (sender=? OR receiver=?)
      UNION SELECT owner AS other FROM friends WHERE friend=?
      UNION SELECT friend AS other FROM friends WHERE owner=?
    ) WHERE other != ?
    LIMIT 500
    `,
    [username, username, username, username, username, username]
  );
  return rows.map(r => r.other).filter(Boolean);
}

async function runBirthdayJob() {
  try {
    const t = localToday();
    const rows = await dbAll(
      `SELECT username, displayName FROM users WHERE substr(birthDate,6,2)=? AND substr(birthDate,9,2)=? AND banned=0`,
      [t.mm, t.dd]
    );
    for (const u of rows) {
      const done = await dbGet(`SELECT 1 FROM birthday_log WHERE username=? AND year=?`, [u.username, t.yyyy]);
      if (done) continue;
      await dbRun(`INSERT OR IGNORE INTO birthday_log (username, year, createdAt) VALUES (?,?,?)`, [u.username, t.yyyy, now()]);

      const name = u.displayName || u.username;
      await sendSupportMessage(
        u.username,
        `🎉 С днём рождения, ${name}! Команда UzMessenger желает тебе счастья, здоровья и исполнения всех желаний! 🎂🎈`
      );

      const contacts = await birthdayContacts(u.username);
      for (const c of contacts) {
        wsSendToUser(c, { type: "birthday", username: u.username, displayName: name });
        if (!isOnline(c)) {
          sendPushToUser(c, { title: "🎂 День рождения", body: `Сегодня день рождения у ${name} — поздравь!`, url: "/chat.html" }).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error("[BIRTHDAY] job failed:", e.message);
  }
}

const TOS_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000; // раз в 2 дня
const TOS_REMINDER_TEXT =
  "📋 Пожалуйста, согласитесь с нашей Политикой условий (Условия использования и Политика конфиденциальности), " +
  "чтобы продолжать пользоваться UzMessenger без ограничений. Это можно сделать в Настройки → Аккаунт → " +
  "Политика использования → «Принять».";

async function runTosReminderJob() {
  try {
    const cutoff = now() - TOS_REMINDER_INTERVAL_MS;
    const rows = await dbAll(
      `SELECT username FROM users WHERE banned=0 AND (tosAcceptedAt IS NULL OR tosAcceptedAt=0)
       AND (lastTosReminderAt IS NULL OR lastTosReminderAt=0 OR lastTosReminderAt<?)`,
      [cutoff]
    );
    for (const u of rows) {
      await sendSupportMessage(u.username, TOS_REMINDER_TEXT);
      await dbRun(`UPDATE users SET lastTosReminderAt=? WHERE username=?`, [now(), u.username]);
    }
  } catch (e) {
    console.error("[TOS REMINDER] job failed:", e.message);
  }
}

// ================================================================
// ADMIN
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

// Запретная зона: отдельный длинный код, который открывает чтение
// чужих переписок. Пока он не введён верно, /api/admin/messages/* отдают 403.
app.post("/api/admin/unlock-messages", verifySuperAdmin, rateLimit(8, 15 * 60 * 1000), (req, res) => {
  const code = String((req.body && req.body.code) || "");
  if (!timingSafeStrEqual(code, ADMIN_MSG_UNLOCK_CODE)) {
    return res.status(401).json({ ok: false, error: "Неверный код разблокировки" });
  }
  const token = jwt.sign({ role: "superadmin", msgUnlock: true }, EFFECTIVE_JWT_SECRET, { expiresIn: "30m" });
  res.json({ ok: true, token });
});

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

// Базовая карточка профиля (для бана/мута) — открывается сразу, без пин-кода.
// Личные данные (переписки/сессии/контакты/удаление аккаунта) — через отдельные,
// закрытые кодом эндпоинты ниже.
app.get("/api/admin/user/:username", verifySuperAdmin, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  db.get(
    `SELECT username, displayName, bio, avatarUrl, birthDate, banned, muted, verified, createdAt, lastSeen FROM users WHERE username=?`,
    [u],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: "Не найден" });
      res.json({ ok: true, user: { ...row, online: isOnline(row.username) } });
    }
  );
});

app.get("/api/admin/user/:username/overview", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
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

  // Личная адресная книга пользователя (кого он сохранил и как подписал) —
  // тоже личные данные, отдаём только вместе с остальным «разблокированным» обзором.
  const contacts = await dbAll(
    `SELECT username, name, note, createdAt FROM contacts WHERE owner=? ORDER BY createdAt DESC`,
    [u]
  );

  res.json({ ok: true, partners, groups, globalMessageCount: globalCount.c, contacts });
});

// Просмотр и управление сессиями — тоже личные данные пользователя
// (IP, устройство, история входов), поэтому закрыто тем же кодом
// разблокировки, что и переписки/профили.
app.get("/api/admin/sessions", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
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

app.post("/api/admin/sessions/:id/revoke", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
  const id = Number(req.params.id);
  await dbRun(`UPDATE sessions SET revoked=1 WHERE id=?`, [id]);
  res.json({ ok: true });
});

app.get("/api/me/sessions", verifyAuth, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM sessions WHERE username=? AND revoked=0 ORDER BY createdAt DESC LIMIT 50`, [req.user.username]);
  const withCurrent = rows.map(s => ({ ...s, current: !!req.sessionJti && s.jti === req.sessionJti }));
  res.json({ ok: true, sessions: withCurrent });
});

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

// ---------------- SUPPORT ----------------
async function sendSupportMessage(username, text) {
  const createdAt = now();
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES ('support','support',?,?,'text','',?)`,
    [username, text, createdAt]
  );
  const msg = { id: result.lastID, chatType: "support", sender: "support", receiver: username, text, mediaType: "text", mediaUrl: "", createdAt, fileName: "", fileSize: 0, forwardedFrom: "" };
  await broadcastMessage(msg);
  return msg;
}

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

  const msg = await sendSupportMessage(u, text);
  res.json({ ok: true, message: msg });
});

// ---------------- CONTACT REQUESTS (официальные аккаунты) ----------------
app.get("/api/admin/contact-requests", verifySuperAdmin, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM contact_requests WHERE status='pending' ORDER BY createdAt ASC LIMIT 200`);
  res.json({ ok: true, requests: rows });
});

app.post("/api/admin/contact-requests/:id/approve", verifySuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await dbGet(`SELECT * FROM contact_requests WHERE id=?`, [id]);
  if (!r || r.status !== "pending") return res.status(404).json({ ok: false, error: "Заявка не найдена" });

  await dbRun(`UPDATE contact_requests SET status='forwarded', decidedAt=? WHERE id=?`, [now(), id]);

  const fromCard = await getUserCard(r.fromUser);
  await sendSupportMessage(
    r.toUser,
    `📨 ${fromCard.displayName} (@${r.fromUser}) хочет тебе написать. Администрация проверила заявку и передала её тебе. Открой список чатов — там кнопки «Принять» и «Отклонить».`
  );
  wsSendToUser(r.toUser, { type: "contactRequest", from: r.fromUser });
  await sendSupportMessage(r.fromUser, `✅ Администрация одобрила твою заявку. Теперь решение за @${r.toUser} — ответ придёт сюда.`);
  res.json({ ok: true });
});

app.post("/api/admin/contact-requests/:id/reject", verifySuperAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const r = await dbGet(`SELECT * FROM contact_requests WHERE id=?`, [id]);
  if (!r || r.status !== "pending") return res.status(404).json({ ok: false, error: "Заявка не найдена" });

  await dbRun(`UPDATE contact_requests SET status='rejected', decidedAt=? WHERE id=?`, [now(), id]);
  await sendSupportMessage(r.fromUser, `❌ Администрация отклонила заявку на связь с @${r.toUser}.`);
  res.json({ ok: true });
});

app.get("/api/me/contact-requests", verifyAuth, async (req, res) => {
  const rows = await dbAll(
    `SELECT * FROM contact_requests WHERE toUser=? AND status='forwarded' ORDER BY createdAt ASC LIMIT 50`,
    [req.user.username]
  );
  const cards = await getUserCards(rows.map(r => r.fromUser));
  res.json({
    ok: true,
    requests: rows.map(r => ({ ...r, from: cards[r.fromUser] || { username: r.fromUser, displayName: r.fromUser } }))
  });
});

app.post("/api/me/contact-requests/:id/accept", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await dbGet(`SELECT * FROM contact_requests WHERE id=?`, [id]);
  if (!r || r.toUser !== req.user.username || r.status !== "forwarded") {
    return res.status(404).json({ ok: false, error: "Заявка не найдена" });
  }

  await dbRun(`UPDATE contact_requests SET status='approved', decidedAt=? WHERE id=?`, [now(), id]);
  await dbRun(`INSERT OR IGNORE INTO dm_exceptions (owner, allowed, createdAt) VALUES (?,?,?)`, [r.toUser, r.fromUser, now()]);

  const createdAt = now();
  const text = `✉️ Через администрацию:\n${r.text}`;
  const result = await dbRun(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES ('private',?,?,?,'text','',?)`,
    [r.fromUser, r.toUser, text, createdAt]
  );
  await broadcastMessage({ id: result.lastID, chatType: "private", sender: r.fromUser, receiver: r.toUser, text, mediaType: "text", mediaUrl: "", createdAt, fileName: "", fileSize: 0, forwardedFrom: "" });

  await sendSupportMessage(r.fromUser, `🎉 @${r.toUser} принял(а) твою заявку. Теперь можно писать напрямую!`);
  res.json({ ok: true, from: r.fromUser });
});

app.post("/api/me/contact-requests/:id/reject", verifyAuth, async (req, res) => {
  const id = Number(req.params.id);
  const r = await dbGet(`SELECT * FROM contact_requests WHERE id=?`, [id]);
  if (!r || r.toUser !== req.user.username || r.status !== "forwarded") {
    return res.status(404).json({ ok: false, error: "Заявка не найдена" });
  }

  await dbRun(`UPDATE contact_requests SET status='rejected', decidedAt=? WHERE id=?`, [now(), id]);
  await sendSupportMessage(r.fromUser, `❌ @${r.toUser} не готов(а) сейчас переписываться.`);
  res.json({ ok: true });
});

app.get("/api/admin/messages/private/:userA/:userB", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
  const a = String(req.params.userA || "").replace(/^@+/, "").toLowerCase();
  const b = String(req.params.userB || "").replace(/^@+/, "").toLowerCase();

  const rows = await dbAll(
    `SELECT * FROM messages WHERE chatType='private' AND ((sender=? AND receiver=?) OR (sender=? AND receiver=?)) ORDER BY createdAt ASC LIMIT 2000`,
    [a, b, b, a]
  );
  res.json({ ok: true, messages: rows });
});

app.get("/api/admin/messages/group/:id", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
  const groupId = Number(req.params.id);
  const rows = await dbAll(
    `SELECT * FROM messages WHERE chatType='group' AND receiver=? ORDER BY createdAt ASC LIMIT 2000`,
    [`group:${groupId}`]
  );
  res.json({ ok: true, messages: rows });
});

app.get("/api/admin/messages/global", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
  const rows = await dbAll(`SELECT * FROM messages WHERE chatType='global' ORDER BY createdAt DESC LIMIT 500`);
  res.json({ ok: true, messages: rows });
});

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

// Удаление аккаунта — необратимо и затрагивает все личные данные, поэтому
// тоже закрыто кодом разблокировки (в отличие от бана/мута — это не
// повседневный инструмент модерации).
app.delete("/api/admin/delete/:username", verifySuperAdmin, requireMsgUnlock, async (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  const exists = await dbGet(`SELECT username FROM users WHERE username=?`, [u]);
  if (!exists) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

  await wipeUserData(u);
  closeAllConnections(u);
  res.json({ ok: true });
});

// ================================================================
// WEBSOCKET
// ================================================================
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

async function canPostTo(chatType, receiver, username) {
  if (chatType === "global") return { canPost: true, canRead: true };
  if (chatType === "support") return { canPost: true, canRead: true };
  if (chatType === "private") {
    if (receiver === username) return { canPost: true, canRead: true };
    const target = await dbGet(`SELECT username, verified, settings FROM users WHERE username=?`, [receiver]);
    if (!target) return { canPost: false, canRead: false, error: "Пользователь не найден" };
    if (!(await dmAllowed(target, username))) {
      return {
        canPost: false, canRead: true, gated: true,
        error: "Этот аккаунт официально подтверждён ✅. Чтобы написать, отправь заявку через администрацию."
      };
    }
    return { canPost: true, canRead: true };
  }
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
  if (chatType === "private" || chatType === "support") return [...new Set([sender, receiver])];
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
  try { msg.senderInfo = await getUserCard(msg.sender); } catch {}
  await broadcastToChat(msg.chatType, msg.receiver, msg.sender, { type: "message", message: msg });
  pushNotifyMessage(msg);
}

async function pushNotifyMessage(msg) {
  if (!webpush || msg.chatType === "global") return;

  const recipients = (await recipientsFor(msg.chatType, msg.receiver, msg.sender))
    .filter(u => u !== msg.sender && !isOnline(u));
  if (recipients.length === 0) return;

  const body = previewText(msg);
  const title = msg.chatType === "group" ? `Группа · @${msg.sender}` : (msg.sender === "support" ? "UzMessenger" : `@${msg.sender}`);

  for (const u of recipients) {
    sendPushToUser(u, { title, body, url: "/chat.html" }).catch(() => {});
  }
}

async function broadcastDelete(row, id) {
  await broadcastToChat(row.chatType, row.receiver, row.sender, { type: "messageDeleted", id });
}

// ================================================================
// ЗВОНКИ (аудио/видео, push на заблокированный телефон, TURN, группы)
// Логика вынесена в отдельный файл calls-server.js (лежит рядом с server.js)
// ================================================================
const calls = require("./calls-server")({
  app, verifyAuth, rateLimit, dbGet, dbAll, dbRun,
  isOnline, wsSend, wsSendToUser, getUserCard, isMember,
  getWebpush: () => webpush,
  canCall: canCallUser
});

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || "";
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    if (decoded.purpose) return ws.close();
    const username = String(decoded.username || "");

    const proceedConnection = (user) => {
      if (!user || user.banned) return ws.close();

      ws.username = username;
      addOnline(username, ws);

      wsSend(ws, { type: "ws-ready", username });
      calls.onConnect(ws, username);
      broadcastPresence();

      ws.on("message", async (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || !data.type) return;

        const from = ws.username;

        if (data.type === "typing") {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          if (to === from) return;
          if (to.startsWith("group:")) {
            const groupId = Number(to.slice(6));
            const members = await dbAll(`SELECT username FROM group_members WHERE groupId=?`, [groupId]);
            for (const m of members) if (m.username !== from) wsSendToUser(m.username, { type: "typing", from, to, isTyping: !!data.isTyping });
          } else {
            wsSendToUser(to, { type: "typing", from, isTyping: !!data.isTyping });
          }
          return;
        }

        if (calls.handleSignal(ws, data, from)) return;

        if (data.type === "text-message") {
          const user = await dbGet(`SELECT muted, banned FROM users WHERE username=?`, [from]);
          if (!user || user.banned || user.muted) return;

          const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
          const chatType = resolveChatType(receiver);
          const text = String(data.text || "").trim().slice(0, 2000);
          if (!text) return;

          const perm = await canPostTo(chatType, receiver, from);
          if (!perm.canPost) return wsSend(ws, { type: "post-error", gated: !!perm.gated, to: receiver, message: perm.error || "Нет доступа" });

          let replyTo = Number(data.replyTo) || 0;
          let replyPreview = null;
          if (replyTo) {
            const replied = await dbGet(`SELECT id, sender, text, mediaType FROM messages WHERE id=?`, [replyTo]);
            if (replied && (await canReadMessage(replied, from))) replyPreview = replied;
            else replyTo = 0;
          }

          const createdAt = now();
          const result = await dbRun(
            `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt, replyTo) VALUES (?,?,?,?,?,?,?,?)`,
            [chatType, from, receiver, text, "text", "", createdAt, replyTo]
          );
          const msg = { id: result.lastID, chatType, sender: from, receiver, text, mediaType: "text", mediaUrl: "", createdAt, fileName: "", fileSize: 0, forwardedFrom: "", replyTo, replyPreview };
          await broadcastMessage(msg);
          return;
        }

        if (data.type === "edit-message") {
          const id = Number(data.id);
          const text = String(data.text || "").trim().slice(0, 2000);
          if (!id || !text) return;
          const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
          if (!row || row.sender !== from || row.mediaType !== "text") return;
          await dbRun(`UPDATE messages SET text=?, edited=1 WHERE id=?`, [text, id]);
          await broadcastToChat(row.chatType, row.receiver, row.sender, { type: "messageEdited", id, text, edited: true });
          return;
        }

        if (data.type === "mark-read") {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          const upToId = Number(data.upToId) || 0;
          if (!to || !upToId || to === from) return;
          const chatType = resolveChatType(to);
          if (chatType === "support") return;

          let rows;
          if (chatType === "private") {
            // сообщения, которые "to" отправил(а) мне (from) — их я сейчас прочитал(а)
            rows = await dbAll(
              `SELECT id FROM messages WHERE chatType='private' AND sender=? AND receiver=? AND id<=?`,
              [to, from, upToId]
            );
          } else if (chatType === "group") {
            if (!(await isMember(Number(String(to).slice(6)), from))) return;
            rows = await dbAll(
              `SELECT id FROM messages WHERE chatType='group' AND receiver=? AND sender!=? AND id<=?`,
              [to, from, upToId]
            );
          } else if (chatType === "global") {
            rows = await dbAll(`SELECT id FROM messages WHERE chatType='global' AND sender!=? AND id<=?`, [from, upToId]);
          } else {
            return;
          }
          if (!rows.length) return;

          const readAt = now();
          for (const r of rows) {
            await dbRun(`INSERT OR IGNORE INTO message_reads (messageId, reader, readAt) VALUES (?,?,?)`, [r.id, from, readAt]);
          }

          if (chatType === "private") {
            // отправителю (to) шлём событие с ключом чата = мой username (from), т.к. это его "переписка со мной"
            wsSendToUser(to, { type: "read", by: from, chatKey: from, upToId, readAt });
          } else {
            await broadcastToChat(chatType, to, from, { type: "read", by: from, chatKey: to, upToId, readAt });
          }
          return;
        }

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
          if (!perm.canPost) return wsSend(ws, { type: "post-error", gated: !!perm.gated, to: receiver, message: perm.error || "Нет доступа" });

          const list = { title, items };
          const createdAt = now();
          const result = await dbRun(
            `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES (?,?,?,?,?,?,?)`,
            [chatType, from, receiver, JSON.stringify(list), "list", "", createdAt]
          );
          const msg = { id: result.lastID, chatType, sender: from, receiver, text: JSON.stringify(list), mediaType: "list", mediaUrl: "", createdAt, fileName: "", fileSize: 0, forwardedFrom: "" };
          await broadcastMessage(msg);
          return;
        }

        if (data.type === "location-message") {
          const user = await dbGet(`SELECT muted, banned FROM users WHERE username=?`, [from]);
          if (!user || user.banned || user.muted) return;

          const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
          const chatType = resolveChatType(receiver);
          const lat = Number(data.lat), lng = Number(data.lng);
          const acc = Math.max(0, Math.min(100000, Math.round(Number(data.accuracy) || 0)));
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

          const perm = await canPostTo(chatType, receiver, from);
          if (!perm.canPost) return wsSend(ws, { type: "post-error", gated: !!perm.gated, to: receiver, message: perm.error || "Нет доступа" });

          const text = JSON.stringify({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)), acc });
          const createdAt = now();
          const result = await dbRun(
            `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt) VALUES (?,?,?,?,?,?,?)`,
            [chatType, from, receiver, text, "location", "", createdAt]
          );
          const msg = { id: result.lastID, chatType, sender: from, receiver, text, mediaType: "location", mediaUrl: "", createdAt, fileName: "", fileSize: 0, forwardedFrom: "" };
          await broadcastMessage(msg);
          return;
        }

        if (data.type === "list-toggle") {
          const id = Number(data.id);
          const itemIndex = Number(data.itemIndex);
          const row = await dbGet(`SELECT * FROM messages WHERE id=?`, [id]);
          if (!row || row.mediaType !== "list") return;
          if (!(await canReadMessage(row, from))) return;

          let list;
          try { list = JSON.parse(row.text); } catch { return; }
          if (!list.items || !list.items[itemIndex]) return;

          list.items[itemIndex].checked = !list.items[itemIndex].checked;
          await dbRun(`UPDATE messages SET text=? WHERE id=?`, [JSON.stringify(list), id]);
          await broadcastToChat(row.chatType, row.receiver, row.sender, { type: "listUpdated", id, list });
          return;
        }
      });

      ws.on("close", async () => {
        const u = ws.username;
        if (u) {
          removeOnline(u, ws);
          if (!isOnline(u)) {
            const at = now();
            try {
              await dbRun(`UPDATE users SET lastSeen=? WHERE username=?`, [at, u]);
              const row = await dbGet(`SELECT settings FROM users WHERE username=?`, [u]);
              const privacy = parseSettings(row).lastSeenPrivacy || "everyone";
              if (privacy === "everyone") broadcastAll({ type: "lastSeen", username: u, at });
            } catch {}
          }
        }
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

secretsReady.finally(() => {
  server.listen(PORT, () => console.log("Server running on", PORT));
  setTimeout(runBirthdayJob, 10 * 1000);
  setInterval(runBirthdayJob, 15 * 60 * 1000);
  setTimeout(runTosReminderJob, 20 * 1000);
  setInterval(runTosReminderJob, 60 * 60 * 1000);
});
