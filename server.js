const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const http = require("http");
const WebSocket = require("ws");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcrypt");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static("public"));

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

// ВАЖНО: раздаём uploads как статику
app.use("/uploads", express.static("uploads"));

const upload = multer({ dest: "uploads/" });
const db = new sqlite3.Database("./database.db");

function normUser(u = "") {
  return String(u).trim().replace(/^@+/, "").toLowerCase();
}

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    pinHash TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS profiles (
    username TEXT PRIMARY KEY,
    displayName TEXT,
    bio TEXT,
    avatar TEXT,
    phone TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    text TEXT,
    mediaUrl TEXT,
    mediaType TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS stories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT,
    mediaUrl TEXT,
    mediaType TEXT,
    text TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

const clients = new Map();

/* ================= AUTH (username + 6-digit pin) ================= */

app.post("/api/auth/reg", async (req, res) => {
  const username = normUser(req.body.username);
  const pin = String(req.body.pin || "").trim();

  if (!username || !/^\d{6}$/.test(pin)) {
    return res.json({ success: false, error: "Нужен username и 6-значный код." });
  }

  const pinHash = await bcrypt.hash(pin, 10);

  db.run("INSERT INTO users (username, pinHash) VALUES (?,?)", [username, pinHash], err => {
    if (err) return res.json({ success: false, error: "Такой юзер уже существует." });

    db.run(
      "INSERT INTO profiles (username, displayName, bio, avatar, phone) VALUES (?,?,?,?,?)",
      [username, username, "", "", ""]
    );

    res.json({ success: true });
  });
});

app.post("/api/auth/login", (req, res) => {
  const username = normUser(req.body.username);
  const pin = String(req.body.pin || "").trim();

  if (!username || !/^\d{6}$/.test(pin)) {
    return res.json({ success: false, error: "Нужен username и 6-значный код." });
  }

  db.get("SELECT * FROM users WHERE username=?", [username], async (err, row) => {
    if (!row) return res.json({ success: false, error: "Неверный логин или код." });

    const ok = await bcrypt.compare(pin, row.pinHash);
    if (!ok) return res.json({ success: false, error: "Неверный логин или код." });

    res.json({ success: true });
  });
});

/* ================= SEARCH (username + phone) ================= */

app.get("/api/search", (req, res) => {
  const q = "%" + String(req.query.q || "").trim() + "%";
  db.all(
    "SELECT username, displayName, phone FROM profiles WHERE username LIKE ? OR phone LIKE ? LIMIT 30",
    [q, q],
    (err, rows) => res.json(rows || [])
  );
});

/* ================= CHATS LIST ================= */
app.get("/api/chats", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  if (!user) return res.json([]);

  db.all(
    `
    SELECT
      CASE
        WHEN sender = ? THEN receiver
        ELSE sender
      END AS chatWith,
      MAX(id) AS lastId
    FROM messages
    WHERE receiver != 'global' AND (sender = ? OR receiver = ?)
    GROUP BY chatWith
    ORDER BY lastId DESC
    `,
    [user, user, user],
    (err, rows) => res.json(rows || [])
  );
});

/* ================= MESSAGES ================= */

app.get("/api/messages", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const chat = normUser(req.query.chat || "");

  if (req.query.chat === "global") {
    db.all("SELECT * FROM messages WHERE receiver='global' ORDER BY id ASC", (err, rows) => {
      res.json(rows || []);
    });
  } else {
    db.all(
      `SELECT * FROM messages WHERE 
        (sender=? AND receiver=?) OR 
        (sender=? AND receiver=?)
       ORDER BY id ASC`,
      [user, chat, chat, user],
      (err, rows) => res.json(rows || [])
    );
  }
});

app.delete("/api/messages/:id", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");

  // Безопасность: удалять может только отправитель
  db.get("SELECT * FROM messages WHERE id=?", [req.params.id], (err, row) => {
    if (!row) return res.json({ success: false });
    if (row.sender !== user) return res.status(403).json({ success: false });

    db.run("DELETE FROM messages WHERE id=?", [req.params.id], () => {
      // уведомим всех (или хотя бы участников)
      broadcast({ type: "messageDeleted", id: Number(req.params.id) });
      res.json({ success: true });
    });
  });
});

/* ================= UPLOAD ================= */

