const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");
const multer = require("multer");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const safeName =
      Date.now() + "-" + Math.random().toString(36).slice(2) + path.extname(file.originalname);
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const db = new sqlite3.Database("./database.db");

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

async function safeAlter(sql) {
  try {
    await run(sql);
  } catch (err) {
    if (!String(err.message).includes("duplicate column")) {
      console.log("Migration:", err.message);
    }
  }
}

function normalizeUsername(value = "") {
  return String(value).trim().replace(/^@+/, "").toLowerCase();
}

function authUserFromHeader(req) {
  return normalizeUsername(req.headers["x-user"] || "");
}

function requireUser(req, res, next) {
  const username = authUserFromHeader(req);
  if (!username) {
    return res.status(401).json({ success: false, error: "Нет пользователя в заголовке x-user" });
  }
  req.currentUser = username;
  next();
}

function isTodayBirthday(dateStr = "") {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getUTCDate() === now.getDate() && d.getUTCMonth() === now.getMonth();
}

function messagePreview(row) {
  if (row.mediaType === "image") return "📷 Фото";
  if (row.mediaType === "video") return "🎬 Видео";
  if (row.mediaType === "audio") return "🎙 Голосовое";
  return row.text || "Сообщение";
}

async function initDb() {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      pinHash TEXT,
      displayName TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      createdAt INTEGER DEFAULT 0
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',
      mediaUrl TEXT DEFAULT '',
      createdAt INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS contacts (
      owner TEXT NOT NULL,
      contact TEXT NOT NULL,
      savedName TEXT DEFAULT '',
      createdAt INTEGER NOT NULL,
      UNIQUE(owner, contact)
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS stories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      mediaType TEXT NOT NULL DEFAULT 'image',
      mediaUrl TEXT DEFAULT '',
      text TEXT DEFAULT '',
      createdAt INTEGER NOT NULL,
      expiresAt INTEGER NOT NULL
    )
  `);

  await safeAlter(`ALTER TABLE users ADD COLUMN pinHash TEXT`);
  await safeAlter(`ALTER TABLE users ADD COLUMN displayName TEXT DEFAULT ''`);
  await safeAlter(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
  await safeAlter(`ALTER TABLE users ADD COLUMN avatar TEXT DEFAULT ''`);
  await safeAlter(`ALTER TABLE users ADD COLUMN createdAt INTEGER DEFAULT 0`);
  await safeAlter(`ALTER TABLE users ADD COLUMN birthday TEXT DEFAULT ''`);
  await safeAlter(`ALTER TABLE users ADD COLUMN profileVisibility TEXT DEFAULT 'all'`);
  await safeAlter(`ALTER TABLE users ADD COLUMN storyVisibility TEXT DEFAULT 'all'`);

  await run(`
    UPDATE users
    SET displayName = CASE
      WHEN displayName IS NULL OR displayName = '' THEN username
      ELSE displayName
    END
  `);

  await run(`
    UPDATE users
    SET createdAt = CASE
      WHEN createdAt IS NULL OR createdAt = 0 THEN strftime('%s','now') * 1000
      ELSE createdAt
    END
  `);
}

function getFullUser(username) {
  return get(
    `SELECT username, pinHash, displayName, bio, avatar, createdAt, birthday, profileVisibility, storyVisibility
     FROM users
     WHERE username = ?`,
    [username]
  );
}

async function areConnected(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;

  const row = await get(
    `SELECT 1 FROM contacts
     WHERE (owner = ? AND contact = ?)
        OR (owner = ? AND contact = ?)
     LIMIT 1`,
    [a, b, b, a]
  );
  return !!row;
}

async function sanitizeProfileForViewer(ownerUsername, viewerUsername) {
  const user = await getFullUser(ownerUsername);
  if (!user) return null;

  const connected = await areConnected(ownerUsername, viewerUsername);
  const canSeePrivate = user.profileVisibility === "all" || connected || ownerUsername === viewerUsername;

  return {
    username: user.username,
    displayName: canSeePrivate ? (user.displayName || user.username) : user.username,
    bio: canSeePrivate ? (user.bio || "") : "",
    avatar: canSeePrivate ? (user.avatar || "") : "",
    createdAt: user.createdAt,
    birthday: canSeePrivate ? (user.birthday || "") : "",
    todayBirthday: canSeePrivate ? isTodayBirthday(user.birthday) : false,
    profileVisibility: ownerUsername === viewerUsername ? user.profileVisibility : undefined,
    storyVisibility: ownerUsername === viewerUsername ? user.storyVisibility : undefined
  };
}

const onlineUsers = new Map();

function sendToUser(username, payload) {
  const ws = onlineUsers.get(username);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const username = normalizeUsername(url.searchParams.get("user"));
  if (!username) {
    ws.close();
    return;
  }

  onlineUsers.set(username, ws);

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type !== "text") return;

      const sender = normalizeUsername(data.sender);
      const receiver = normalizeUsername(data.receiver || "global");
      const text = String(data.text || "").trim();

      if (!sender || !receiver || !text) return;

      const createdAt = Date.now();

      await run(
        `INSERT INTO messages (sender, receiver, text, mediaType, mediaUrl, createdAt)
         VALUES (?, ?, ?, 'text', '', ?)`,
        [sender, receiver, text, createdAt]
      );

      const senderProfile = await sanitizeProfileForViewer(sender, sender);

      const payload = {
        type: "message",
        sender,
        receiver,
        text,
        mediaType: "text",
        mediaUrl: "",
        createdAt,
        displayName: senderProfile?.displayName || sender
      };

      if (receiver === "global") {
        for (const [, client] of onlineUsers) {
          if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
        }
      } else {
        sendToUser(sender, payload);
        sendToUser(receiver, payload);
      }
    } catch (err) {
      console.error("WS error:", err.message);
    }
  });

  ws.on("close", () => {
    if (onlineUsers.get(username) === ws) onlineUsers.delete(username);
  });
});

/* AUTH */

app.post("/api/auth/reg", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const pin = String(req.body.pin || "").trim();

    if (!username || !pin) {
      return res.status(400).json({ success: false, error: "Заполните все поля" });
    }

    if (!/^[a-z0-9_]{4,20}$/.test(username)) {
      return res.status(400).json({ success: false, error: "Юзернейм: 4-20 символов, только a-z, 0-9 и _" });
    }

    if (!/^\d{6}$/.test(pin)) {
      return res.status(400).json({ success: false, error: "Код должен быть из 6 цифр" });
    }

    const existing = await getFullUser(username);
    if (existing) {
      return res.status(400).json({ success: false, error: "Юзернейм занят" });
    }

    const pinHash = await bcrypt.hash(pin, 10);

    await run(
      `INSERT INTO users
       (username, pinHash, displayName, bio, avatar, createdAt, birthday, profileVisibility, storyVisibility)
       VALUES (?, ?, ?, '', '', ?, '', 'all', 'all')`,
      [username, pinHash, username, Date.now()]
    );

    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка регистрации" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const username = normalizeUsername(req.body.username);
    const pin = String(req.body.pin || "").trim();

    if (!username || !pin) {
      return res.status(400).json({ success: false, error: "Заполните все поля" });
    }

    const user = await getFullUser(username);
    if (!user) {
      return res.status(401).json({ success: false, error: "Пользователь не найден" });
    }

    if (!user.pinHash) {
      return res.status(400).json({ success: false, error: "Для этого аккаунта не настроен PIN-код" });
    }

    const pinOk = await bcrypt.compare(pin, user.pinHash);
    if (!pinOk) {
      return res.status(401).json({ success: false, error: "Неверный цифровой код" });
    }

    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка входа" });
  }
});

/* USERS / PROFILE */

app.get("/api/search", requireUser, async (req, res) => {
  try {
    const query = normalizeUsername(req.query.q || "");
    if (!query) return res.json([]);

    const rows = await all(
      `SELECT username
       FROM users
       WHERE username LIKE ?
       ORDER BY username ASC
       LIMIT 20`,
      [`%${query}%`]
    );

    const result = [];
    for (const row of rows) {
      if (row.username === req.currentUser) continue;
      const profile = await sanitizeProfileForViewer(row.username, req.currentUser);
      if (profile) result.push(profile);
    }

    res.json(result);
  } catch {
    res.status(500).json([]);
  }
});

app.get("/api/profile/:username", requireUser, async (req, res) => {
  try {
    const username = normalizeUsername(req.params.username);
    const profile = await sanitizeProfileForViewer(username, req.currentUser);

    if (!profile) {
      return res.status(404).json({ success: false, error: "Профиль не найден" });
    }

    const connected = await areConnected(req.currentUser, username);

    res.json({
      success: true,
      profile,
      isContact: connected
    });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка загрузки профиля" });
  }
});

app.get("/api/me", requireUser, async (req, res) => {
  try {
    const user = await getFullUser(req.currentUser);
    if (!user) {
      return res.status(404).json({ success: false, error: "Пользователь не найден" });
    }

    res.json({
      success: true,
      profile: {
        username: user.username,
        displayName: user.displayName || user.username,
        bio: user.bio || "",
        avatar: user.avatar || "",
        createdAt: user.createdAt,
        birthday: user.birthday || "",
        todayBirthday: isTodayBirthday(user.birthday),
        profileVisibility: user.profileVisibility || "all",
        storyVisibility: user.storyVisibility || "all"
      }
    });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка загрузки профиля" });
  }
});

app.post("/api/me", requireUser, upload.single("avatar"), async (req, res) => {
  try {
    const displayName = String(req.body.displayName || "").trim().slice(0, 40);
    const bio = String(req.body.bio || "").trim().slice(0, 160);
    const birthday = String(req.body.birthday || "").trim().slice(0, 20);
    const profileVisibility = ["all", "contacts"].includes(req.body.profileVisibility)
      ? req.body.profileVisibility
      : "all";
    const storyVisibility = ["all", "contacts"].includes(req.body.storyVisibility)
      ? req.body.storyVisibility
      : "all";

    const newUsername = normalizeUsername(req.body.username || req.currentUser);
    const newPin = String(req.body.newPin || "").trim();

    if (!/^[a-z0-9_]{4,20}$/.test(newUsername)) {
      return res.status(400).json({ success: false, error: "Некорректный юзернейм" });
    }

    if (newPin && !/^\d{6}$/.test(newPin)) {
      return res.status(400).json({ success: false, error: "Новый PIN должен быть из 6 цифр" });
    }

    const currentAvatar = String(req.body.currentAvatar || "");
    const avatar = req.file ? `/uploads/${req.file.filename}` : currentAvatar;

    if (newUsername !== req.currentUser) {
      const existing = await getFullUser(newUsername);
      if (existing) {
        return res.status(400).json({ success: false, error: "Этот юзернейм уже занят" });
      }
    }

    const currentUserRow = await getFullUser(req.currentUser);
    let pinHash = currentUserRow?.pinHash || "";
    if (newPin) {
      pinHash = await bcrypt.hash(newPin, 10);
    }

    await run(
      `UPDATE users
       SET username = ?, pinHash = ?, displayName = ?, bio = ?, avatar = ?, birthday = ?, profileVisibility = ?, storyVisibility = ?
       WHERE username = ?`,
      [
        newUsername,
        pinHash,
        displayName || newUsername,
        bio,
        avatar,
        birthday,
        profileVisibility,
        storyVisibility,
        req.currentUser
      ]
    );

    if (newUsername !== req.currentUser) {
      await run(`UPDATE messages SET sender = ? WHERE sender = ?`, [newUsername, req.currentUser]);
      await run(`UPDATE messages SET receiver = ? WHERE receiver = ?`, [newUsername, req.currentUser]);
      await run(`UPDATE contacts SET owner = ? WHERE owner = ?`, [newUsername, req.currentUser]);
      await run(`UPDATE contacts SET contact = ? WHERE contact = ?`, [newUsername, req.currentUser]);
      await run(`UPDATE stories SET owner = ? WHERE owner = ?`, [newUsername, req.currentUser]);
    }

    const updated = await getFullUser(newUsername);
    res.json({
      success: true,
      profile: {
        username: updated.username,
        displayName: updated.displayName || updated.username,
        bio: updated.bio || "",
        avatar: updated.avatar || "",
        createdAt: updated.createdAt,
        birthday: updated.birthday || "",
        todayBirthday: isTodayBirthday(updated.birthday),
        profileVisibility: updated.profileVisibility || "all",
        storyVisibility: updated.storyVisibility || "all"
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: "Ошибка сохранения профиля" });
  }
});

/* CONTACTS */

app.post("/api/contacts/add", requireUser, async (req, res) => {
  try {
    const contact = normalizeUsername(req.body.username);
    const savedName = String(req.body.savedName || "").trim().slice(0, 40);

    if (!contact || contact === req.currentUser) {
      return res.status(400).json({ success: false, error: "Некорректный контакт" });
    }

    const target = await getFullUser(contact);
    if (!target) {
      return res.status(404).json({ success: false, error: "Пользователь не найден" });
    }

    await run(
      `INSERT OR IGNORE INTO contacts (owner, contact, savedName, createdAt)
       VALUES (?, ?, ?, ?)`,
      [req.currentUser, contact, savedName, Date.now()]
    );

    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка добавления контакта" });
  }
});

app.get("/api/contacts", requireUser, async (req, res) => {
  try {
    const rows = await all(
      `SELECT c.contact, c.savedName
       FROM contacts c
       WHERE c.owner = ?
       ORDER BY c.createdAt DESC`,
      [req.currentUser]
    );

    const result = [];
    for (const row of rows) {
      const profile = await sanitizeProfileForViewer(row.contact, req.currentUser);
      if (profile) {
        result.push({
          ...profile,
          savedName: row.savedName || ""
        });
      }
    }

    res.json(result);
  } catch {
    res.status(500).json([]);
  }
});

/* STORIES */

app.post("/api/stories", requireUser, upload.single("story"), async (req, res) => {
  try {
    const text = String(req.body.text || "").trim().slice(0, 120);
    let mediaType = "text";
    let mediaUrl = "";

    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
      if (req.file.mimetype.startsWith("image/")) mediaType = "image";
      else if (req.file.mimetype.startsWith("video/")) mediaType = "video";
    }

    if (!text && !mediaUrl) {
      return res.status(400).json({ success: false, error: "Добавьте текст или файл для сторис" });
    }

    const createdAt = Date.now();
    const expiresAt = createdAt + 24 * 60 * 60 * 1000;

    await run(
      `INSERT INTO stories (owner, mediaType, mediaUrl, text, createdAt, expiresAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.currentUser, mediaType, mediaUrl, text, createdAt, expiresAt]
    );

    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка публикации сторис" });
  }
});

