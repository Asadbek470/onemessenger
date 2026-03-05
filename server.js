const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // обязательно для Render
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_SECRET";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "090909";
const SYSTEM_USERNAME = "telegram";

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use("/uploads", express.static(uploadsDir));

const upload = multer({ dest: uploadsDir });
const db = new sqlite3.Database("database.db");

// ==================== ИНИЦИАЛИЗАЦИЯ БД ====================
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
      createdAt INTEGER NOT NULL DEFAULT 0,
      lastSeen INTEGER DEFAULT 0,
      blockedUntil INTEGER DEFAULT 0,
      canSendText INTEGER DEFAULT 1,
      canSendMedia INTEGER DEFAULT 1,
      canCall INTEGER DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatType TEXT NOT NULL,
      groupId INTEGER,
      user1 TEXT,
      user2 TEXT,
      sender TEXT NOT NULL,
      receiver TEXT NOT NULL,
      text TEXT DEFAULT '',
      mediaType TEXT DEFAULT 'text',
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
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      deviceName TEXT,
      lastUsed INTEGER NOT NULL,
      firstSeen INTEGER NOT NULL,
      trusted INTEGER DEFAULT 1,
      UNIQUE(username, deviceId)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      deviceId TEXT NOT NULL,
      code TEXT NOT NULL,
      expiresAt INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avatarUrl TEXT DEFAULT '',
      description TEXT DEFAULT '',
      owner TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId INTEGER,
      username TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      joinedAt INTEGER NOT NULL,
      PRIMARY KEY (groupId, username),
      FOREIGN KEY (groupId) REFERENCES groups(id) ON DELETE CASCADE
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_private ON messages(chatType, user1, user2, createdAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(chatType, groupId, createdAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_group_members ON group_members(groupId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_stories_exp ON stories(expiresAt)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_auth_codes ON auth_codes(username, deviceId)`);
});

// ==================== СИСТЕМНЫЙ ПОЛЬЗОВАТЕЛЬ ====================
function ensureSystemUser() {
  const now = Date.now();
  db.get(`SELECT * FROM users WHERE username = ?`, [SYSTEM_USERNAME], (err, user) => {
    if (!user) {
      const hash = bcrypt.hashSync("system", 10);
      db.run(
        `INSERT INTO users (username, passwordHash, displayName, createdAt, lastSeen)
         VALUES (?, ?, ?, ?, ?)`,
        [SYSTEM_USERNAME, hash, "Telegram", now, now]
      );
    }
  });
}
ensureSystemUser();

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================
function now() { return Date.now(); }

function signToken(user, deviceId) {
  return jwt.sign(
    { username: user.username, deviceId },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function verifyAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Нет токена" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    db.get(`SELECT * FROM users WHERE username = ?`, [decoded.username], (err, user) => {
      if (!user) return res.status(401).json({ ok: false, error: "Пользователь не найден" });

      if (Number(user.blockedUntil || 0) > now()) {
        return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
      }

      db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [now(), user.username]);
      if (decoded.deviceId) {
        db.run(
          `UPDATE sessions SET lastUsed=? WHERE username=? AND deviceId=?`,
          [now(), user.username, decoded.deviceId]
        );
      }

      req.user = user;
      req.deviceId = decoded.deviceId;
      next();
    });
  } catch {
    return res.status(401).json({ ok: false, error: "Неверный токен" });
  }
}

function canUser(user, rule) {
  if (Number(user.blockedUntil || 0) > now()) return false;
  if (rule === "text") return Number(user.canSendText) === 1;
  if (rule === "media") return Number(user.canSendMedia) === 1;
  if (rule === "call") return Number(user.canCall) === 1;
  return true;
}

function guessMediaType(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.includes("audio")) return "audio";
  return "file";
}

function safePublicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName || u.username,
    bio: u.bio || "",
    avatarUrl: u.avatarUrl || "",
    birthDate: u.birthDate || "",
    lastSeen: u.lastSeen || 0
  };
}

function cleanupExpiredStories() {
  db.run(`DELETE FROM stories WHERE expiresAt <= ?`, [now()]);
}
setInterval(cleanupExpiredStories, 60 * 1000);

function sendSystemMessage(toUsername, text) {
  const createdAt = now();
  db.run(
    `INSERT INTO messages (chatType, user1, user2, sender, receiver, text, mediaType, mediaUrl, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["private", SYSTEM_USERNAME, toUsername, SYSTEM_USERNAME, toUsername, text, "text", "", createdAt],
    function (err) {
      if (err) console.error("Ошибка отправки системного сообщения:", err);
      else {
        const msg = {
          id: this.lastID,
          chatType: "private",
          sender: SYSTEM_USERNAME,
          receiver: toUsername,
          text,
          mediaType: "text",
          mediaUrl: "",
          createdAt
        };
        broadcastToChat(msg, { type: "message", message: msg });
      }
    }
  );
}

function getDeviceId(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return crypto.createHash('sha256').update(ip + ua).digest('hex');
}

function getDeviceName(req) {
  const ua = req.headers['user-agent'] || 'Unknown';
  return ua.substring(0, 50);
}

// ==================== АУТЕНТИФИКАЦИЯ ====================
app.post("/api/auth/register", async (req, res) => {
  const usernameRaw = String(req.body.username || "").trim();
  const password = String(req.body.password || "").trim();
  const username = usernameRaw.replace(/^@+/, "").toLowerCase();

  if (!/^[a-z0-9_]{4,20}$/.test(username)) {
    return res.status(400).json({ ok: false, error: "Юзернейм 4-20: a-z,0-9,_" });
  }
  if (password.length < 4) {
    return res.status(400).json({ ok: false, error: "Пароль слишком короткий" });
  }

  const hash = await bcrypt.hash(password, 10);
  const createdAt = now();

  db.run(
    `INSERT INTO users (username, passwordHash, displayName, createdAt, lastSeen) VALUES (?,?,?,?,?)`,
    [username, hash, username, createdAt, createdAt],
    function (err) {
      if (err) return res.status(400).json({ ok: false, error: "Юзернейм занят" });

      const deviceId = getDeviceId(req);
      const deviceName = getDeviceName(req);
      db.run(
        `INSERT OR IGNORE INTO sessions (username, deviceId, deviceName, lastUsed, firstSeen, trusted) VALUES (?,?,?,?,?,1)`,
        [username, deviceId, deviceName, createdAt, createdAt]
      );

      db.get(`SELECT * FROM users WHERE username = ?`, [username], (e2, user) => {
        const token = signToken(user, deviceId);
        res.json({ ok: true, token, user: safePublicUser(user) });
      });
    }
  );
});

app.post("/api/auth/login", (req, res) => {
  const identifierRaw = String(req.body.identifier || req.body.username || "").trim();
  const password = String(req.body.password || "").trim();
  const username = identifierRaw.replace(/^@+/, "").toLowerCase();
  const deviceId = getDeviceId(req);
  const deviceName = getDeviceName(req);

  db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
    if (!user) return res.status(400).json({ ok: false, error: "Пользователь не найден" });

    if (Number(user.blockedUntil || 0) > now()) {
      return res.status(403).json({ ok: false, error: "Аккаунт заблокирован" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ ok: false, error: "Неверный пароль" });

    db.get(
      `SELECT * FROM sessions WHERE username = ? AND deviceId = ?`,
      [username, deviceId],
      (err, session) => {
        const nowTime = now();

        if (session && session.trusted === 1) {
          db.run(`UPDATE sessions SET lastUsed=? WHERE id=?`, [nowTime, session.id]);
          db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [nowTime, username]);

          const token = signToken(user, deviceId);
          return res.json({ ok: true, token, user: safePublicUser(user) });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = nowTime + 5 * 60 * 1000;

        db.run(
          `INSERT INTO auth_codes (username, deviceId, code, expiresAt, attempts)
           VALUES (?, ?, ?, ?, 0)
           ON CONFLICT(username, deviceId) DO UPDATE SET code=excluded.code, expiresAt=excluded.expiresAt, attempts=0`,
          [username, deviceId, code, expiresAt]
        );

        db.run(
          `INSERT OR IGNORE INTO sessions (username, deviceId, deviceName, lastUsed, firstSeen, trusted)
           VALUES (?, ?, ?, ?, ?, 0)`,
          [username, deviceId, deviceName, nowTime, nowTime]
        );

        sendSystemMessage(username, `🔐 Код подтверждения: ${code}\nЕсли это не вы, проигнорируйте сообщение.`);

        res.json({
          ok: false,
          requireConfirm: true,
          message: "На ваш аккаунт отправлен код подтверждения. Введите его для завершения входа."
        });
      }
    );
  });
});

app.post("/api/auth/confirm", (req, res) => {
  const { username, code } = req.body;
  const deviceId = getDeviceId(req);

  if (!username || !code) {
    return res.status(400).json({ ok: false, error: "Не указаны имя пользователя или код" });
  }

  db.get(
    `SELECT * FROM auth_codes WHERE username = ? AND deviceId = ?`,
    [username, deviceId],
    (err, authRow) => {
      if (!authRow) {
        return res.status(400).json({ ok: false, error: "Код не найден или истёк" });
      }

      if (authRow.expiresAt < now()) {
        return res.status(400).json({ ok: false, error: "Код истёк. Запросите новый." });
      }

      if (authRow.attempts >= 5) {
        return res.status(400).json({ ok: false, error: "Слишком много попыток. Запросите новый код." });
      }

      if (authRow.code !== code) {
        db.run(`UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?`, [authRow.id]);
        return res.status(400).json({ ok: false, error: "Неверный код" });
      }

      db.run(
        `UPDATE sessions SET trusted = 1, lastUsed = ? WHERE username = ? AND deviceId = ?`,
        [now(), username, deviceId]
      );

      db.run(`DELETE FROM auth_codes WHERE id = ?`, [authRow.id]);

      db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user) return res.status(400).json({ ok: false, error: "Пользователь не найден" });
        const token = signToken(user, deviceId);
        res.json({ ok: true, token, user: safePublicUser(user) });
      });
    }
  );
});