app.post("/api/upload", upload.single("file"), (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const receiverRaw = String(req.body.receiver || "global");
  const receiver = receiverRaw === "global" ? "global" : normUser(receiverRaw);

  const file = req.file;
  if (!file) return res.json({ success: false, error: "Нет файла." });

  const ext = path.extname(file.originalname);
  const filename = file.filename + ext;
  const diskPath = path.join("uploads", filename);
  fs.renameSync(file.path, diskPath);

  let mediaType = "image";
  if (file.mimetype.startsWith("video")) mediaType = "video";
  if (file.mimetype.startsWith("audio")) mediaType = "audio";

  const mediaUrl = "/uploads/" + filename;

  db.run(
    "INSERT INTO messages (sender,receiver,text,mediaUrl,mediaType) VALUES (?,?,?,?,?)",
    [user, receiver, "", mediaUrl, mediaType],
    function () {
      const msg = {
        type: "message",
        id: this.lastID,
        sender: user,
        receiver,
        text: "",
        mediaUrl,
        mediaType
      };
      deliverMessage(msg);
      res.json({ success: true });
    }
  );
});

/* ================= PROFILE ================= */

app.get("/api/me", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  db.get("SELECT * FROM profiles WHERE username=?", [user], (err, row) => {
    res.json({ success: true, profile: row });
  });
});

app.post("/api/me", (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const displayName = String(req.body.displayName || "").slice(0, 40);
  const bio = String(req.body.bio || "").slice(0, 160);
  const phone = String(req.body.phone || "").slice(0, 30);

  db.run(
    "UPDATE profiles SET displayName=?, bio=?, phone=? WHERE username=?",
    [displayName, bio, phone, user],
    () => res.json({ success: true })
  );
});

/* ================= STORIES ================= */

app.get("/api/stories", (req, res) => {
  db.all("SELECT * FROM stories ORDER BY id DESC LIMIT 50", (err, rows) => {
    res.json(rows || []);
  });
});

app.post("/api/stories", upload.single("story"), (req, res) => {
  const user = normUser(req.headers["x-user"] || "");
  const text = String(req.body.text || "").slice(0, 120);

  let mediaUrl = "";
  let mediaType = "";

  if (req.file) {
    const ext = path.extname(req.file.originalname);
    const filename = req.file.filename + ext;
    const diskPath = path.join("uploads", filename);
    fs.renameSync(req.file.path, diskPath);

    mediaUrl = "/uploads/" + filename;
    mediaType = req.file.mimetype.startsWith("video") ? "video" : "image";
  }

  db.run(
    "INSERT INTO stories (owner,mediaUrl,mediaType,text) VALUES (?,?,?,?)",
    [user, mediaUrl, mediaType, text],
    () => res.json({ success: true })
  );
});

/* ================= WEBSOCKET ================= */

function safeSend(ws, data) {
  try { ws.send(JSON.stringify(data)); } catch {}
}

function broadcast(data) {
  for (const ws of clients.values()) safeSend(ws, data);
}

function deliverMessage(msg) {
  // global -> всем
  if (msg.receiver === "global") {
    broadcast(msg);
    return;
  }

  // личка -> обоим участникам
  const a = clients.get(msg.receiver);
  const b = clients.get(msg.sender);
  if (a) safeSend(a, msg);
  if (b) safeSend(b, msg);
}

wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url.replace("/?", ""));
  const user = normUser(params.get("user") || "");
  if (user) clients.set(user, ws);

  ws.on("message", (message) => {
    const data = JSON.parse(message);

    if (data.type === "text") {
      const sender = normUser(data.sender);
      const receiverRaw = String(data.receiver || "global");
      const receiver = receiverRaw === "global" ? "global" : normUser(receiverRaw);
      const text = String(data.text || "").slice(0, 4000);

      db.run(
        "INSERT INTO messages (sender,receiver,text) VALUES (?,?,?)",
        [sender, receiver, text],
        function () {
          const msg = {
            type: "message",
            id: this.lastID,
            sender,
            receiver,
            text,
            mediaUrl: "",
            mediaType: ""
          };
          deliverMessage(msg);
        }
      );
    }

    if (
      data.type === "call-offer" ||
      data.type === "call-answer" ||
      data.type === "ice-candidate" ||
      data.type === "call-end"
    ) {
      const to = normUser(data.to || "");
      const target = clients.get(to);
      if (target) safeSend(target, data);
    }
  });

  ws.on("close", () => {
    if (user) clients.delete(user);
  });
});

server.listen(3000, () => console.log("Server running on port 3000"));
