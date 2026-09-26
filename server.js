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

if (!JWT_SECRET) {
  console.warn(
    "[SECURITY WARNING] JWT_SECRET is not set. Set it in your environment " +
    "(Render -> Environment). Falling back to a random secret for this " +
    "process only, which means all tokens will become invalid on restart."
  );
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || crypto.randomBytes(32).toString("hex");

// Comma-separated list of usernames that should be promoted to admin on boot,
// e.g. ADMIN_USERNAMES=asadbek000,another_admin
const ADMIN_USERNAMES = String(process.env.ADMIN_USERNAMES || "")
  .split(",")
  .map(s => s.trim().replace(/^@+/, "").toLowerCase())
  .filter(Boolean);

app.use(express.json({ limit: "2mb" })); // 30mb was unnecessarily large and only needed for binary uploads, which go through multer instead
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

// ---------------- UPLOAD SAFETY ----------------
// Never trust the extension the client sends. Map from the sniffed mimetype
// instead, so a crafted filename like `evil.jpg" onerror="alert(1)` can never
// end up inside an <img src="..."> / <video src="..."> attribute.
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
      isAdmin INTEGER NOT NULL DEFAULT 0,
      banned INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Safe to run repeatedly against an existing DB from the old schema;
  // SQLite errors if the column already exists, which we just ignore.
  db.run(`ALTER TABLE users ADD COLUMN isAdmin INTEGER NOT NULL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0`, () => {});
  db.run(`ALTER TABLE users ADD COLUMN muted INTEGER NOT NULL DEFAULT 0`, () => {});

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatType TEXT NOT NULL,          -- global|private
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,          -- global or username
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',   -- text|image|video|audio
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

  db.run(`CREATE INDEX IF NOT EXISTS idx_msg ON messages(chatType, sender, receiver, createdAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_st_exp ON stories(expiresAt)`);

  if (ADMIN_USERNAMES.length) {
    const placeholders = ADMIN_USERNAMES.map(() => "?").join(",");
    db.run(`UPDATE users SET isAdmin=1 WHERE username IN (${placeholders})`, ADMIN_USERNAMES);
  }
});

function safeUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || "",
    avatarUrl: u.avatarUrl || "",
    birthDate: u.birthDate || "",
    isAdmin: !!u.isAdmin
  };
}

function signToken(username) {
  return jwt.sign({ username }, EFFECTIVE_JWT_SECRET, { expiresIn: "14d" });
}

function verifyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
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

function verifyAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ ok: false, error: "Доступ только для админов" });
  }
  next();
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
// Basic in-memory sliding window per IP. Good enough to stop naive brute
// force; swap for `express-rate-limit` + a shared store if you scale to
// multiple server instances.
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

    res.json({ ok: true, token: signToken(usernameRaw), user: safeUser(user) });
  });
});

// ---------------- PROFILE ----------------
app.get("/api/me", verifyAuth, (req, res) => res.json({ ok: true, profile: safeUser(req.user) }));

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

// search users
app.get("/api/users/search", verifyAuth, (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^@+/, "").toLowerCase();
  if (!q) return res.json({ ok: true, users: [] });

  db.all(
    `SELECT username, displayName, bio, avatarUrl
     FROM users
     WHERE username LIKE ? AND username != ? AND banned=0
     ORDER BY username ASC LIMIT 20`,
    [`%${q}%`, req.user.username],
    (err, rows) => res.json({ ok: true, users: rows || [] })
  );
});

app.get("/api/users/:username", verifyAuth, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  // birthDate is intentionally left out of the public profile lookup —
  // only the owner sees their own via /api/me. Anyone could otherwise pull
  // any user's exact date of birth just by knowing their @username.
  db.get(
    `SELECT username, displayName, bio, avatarUrl FROM users WHERE username=? AND banned=0`,
    [u],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: "Не найден" });
      res.json({ ok: true, user: row });
    }
  );
});

