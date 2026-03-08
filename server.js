const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SECRET";

app.use(express.json({ limit: "30mb" }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });
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
      createdAt INTEGER NOT NULL DEFAULT 0
    )
  `);

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
});

function safeUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || "",
    avatarUrl: u.avatarUrl || "",
    birthDate: u.birthDate || ""
  };
}

function signToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "14d" });
}

function verifyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    db.get(`SELECT * FROM users WHERE username=?`, [decoded.username], (err, user) => {
      if (!user) return res.status(401).json({ ok: false, error: "Пользователь не найден" });
      req.user = user;
      next();
    });
  } catch {
    return res.status(401).json({ ok: false, error: "Неверный токен" });
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

// ---------------- AUTH ----------------
app.post("/api/auth/register", async (req, res) => {
  const usernameRaw = String(req.body.username || "").trim().replace(/^@+/, "").toLowerCase();
  const password = String(req.body.password || "").trim();

  if (!/^[a-z0-9_]{4,20}$/.test(usernameRaw)) {
    return res.status(400).json({ ok: false, error: "Юзернейм 4-20: a-z 0-9 _" });
  }
  if (password.length < 4) return res.status(400).json({ ok: false, error: "Пароль слишком короткий" });

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

app.post("/api/auth/login", (req, res) => {
  const usernameRaw = String(req.body.identifier || req.body.username || "").trim().replace(/^@+/, "").toLowerCase();
  const password = String(req.body.password || "").trim();

  db.get(`SELECT * FROM users WHERE username=?`, [usernameRaw], async (err, user) => {
    if (!user) return res.status(400).json({ ok: false, error: "Пользователь не найден" });

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
    `SELECT username, displayName, bio, avatarUrl, birthDate
     FROM users
     WHERE username LIKE ? AND username != ?
     ORDER BY username ASC LIMIT 20`,
    [`%${q}%`, req.user.username],
    (err, rows) => res.json({ ok: true, users: rows || [] })
  );
});

app.get("/api/users/:username", verifyAuth, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  db.get(
    `SELECT username, displayName, bio, avatarUrl, birthDate FROM users WHERE username=?`,
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
app.post("/api/upload", verifyAuth, upload.single("file"), (req, res) => {
  const me = req.user.username;
  const receiver = String(req.body.receiver || "global").replace(/^@+/, "").toLowerCase();
  const chatType = receiver === "global" ? "global" : "private";
  const text = String(req.body.text || "").trim().slice(0, 2000);

  if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

  const mediaType = guessMediaType(req.file.mimetype);
  const ext = path.extname(req.file.originalname) || "";
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
    WHERE s.expiresAt > ?
    ORDER BY s.createdAt DESC
    LIMIT 200
    `,
    [now()],
    (err, rows) => res.json({ ok: true, stories: rows || [] })
  );
});

app.post("/api/stories", verifyAuth, upload.single("story"), (req, res) => {
  const me = req.user.username;
  const text = String(req.body.text || "").trim().slice(0, 120);

  const createdAt = now();
  const expiresAt = createdAt + 24 * 60 * 60 * 1000;

  let mediaType = "text";
  let mediaUrl = "";

  if (req.file) {
    mediaType = guessMediaType(req.file.mimetype);
    const ext = path.extname(req.file.originalname) || "";
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
    `SELECT username, displayName, avatarUrl, birthDate
     FROM users
     WHERE substr(birthDate,6,2)=? AND substr(birthDate,9,2)=?`,
    [mm, dd],
    (err, rows) => res.json({ ok: true, list: rows || [] })
  );
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
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = String(decoded.username || "");

    db.get(`SELECT * FROM users WHERE username=?`, [username], (err, user) => {
      if (!user) return ws.close();

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