// ==================== ПРОФИЛЬ ====================
app.get("/api/me", verifyAuth, (req, res) => {
  res.json({ ok: true, profile: safePublicUser(req.user) });
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
        res.json({ ok: true, profile: safePublicUser(user) });
      });
    }
  );
});

// Удаление аккаунта
app.delete("/api/me", verifyAuth, (req, res) => {
  const username = req.user.username;

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(`DELETE FROM messages WHERE sender = ? OR receiver = ?`, [username, username]);
    db.run(`DELETE FROM stories WHERE owner = ?`, [username]);
    db.run(`DELETE FROM sessions WHERE username = ?`, [username]);
    db.run(`DELETE FROM auth_codes WHERE username = ?`, [username]);

    db.run(`DELETE FROM users WHERE username = ?`, [username], function(err) {
      if (err) {
        db.run("ROLLBACK");
        return res.status(500).json({ ok: false, error: "Ошибка при удалении аккаунта" });
      }

      db.run("COMMIT", (commitErr) => {
        if (commitErr) {
          return res.status(500).json({ ok: false, error: "Ошибка при завершении удаления" });
        }
        res.json({ ok: true, message: "Аккаунт успешно удалён" });
      });
    });
  });
});

// ==================== ПОИСК ПОЛЬЗОВАТЕЛЕЙ ====================
app.get("/api/users/search", verifyAuth, (req, res) => {
  const q = String(req.query.q || "").trim().replace(/^@+/, "").toLowerCase();
  if (!q) return res.json({ ok: true, users: [] });

  db.all(
    `SELECT username, displayName, bio, avatarUrl, birthDate, lastSeen
     FROM users
     WHERE username LIKE ?
       AND username != ?
     ORDER BY username ASC
     LIMIT 20`,
    [`%${q}%`, req.user.username],
    (err, rows) => res.json({ ok: true, users: rows || [] })
  );
});