// ---------------- CHATS ----------------
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
        `SELECT username, displayName, avatarUrl FROM users WHERE username IN (${placeholders})`,
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
                const u = map.get(o) || { username: o, displayName: o, avatarUrl: "" };
                return {
                  username: u.username,
                  displayName: u.displayName || u.username,
                  avatarUrl: u.avatarUrl || "",
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
app.get("/api/messages", verifyAuth, (req, res) => {
  const chat = String(req.query.chat || "global").replace(/^@+/, "").toLowerCase();
  const me = req.user.username;

  if (chat === "global") {
    db.all(
      `SELECT * FROM messages WHERE chatType='global' ORDER BY createdAt ASC LIMIT 500`,
      (err, rows) => res.json({ ok: true, messages: rows || [] })
    );
    return;
  }

  const other = chat;
  db.all(
    `
    SELECT * FROM messages
    WHERE chatType='private'
      AND ((sender=? AND receiver=?) OR (sender=? AND receiver=?))
    ORDER BY createdAt ASC
    LIMIT 800
    `,
    [me, other, other, me],
    (err, rows) => res.json({ ok: true, messages: rows || [] })
  );
});

app.delete("/api/messages/:id", verifyAuth, (req, res) => {
  const id = Number(req.params.id);
  const me = req.user.username;

  db.get(`SELECT * FROM messages WHERE id=?`, [id], (err, row) => {
    if (!row) return res.status(404).json({ ok: false, error: "Не найдено" });
    if (row.sender !== me) return res.status(403).json({ ok: false, error: "Можно удалить только своё" });

    db.run(`DELETE FROM messages WHERE id=?`, [id], (e2) => {
      if (e2) return res.status(500).json({ ok: false, error: "Ошибка удаления" });

      broadcastDelete(row, id);
      res.json({ ok: true });
    });
  });
});

// ---------------- UPLOAD ----------------
app.post("/api/upload", verifyAuth, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message || "Ошибка загрузки" });
    next();
  });
}, (req, res) => {
  const me = req.user.username;

  if (req.user.muted) return res.status(403).json({ ok: false, error: "Тебе временно запрещено отправлять сообщения" });

  const receiver = String(req.body.receiver || "global").replace(/^@+/, "").toLowerCase();
  const chatType = receiver === "global" ? "global" : "private";
  const text = String(req.body.text || "").trim().slice(0, 2000);

  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  const mediaType = guessMediaType(req.file.mimetype);
  const ext = MIME_EXT[req.file.mimetype] || ""; // never trust the client-supplied filename/extension
  const newName = `${req.file.filename}${ext}`;
  fs.renameSync(req.file.path, path.join(uploadsDir, newName));
  const mediaUrl = `/uploads/${newName}`;

  const createdAt = now();
  db.run(
    `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt)
     VALUES (?,?,?,?,?,?,?)`,
    [chatType, me, receiver, text, mediaType, mediaUrl, createdAt],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения" });

      const msg = {
        id: this.lastID,
        chatType,
        sender: me,
        receiver,
        text,
        mediaType,
        mediaUrl,
        createdAt
      };

      broadcastMessage(msg);
      res.json({ ok: true, message: msg });
    }
  );
});