app.get("/api/stories", requireUser, async (req, res) => {
  try {
    const now = Date.now();
    await run(`DELETE FROM stories WHERE expiresAt < ?`, [now]);

    const rows = await all(
      `SELECT * FROM stories
       ORDER BY createdAt DESC`,
      []
    );

    const result = [];
    for (const row of rows) {
      const owner = await getFullUser(row.owner);
      if (!owner) continue;

      const connected = await areConnected(req.currentUser, row.owner);
      const canSee = owner.storyVisibility === "all" || connected || row.owner === req.currentUser;

      if (!canSee) continue;

      const profile = await sanitizeProfileForViewer(row.owner, req.currentUser);

      result.push({
        id: row.id,
        owner: row.owner,
        displayName: profile?.displayName || row.owner,
        avatar: profile?.avatar || "",
        mediaType: row.mediaType,
        mediaUrl: row.mediaUrl,
        text: row.text,
        createdAt: row.createdAt
      });
    }

    res.json(result);
  } catch {
    res.status(500).json([]);
  }
});

/* BIRTHDAY */

app.get("/api/birthdays/today", requireUser, async (req, res) => {
  try {
    const users = await all(`SELECT username FROM users ORDER BY username ASC`);
    const result = [];

    for (const row of users) {
      const profile = await sanitizeProfileForViewer(row.username, req.currentUser);
      if (profile?.todayBirthday) {
        result.push(profile);
      }
    }

    res.json(result);
  } catch {
    res.status(500).json([]);
  }
});