app.get("/api/users/:username", verifyAuth, (req, res) => {
  const u = String(req.params.username || "").replace(/^@+/, "").toLowerCase();
  db.get(
    `SELECT username, displayName, bio, avatarUrl, birthDate, lastSeen FROM users WHERE username=?`,
    [u],
    (err, row) => {
      if (!row) return res.status(404).json({ ok: false, error: "Не найден" });
      res.json({ ok: true, user: row });
    }
  );
});

// ==================== СПИСОК ЧАТОВ (личные + группы) ====================
app.get("/api/chats", verifyAuth, (req, res) => {
  const me = req.user.username;

  // Личные чаты
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
    (err, privateRows) => {
      // Группы пользователя
      db.all(
        `SELECT g.*, gm.role FROM groups g
         JOIN group_members gm ON g.id = gm.groupId
         WHERE gm.username = ?
         ORDER BY g.updatedAt DESC`,
        [me],
        (err2, groups) => {
          const result = [];

          // Обработка личных чатов
          const others = (privateRows || []).map(r => r.other).filter(Boolean);
          if (others.length > 0) {
            const placeholders = others.map(() => "?").join(",");
            db.all(
              `SELECT username, displayName, avatarUrl, bio, birthDate, lastSeen FROM users WHERE username IN (${placeholders})`,
              others,
              (e3, users) => {
                const userMap = new Map((users || []).map(u => [u.username, u]));

                db.all(
                  `SELECT id, sender, receiver, text, mediaType, createdAt FROM messages
                   WHERE chatType='private' AND (sender=? OR receiver=?)
                   ORDER BY createdAt DESC LIMIT 200`,
                  [me, me],
                  (e4, msgs) => {
                    const previewMap = new Map();
                    (msgs || []).forEach(m => {
                      const other = m.sender === me ? m.receiver : m.sender;
                      if (!previewMap.has(other)) {
                        previewMap.set(other, {
                          text: m.mediaType !== "text" ? `[${m.mediaType}]` : (m.text || ""),
                          at: m.createdAt
                        });
                      }
                    });

                    others.forEach(o => {
                      const u = userMap.get(o) || { username: o, displayName: o, avatarUrl: "", bio: "", birthDate: "", lastSeen: 0 };
                      const p = previewMap.get(o) || { text: "", at: 0 };
                      result.push({
                        type: 'private',
                        username: u.username,
                        displayName: u.displayName || u.username,
                        avatarUrl: u.avatarUrl || '',
                        bio: u.bio || '',
                        birthDate: u.birthDate || '',
                        lastSeen: u.lastSeen,
                        preview: p.text,
                        lastAt: p.at
                      });
                    });

                    // Добавляем группы
                    groups.forEach(g => {
                      result.push({
                        type: 'group',
                        id: g.id,
                        name: g.name,
                        avatarUrl: g.avatarUrl || '',
                        description: g.description || '',
                        role: g.role,
                        preview: '',
                        lastAt: g.updatedAt
                      });
                    });

                    result.sort((a, b) => b.lastAt - a.lastAt);
                    res.json({ ok: true, chats: result });
                  }
                );
              }
            );
          } else {
            // Только группы
            groups.forEach(g => {
              result.push({
                type: 'group',
                id: g.id,
                name: g.name,
                avatarUrl: g.avatarUrl || '',
                description: g.description || '',
                role: g.role,
                preview: '',
                lastAt: g.updatedAt
              });
            });
            res.json({ ok: true, chats: result });
          }
        }
      );
    }
  );
});