// ---------------- STORIES ----------------
app.get("/api/stories", verifyAuth, (req, res) => {
  cleanupStories();
  db.all(
    `
    SELECT s.*, u.displayName, u.avatarUrl
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
  const expiresAt = createdAt + 24 * 60 * 60 * 1000;

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

// ---------------- ADMIN ----------------
app.get("/api/admin/user/:username", verifyAuth, verifyAdmin, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  db.get(
    `SELECT username, displayName, bio, avatarUrl, birthDate, banned, muted, isAdmin FROM users WHERE username=?`,
    [u],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: "Не найден" });
      res.json({ ok: true, user: row });
    }
  );
});

function adminSetFlag(field, value) {
  return (req, res) => {
    const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
    if (u === req.user.username && field === "banned" && value === 1) {
      return res.status(400).json({ ok: false, error: "Нельзя забанить самого себя" });
    }
    db.run(`UPDATE users SET ${field}=? WHERE username=?`, [value, u], function (err) {
      if (err || this.changes === 0) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

      if (field === "banned" && value === 1) {
        const ws = online.get(u);
        if (ws) ws.close(); // kick a banned user off any live connection immediately
      }
      res.json({ ok: true });
    });
  };
}

app.post("/api/admin/ban/:username", verifyAuth, verifyAdmin, adminSetFlag("banned", 1));
app.post("/api/admin/unban/:username", verifyAuth, verifyAdmin, adminSetFlag("banned", 0));
app.post("/api/admin/mute/:username", verifyAuth, verifyAdmin, adminSetFlag("muted", 1));
app.post("/api/admin/unmute/:username", verifyAuth, verifyAdmin, adminSetFlag("muted", 0));

app.delete("/api/admin/delete/:username", verifyAuth, verifyAdmin, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  if (u === req.user.username) return res.status(400).json({ ok: false, error: "Нельзя удалить самого себя" });

  db.run(`DELETE FROM users WHERE username=?`, [u], function (err) {
    if (err || this.changes === 0) return res.status(404).json({ ok: false, error: "Пользователь не найден" });

    db.run(`DELETE FROM messages WHERE sender=? OR receiver=?`, [u, u]);
    db.run(`DELETE FROM stories WHERE owner=?`, [u]);

    const ws = online.get(u);
    if (ws) ws.close();

    res.json({ ok: true });
  });
});

// ---------------- WEBSOCKET (messages + typing + presence + calls) ----------------
const online = new Map(); // username -> ws

function wsSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastAll(payload) {
  for (const ws of online.values()) wsSend(ws, payload);
}

function broadcastPresence() {
  const list = Array.from(online.keys());
  broadcastAll({ type: "presence", online: list });
}

function broadcastMessage(msg) {
  if (msg.chatType === "global") {
    broadcastAll({ type: "message", message: msg });
    return;
  }
  wsSend(online.get(msg.sender), { type: "message", message: msg });
  wsSend(online.get(msg.receiver), { type: "message", message: msg });
}

function broadcastDelete(row, id) {
  if (row.chatType === "global") {
    broadcastAll({ type: "messageDeleted", id });
    return;
  }
  wsSend(online.get(row.sender), { type: "messageDeleted", id });
  wsSend(online.get(row.receiver), { type: "messageDeleted", id });
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || "";
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    const username = String(decoded.username || "");

    db.get(`SELECT * FROM users WHERE username=?`, [username], (err, user) => {
      if (!user || user.banned) return ws.close();

      ws.username = username;
      online.set(username, ws);

      wsSend(ws, { type: "ws-ready", username });
      broadcastPresence();

      ws.on("message", (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || !data.type) return;

        const from = ws.username;

        // typing indicator
        if (data.type === "typing") {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          const target = online.get(to);
          if (target) wsSend(target, { type: "typing", from, isTyping: !!data.isTyping });
          return;
        }

        // WebRTC audio call signaling
        if (["call-offer", "call-answer", "ice", "call-end", "call-reject"].includes(data.type)) {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          const target = online.get(to);
          if (!target) return wsSend(ws, { type: "call-error", message: "Пользователь не онлайн" });
          wsSend(target, { ...data, from });
          return;
        }

        // text message
        if (data.type === "text-message") {
          // Re-check mute status live (it may have changed since login).
          db.get(`SELECT muted, banned FROM users WHERE username=?`, [from], (e0, u) => {
            if (!u || u.banned || u.muted) return;

            const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
            const chatType = receiver === "global" ? "global" : "private";
            const text = String(data.text || "").trim().slice(0, 2000);
            if (!text) return;

            const createdAt = now();
            db.run(
              `INSERT INTO messages (chatType, sender, receiver, text, mediaType, mediaUrl, createdAt)
               VALUES (?,?,?,?,?,?,?)`,
              [chatType, from, receiver, text, "text", "", createdAt],
              function (err2) {
                if (err2) return;

                const msg = {
                  id: this.lastID,
                  chatType,
                  sender: from,
                  receiver,
                  text,
                  mediaType: "text",
                  mediaUrl: "",
                  createdAt
                };
                broadcastMessage(msg);
              }
            );
          });
          return;
        }
      });

      ws.on("close", () => {
        if (ws.username) online.delete(ws.username);
        broadcastPresence();
      });
    });
  } catch {
    ws.close();
  }
});

server.listen(PORT, () => console.log("Server running on", PORT));