/* CHATS */

app.get("/api/chats", requireUser, async (req, res) => {
  try {
    const me = req.currentUser;
    const rows = await all(
      `
      SELECT * FROM (
        SELECT
          CASE
            WHEN sender = ? THEN receiver
            ELSE sender
          END AS username,
          text,
          mediaType,
          createdAt
        FROM messages
        WHERE receiver != 'global'
          AND (sender = ? OR receiver = ?)
        ORDER BY createdAt DESC
      )
      GROUP BY username
      ORDER BY createdAt DESC
      `,
      [me, me, me]
    );

    const enriched = [];
    for (const row of rows) {
      const user = await sanitizeProfileForViewer(row.username, me);
      if (!user) continue;

      enriched.push({
        username: user.username,
        displayName: user.displayName || user.username,
        bio: user.bio || "",
        avatar: user.avatar || "",
        todayBirthday: user.todayBirthday || false,
        preview: messagePreview(row),
        createdAt: row.createdAt
      });
    }

    res.json(enriched);
  } catch {
    res.status(500).json([]);
  }
});

app.get("/api/messages", requireUser, async (req, res) => {
  try {
    const chat = normalizeUsername(req.query.chat || "global");
    const me = req.currentUser;
    let rows = [];

    if (chat === "global") {
      rows = await all(
        `SELECT m.*, u.displayName
         FROM messages m
         LEFT JOIN users u ON u.username = m.sender
         WHERE m.receiver = 'global'
         ORDER BY m.createdAt ASC
         LIMIT 300`
      );
    } else {
      rows = await all(
        `SELECT m.*, u.displayName
         FROM messages m
         LEFT JOIN users u ON u.username = m.sender
         WHERE
           (m.sender = ? AND m.receiver = ?)
           OR
           (m.sender = ? AND m.receiver = ?)
         ORDER BY m.createdAt ASC
         LIMIT 300`,
        [me, chat, chat, me]
      );
    }

    res.json(rows);
  } catch {
    res.status(500).json([]);
  }
});