// ==================== СООБЩЕНИЯ ====================
app.get("/api/messages", verifyAuth, (req, res) => {
  const chat = String(req.query.chat || "global");
  const me = req.user.username;

  if (chat === "global") {
    db.all(
      `SELECT * FROM messages WHERE chatType='global' ORDER BY createdAt ASC LIMIT 500`,
      (err, rows) => res.json({ ok: true, messages: rows || [] })
    );
    return;
  }

  if (chat.startsWith("group:")) {
    const groupId = chat.split(":")[1];
    db.get(
      `SELECT * FROM group_members WHERE groupId = ? AND username = ?`,
      [groupId, me],
      (err, member) => {
        if (!member) return res.status(403).json({ ok: false, error: "Вы не участник этой группы" });
        db.all(
          `SELECT * FROM messages WHERE chatType='group' AND groupId = ? ORDER BY createdAt ASC LIMIT 800`,
          [groupId],
          (err2, rows) => res.json({ ok: true, messages: rows || [] })
        );
      }
    );
    return;
  }

  // Личный чат
  const other = chat.replace(/^@+/, "").toLowerCase();
  db.all(
    `
    SELECT * FROM messages
    WHERE chatType='private'
      AND (
        (sender=? AND receiver=?)
        OR
        (sender=? AND receiver=?)
      )
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

      broadcastToChat(row, { type: "messageDeleted", id });
      res.json({ ok: true });
    });
  });
});

// ==================== ЗАГРУЗКА ФАЙЛОВ ====================
app.post("/api/upload", verifyAuth, upload.single("file"), (req, res) => {
  const me = req.user.username;
  if (!canUser(req.user, "media")) return res.status(403).json({ ok: false, error: "Тебе запрещены медиа" });

  const receiver = String(req.body.receiver || "global").replace(/^@+/, "").toLowerCase();
  let chatType, groupId = null;
  if (receiver === "global") {
    chatType = "global";
  } else if (receiver.startsWith("group:")) {
    chatType = "group";
    groupId = receiver.split(":")[1];
    // Проверка членства
    db.get(`SELECT * FROM group_members WHERE groupId = ? AND username = ?`, [groupId, me], (err, member) => {
      if (!member) return res.status(403).json({ ok: false, error: "Вы не участник этой группы" });
      proceed();
    });
    return;
  } else {
    chatType = "private";
  }

  function proceed() {
    const text = String(req.body.text || "").trim().slice(0, 2000);
    if (!req.file) return res.status(400).json({ ok: false, error: "Нет файла" });

    const mediaType = guessMediaType(req.file.mimetype);
    const ext = path.extname(req.file.originalname) || "";
    const newName = `${req.file.filename}${ext}`;
    const newPath = path.join(uploadsDir, newName);

    fs.renameSync(req.file.path, newPath);

    const mediaUrl = `/uploads/${newName}`;
    const createdAt = now();

    const insertParams = [
      chatType,
      groupId,
      chatType === "private" ? me : null,
      chatType === "private" ? receiver : null,
      me,
      receiver === "" ? "global" : receiver,
      text,
      mediaType === "file" ? "text" : mediaType,
      mediaUrl,
      createdAt
    ];

    db.run(
      `INSERT INTO messages (chatType, groupId, user1, user2, sender, receiver, text, mediaType, mediaUrl, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      insertParams,
      function (err) {
        if (err) return res.status(500).json({ ok: false, error: "Ошибка сохранения" });

        const msg = {
          id: this.lastID,
          chatType,
          groupId,
          sender: me,
          receiver: receiver === "" ? "global" : receiver,
          text,
          mediaType: mediaType === "file" ? "text" : mediaType,
          mediaUrl,
          createdAt
        };

        broadcastToChat(msg, { type: "message", message: msg });
        res.json({ ok: true, message: msg });
      }
    );
  }

  proceed();
});

