const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const JWT_SECRET = process.env.JWT_SECRET || "one_messenger_secret";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

app.use("/uploads", express.static("uploads"));
app.use("/", express.static("public"));

const upload = multer({ dest: "uploads/" });

const db = new sqlite3.Database("database.db");

const online = new Map();

function now() {
  return new Date().toISOString();
}

function ok(res, data = {}) {
  res.json({ ok: true, ...data });
}

function fail(res, msg) {
  res.json({ ok: false, error: msg });
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return fail(res, "No token");
  try {
    const data = jwt.verify(token, JWT_SECRET);
    req.user = data.username;
    next();
  } catch {
    return fail(res, "Invalid token");
  }
}

function sendTo(username, data) {
  const ws = online.get(username);
  if (ws) ws.send(JSON.stringify(data));
}

function createTables() {

db.run(`CREATE TABLE IF NOT EXISTS users(
id INTEGER PRIMARY KEY,
username TEXT UNIQUE,
passwordHash TEXT,
displayName TEXT,
bio TEXT,
avatarUrl TEXT,
createdAt TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS messages(
id INTEGER PRIMARY KEY,
sender TEXT,
receiver TEXT,
text TEXT,
media TEXT,
reactions TEXT,
edited INTEGER DEFAULT 0,
pinned INTEGER DEFAULT 0,
createdAt TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS auth_codes(
id INTEGER PRIMARY KEY,
username TEXT,
code TEXT,
expires INTEGER
)`);

db.run(`CREATE TABLE IF NOT EXISTS sessions(
id INTEGER PRIMARY KEY,
username TEXT,
device TEXT,
createdAt TEXT
)`);

}

createTables();

function assistant(username, text) {
  db.run(
    `INSERT INTO messages(sender,receiver,text,createdAt)
     VALUES(?,?,?,?)`,
    ["one_assistant", username, text, now()]
  );
  sendTo(username, {
    type: "message",
    sender: "One Messenger Assistant",
    text
  });
}

function code() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

app.post("/api/auth/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) return fail(res, "Missing fields");

  const hash = await bcrypt.hash(password, 10);

  db.run(
    `INSERT INTO users(username,passwordHash,createdAt)
     VALUES(?,?,?)`,
    [username, hash, now()],
    err => {
      if (err) return fail(res, "Username exists");
      ok(res);
    }
  );
});

app.post("/api/auth/login", async (req, res) => {

  const { username, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE username=?`,
    [username],
    async (err, user) => {

      if (!user) return fail(res, "User not found");

      const valid = await bcrypt.compare(password, user.passwordHash);

      if (!valid) return fail(res, "Wrong password");

      const c = code();

      db.run(
        `INSERT INTO auth_codes(username,code,expires)
         VALUES(?,?,?)`,
        [username, c, Date.now() + 300000]
      );

      assistant(username, "🔐 Login code: " + c);

      ok(res, { confirm: true });

    }
  );

});

app.post("/api/auth/confirm", (req, res) => {

  const { username, code } = req.body;

  db.get(
    `SELECT * FROM auth_codes WHERE username=? ORDER BY id DESC`,
    [username],
    (err, row) => {

      if (!row) return fail(res, "No code");

      if (row.code !== code) return fail(res, "Wrong code");

      const token = jwt.sign({ username }, JWT_SECRET);

      db.run(
        `INSERT INTO sessions(username,device,createdAt)
         VALUES(?,?,?)`,
        [username, "web", now()]
      );

      ok(res, { token });

    }
  );

});

app.get("/api/messages", auth, (req, res) => {

  db.all(
    `SELECT * FROM messages ORDER BY createdAt`,
    [],
    (err, rows) => {
      ok(res, { messages: rows });
    }
  );

});

app.post("/api/messages/send", auth, (req, res) => {

  const { text, to } = req.body;

  const msg = {
    sender: req.user,
    receiver: to || "global",
    text,
    createdAt: now()
  };

  db.run(
    `INSERT INTO messages(sender,receiver,text,createdAt)
     VALUES(?,?,?,?)`,
    [msg.sender, msg.receiver, msg.text, msg.createdAt]
  );

  wss.clients.forEach(c => {
    if (c.readyState === 1)
      c.send(JSON.stringify({ type: "message", message: msg }));
  });

  ok(res);

});

app.post("/api/messages/react", auth, (req, res) => {

  const { id, emoji } = req.body;

  db.get(
    `SELECT reactions FROM messages WHERE id=?`,
    [id],
    (err, row) => {

      let r = {};

      if (row?.reactions) r = JSON.parse(row.reactions);

      r[emoji] = (r[emoji] || 0) + 1;

      db.run(
        `UPDATE messages SET reactions=? WHERE id=?`,
        [JSON.stringify(r), id]
      );

      ok(res);

    }
  );

});

app.post("/api/messages/edit", auth, (req, res) => {

  const { id, text } = req.body;

  db.run(
    `UPDATE messages SET text=?,edited=1 WHERE id=?`,
    [text, id]
  );

  ok(res);

});

app.post("/api/messages/pin", auth, (req, res) => {

  const { id } = req.body;

  db.run(
    `UPDATE messages SET pinned=1 WHERE id=?`,
    [id]
  );

  ok(res);

});

app.post("/api/upload", auth, upload.single("file"), (req, res) => {

  const f = req.file;

  ok(res, {
    url: "/uploads/" + f.filename
  });

});

wss.on("connection", ws => {

  ws.on("message", raw => {

    const data = JSON.parse(raw);

    if (data.type === "auth") {
      try {
        const user = jwt.verify(data.token, JWT_SECRET).username;
        online.set(user, ws);
      } catch {}
    }

    if (data.type === "typing") {
      sendTo(data.to, {
        type: "typing",
        user: data.user
      });
    }

  });

  ws.on("close", () => {
    online.forEach((v, k) => {
      if (v === ws) online.delete(k);
    });
  });

});

server.listen(PORT, HOST, () => {
  console.log("One Messenger server running on", PORT);
});