app.post("/api/upload", requireUser, upload.single("file"), async (req, res) => {
  try {
    const receiver = normalizeUsername(req.body.receiver || "global");
    const sender = req.currentUser;
    const text = String(req.body.text || "").trim();
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, error: "Файл не загружен" });
    }

    let mediaType = "file";
    if (file.mimetype.startsWith("image/")) mediaType = "image";
    else if (file.mimetype.startsWith("video/")) mediaType = "video";
    else if (file.mimetype.startsWith("audio/")) mediaType = "audio";

    const mediaUrl = `/uploads/${file.filename}`;
    const createdAt = Date.now();

    await run(
      `INSERT INTO messages (sender, receiver, text, mediaType, mediaUrl, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sender, receiver, text, mediaType, mediaUrl, createdAt]
    );

    const senderProfile = await sanitizeProfileForViewer(sender, sender);

    const payload = {
      type: "message",
      sender,
      receiver,
      text,
      mediaType,
      mediaUrl,
      createdAt,
      displayName: senderProfile?.displayName || sender
    };

    if (receiver === "global") {
      for (const [, client] of onlineUsers) {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
      }
    } else {
      sendToUser(sender, payload);
      sendToUser(receiver, payload);
    }

    res.json({ success: true, message: payload });
  } catch {
    res.status(500).json({ success: false, error: "Ошибка загрузки файла" });
  }
});

initDb()
  .then(() => {
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error("DB init error:", err);
    process.exit(1);
  });