// ==================== СТОРИС ====================
app.get("/api/stories", verifyAuth, (req, res) => {
  cleanupExpiredStories();
  db.all(
    `
    SELECT s.*, u.displayName, u.avatarUrl
    FROM stories s
    LEFT JOIN users u ON u.username = s.owner
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
    const newPath = path.join(uploadsDir, newName);
    fs.renameSync(req.file.path, newPath);
    mediaUrl = `/uploads/${newName}`;
    if (mediaType === "file") mediaType = "text";
  }

  if (!text && !mediaUrl) {
    return res.status(400).json({ ok: false, error: "Сторис пустая" });
  }

  db.run(
    `INSERT INTO stories (owner,text,mediaType,mediaUrl,createdAt,expiresAt) VALUES (?,?,?,?,?,?)`,
    [me, text, mediaType, mediaUrl, createdAt, expiresAt],
    function (err) {
      if (err) return res.status(500).json({ ok: false, error: "Ошибка сторис" });
      res.json({ ok: true, id: this.lastID });
    }
  );
});

// ==================== ДНИ РОЖДЕНИЯ ====================
app.get("/api/birthdays/today", verifyAuth, (req, res) => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  db.all(
    `SELECT username, displayName, avatarUrl, birthDate
     FROM users
     WHERE substr(birthDate, 6, 2) = ? AND substr(birthDate, 9, 2) = ?`,
    [mm, dd],
    (err, rows) => res.json({ ok: true, list: rows || [] })
  );
});

// ==================== ГРУППЫ ====================
app.post("/api/groups", verifyAuth, (req, res) => {
  const { name, description, members } = req.body;
  const owner = req.user.username;
  const nowTime = now();

  if (!name || name.trim().length === 0) {
    return res.status(400).json({ ok: false, error: "Название группы обязательно" });
  }

  db.run(
    `INSERT INTO groups (name, description, owner, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)`,
    [name.trim(), description || '', owner, nowTime, nowTime],
    function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ ok: false, error: "Ошибка создания группы" });
      }
      const groupId = this.lastID;

      db.run(
        `INSERT INTO group_members (groupId, username, role, joinedAt) VALUES (?, ?, ?, ?)`,
        [groupId, owner, 'owner', nowTime],
        (err2) => {
          if (err2) {
            console.error(err2);
            return res.status(500).json({ ok: false, error: "Ошибка добавления владельца" });
          }

          if (!members || members.length === 0) {
            return res.json({ ok: true, groupId });
          }

          let inserted = 0;
          members.forEach(username => {
            if (username === owner) return;
            db.run(
              `INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?, ?, ?, ?)`,
              [groupId, username, 'member', nowTime],
              (err3) => {
                inserted++;
                if (err3) console.error(err3);
                if (inserted === members.length) {
                  res.json({ ok: true, groupId });
                }
              }
            );
          });
        }
      );
    }
  );
});

app.get("/api/groups/:groupId", verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const username = req.user.username;

  db.get(
    `SELECT * FROM group_members WHERE groupId = ? AND username = ?`,
    [groupId, username],
    (err, member) => {
      if (!member) return res.status(403).json({ ok: false, error: "Вы не участник этой группы" });

      db.get(`SELECT * FROM groups WHERE id = ?`, [groupId], (err2, group) => {
        if (!group) return res.status(404).json({ ok: false, error: "Группа не найдена" });

        db.all(
          `SELECT gm.*, u.avatarUrl, u.displayName FROM group_members gm LEFT JOIN users u ON gm.username = u.username WHERE gm.groupId = ?`,
          [groupId],
          (err3, members) => {
            if (err3) return res.status(500).json({ ok: false, error: "Ошибка получения участников" });
            res.json({
              ok: true,
              group: {
                ...group,
                members: members.map(m => ({
                  username: m.username,
                  role: m.role,
                  avatarUrl: m.avatarUrl,
                  displayName: m.displayName || m.username,
                  joinedAt: m.joinedAt
                }))
              }
            });
          }
        );
      });
    }
  );
});

app.put("/api/groups/:groupId", verifyAuth, upload.single("avatar"), (req, res) => {
  const groupId = req.params.groupId;
  const username = req.user.username;
  const { name, description } = req.body;

  db.get(
    `SELECT role FROM group_members WHERE groupId = ? AND username = ?`,
    [groupId, username],
    (err, member) => {
      if (!member || (member.role !== 'admin' && member.role !== 'owner')) {
        return res.status(403).json({ ok: false, error: "Недостаточно прав" });
      }

      let avatarUrl = null;
      if (req.file) {
        const mediaType = guessMediaType(req.file.mimetype);
        if (!mediaType.startsWith('image')) {
          return res.status(400).json({ ok: false, error: "Файл должен быть изображением" });
        }
        const ext = path.extname(req.file.originalname) || "";
        const newName = `group_${groupId}_${req.file.filename}${ext}`;
        const newPath = path.join(uploadsDir, newName);
        fs.renameSync(req.file.path, newPath);
        avatarUrl = `/uploads/${newName}`;
      }

      let query = "UPDATE groups SET updatedAt = ?";
      const params = [now()];
      if (name) {
        query += ", name = ?";
        params.push(name.trim());
      }
      if (description !== undefined) {
        query += ", description = ?";
        params.push(description);
      }
      if (avatarUrl) {
        query += ", avatarUrl = ?";
        params.push(avatarUrl);
      }
      query += " WHERE id = ?";
      params.push(groupId);

      db.run(query, params, function(err2) {
        if (err2) {
          console.error(err2);
          return res.status(500).json({ ok: false, error: "Ошибка обновления" });
        }
        res.json({ ok: true });
      });
    }
  );
});

app.post("/api/groups/:groupId/members", verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const username = req.user.username;
  const { members } = req.body;

  if (!members || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ ok: false, error: "Нет участников для добавления" });
  }

  db.get(
    `SELECT role FROM group_members WHERE groupId = ? AND username = ?`,
    [groupId, username],
    (err, member) => {
      if (!member || (member.role !== 'admin' && member.role !== 'owner')) {
        return res.status(403).json({ ok: false, error: "Недостаточно прав" });
      }

      const nowTime = now();
      let added = 0;
      members.forEach(m => {
        db.run(
          `INSERT OR IGNORE INTO group_members (groupId, username, role, joinedAt) VALUES (?, ?, ?, ?)`,
          [groupId, m, 'member', nowTime],
          (err2) => {
            added++;
            if (err2) console.error(err2);
            if (added === members.length) {
              res.json({ ok: true });
            }
          }
        );
      });
    }
  );
});

app.delete("/api/groups/:groupId/members/:username", verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const targetUsername = req.params.username;
  const currentUsername = req.user.username;

  db.get(
    `SELECT role FROM group_members WHERE groupId = ? AND username = ?`,
    [groupId, currentUsername],
    (err, member) => {
      if (!member || (member.role !== 'admin' && member.role !== 'owner')) {
        return res.status(403).json({ ok: false, error: "Недостаточно прав" });
      }

      db.get(
        `SELECT role FROM group_members WHERE groupId = ? AND username = ?`,
        [groupId, targetUsername],
        (err2, target) => {
          if (!target) return res.status(404).json({ ok: false, error: "Участник не найден" });
          if (target.role === 'owner') {
            return res.status(403).json({ ok: false, error: "Нельзя удалить владельца группы" });
          }

          db.run(
            `DELETE FROM group_members WHERE groupId = ? AND username = ?`,
            [groupId, targetUsername],
            function(err3) {
              if (err3) return res.status(500).json({ ok: false, error: "Ошибка удаления" });
              res.json({ ok: true });
            }
          );
        }
      );
    }
  );
});

app.put("/api/groups/:groupId/members/:username/role", verifyAuth, (req, res) => {
  const groupId = req.params.groupId;
  const targetUsername = req.params.username;
  const currentUsername = req.user.username;
  const { role } = req.body;

  if (role !== 'admin' && role !== 'member') {
    return res.status(400).json({ ok: false, error: "Некорректная роль" });
  }

  db.get(
    `SELECT role FROM group_members WHERE groupId = ? AND username = ?`,
    [groupId, currentUsername],
    (err, member) => {
      if (!member || member.role !== 'owner') {
        return res.status(403).json({ ok: false, error: "Только владелец может назначать администраторов" });
      }

      db.run(
        `UPDATE group_members SET role = ? WHERE groupId = ? AND username = ?`,
        [role, groupId, targetUsername],
        function(err2) {
          if (err2) return res.status(500).json({ ok: false, error: "Ошибка обновления" });
          res.json({ ok: true });
        }
      );
    }
  );
});

// ==================== АДМИН-ПАНЕЛЬ ====================
app.post("/api/admin/login", (req, res) => {
  const user = String(req.body.user || "");
  const pass = String(req.body.pass || "");
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) return res.status(403).json({ ok: false });

  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: "2h" });
  res.json({ ok: true, token });
});

function verifyAdmin(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded.admin) return res.status(403).json({ ok: false });
    next();
  } catch {
    return res.status(401).json({ ok: false });
  }
}

app.get("/api/admin/users", verifyAdmin, (req, res) => {
  db.all(
    `SELECT username, displayName, blockedUntil, canSendText, canSendMedia, canCall FROM users ORDER BY createdAt DESC LIMIT 500`,
    (err, rows) => res.json({ ok: true, users: rows || [] })
  );
});

app.post("/api/admin/user/update", verifyAdmin, (req, res) => {
  const username = String(req.body.username || "").replace(/^@+/, "").toLowerCase();
  const blockedUntil = Number(req.body.blockedUntil || 0);
  const canSendText = req.body.canSendText ? 1 : 0;
  const canSendMedia = req.body.canSendMedia ? 1 : 0;
  const canCall = req.body.canCall ? 1 : 0;

  db.run(
    `UPDATE users SET blockedUntil=?, canSendText=?, canSendMedia=?, canCall=? WHERE username=?`,
    [blockedUntil, canSendText, canSendMedia, canCall, username],
    (err) => {
      if (err) return res.status(500).json({ ok: false });
      res.json({ ok: true });
    }
  );
});

// ==================== WEBSOCKET ====================
const online = new Map();

function wsSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcastToChat(messageRow, payload) {
  if (messageRow.chatType === "global") {
    for (const ws of online.values()) wsSend(ws, payload);
    return;
  }
  if (messageRow.chatType === "group") {
    db.all(`SELECT username FROM group_members WHERE groupId = ?`, [messageRow.groupId], (err, members) => {
      if (err) return;
      members.forEach(m => wsSend(online.get(m.username), payload));
    });
    return;
  }
  // Личный чат
  const a = messageRow.sender;
  const b = messageRow.receiver;
  wsSend(online.get(a), payload);
  wsSend(online.get(b), payload);
}

function broadcastStatus(username, status) {
  const payload = { type: "status", username, status };
  for (const ws of online.values()) wsSend(ws, payload);
}

wss.on("connection", (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token") || "";
    const decoded = jwt.verify(token, JWT_SECRET);
    const username = String(decoded.username || "");

    db.get(`SELECT * FROM users WHERE username=?`, [username], (err, user) => {
      if (!user) return ws.close();

      if (Number(user.blockedUntil || 0) > now()) {
        wsSend(ws, { type: "blocked", until: user.blockedUntil });
        return ws.close();
      }

      db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [now(), username]);
      ws.username = username;
      online.set(username, ws);
      broadcastStatus(username, "online");

      wsSend(ws, { type: "ws-ready", username });

      ws.on("message", (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); } catch { return; }
        if (!data || !data.type) return;

        const from = ws.username;

        // Сигнализация звонков (WebRTC)
        if (data.type === "call-offer" || data.type === "call-answer" || data.type === "ice" || data.type === "call-end") {
          db.get(`SELECT * FROM users WHERE username=?`, [from], (e2, fresh) => {
            if (!fresh || !canUser(fresh, "call")) {
              return wsSend(ws, { type: "call-error", message: "Тебе запрещены звонки" });
            }
            const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
            const target = online.get(to);
            if (!target) {
              return wsSend(ws, { type: "call-error", message: "Пользователь не онлайн" });
            }
            wsSend(target, { ...data, from });
          });
          return;
        }

        // Текстовое сообщение
        if (data.type === "text-message") {
          db.get(`SELECT * FROM users WHERE username=?`, [from], (e2, fresh) => {
            if (!fresh || !canUser(fresh, "text")) {
              return wsSend(ws, { type: "moderation", message: "Тебе запрещены сообщения" });
            }

            const receiver = String(data.receiver || "global").replace(/^@+/, "").toLowerCase();
            let chatType, groupId = null;
            if (receiver === "global") {
              chatType = "global";
            } else if (receiver.startsWith("group:")) {
              chatType = "group";
              groupId = receiver.split(":")[1];
              // Проверка членства
              db.get(`SELECT * FROM group_members WHERE groupId = ? AND username = ?`, [groupId, from], (err3, member) => {
                if (!member) {
                  return wsSend(ws, { type: "moderation", message: "Вы не участник этой группы" });
                }
                proceed();
              });
              return;
            } else {
              chatType = "private";
            }

            function proceed() {
              const text = String(data.text || "").trim().slice(0, 2000);
              if (!text) return;

              const createdAt = now();

              db.run(
                `INSERT INTO messages (chatType, groupId, user1, user2, sender, receiver, text, mediaType, mediaUrl, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  chatType,
                  groupId,
                  chatType === "private" ? from : null,
                  chatType === "private" ? receiver : null,
                  from,
                  receiver === "" ? "global" : receiver,
                  text,
                  "text",
                  "",
                  createdAt
                ],
                function (err) {
                  if (err) return wsSend(ws, { type: "moderation", message: "Ошибка сохранения" });

                  const msg = {
                    id: this.lastID,
                    chatType,
                    groupId,
                    sender: from,
                    receiver: receiver === "" ? "global" : receiver,
                    text,
                    mediaType: "text",
                    mediaUrl: "",
                    createdAt
                  };

                  broadcastToChat(msg, { type: "message", message: msg });
                }
              );
            }

            proceed();
          });
          return;
        }

        // Индикатор печатания
        if (data.type === "typing") {
          const to = String(data.to || "").replace(/^@+/, "").toLowerCase();
          const target = online.get(to);
          if (target) {
            wsSend(target, { type: "typing", from });
          }
        }
      });

      ws.on("close", () => {
        if (ws.username) {
          online.delete(ws.username);
          db.run(`UPDATE users SET lastSeen=? WHERE username=?`, [now(), ws.username]);
          broadcastStatus(ws.username, "offline");
        }
      });
    });
  } catch {
    ws.close();
  }
});

// ==================== ЗАПУСК СЕРВЕРА ====================
server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
