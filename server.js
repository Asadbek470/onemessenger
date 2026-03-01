const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const db = new sqlite3.Database('messenger.db');

const upload = multer({ dest: 'public/uploads/' });

db.serialize(() => {
    // Таблица пользователей с паролем и профилем
    db.run(`CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY, 
        password TEXT, 
        displayName TEXT, 
        avatar TEXT, 
        bio TEXT)`);
    
    // Таблица сообщений с поддержкой лички и медиа
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        receiver TEXT,
        text TEXT,
        fileUrl TEXT,
        type TEXT, /* text, image, video_note, audio */
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Поиск пользователей (для лички)
app.get('/api/search', (req, res) => {
    const q = req.query.username;
    db.all("SELECT username, displayName, avatar FROM users WHERE username LIKE ?", [`%${q}%`], (err, rows) => {
        res.json(rows);
    });
});

// Регистрация / Двухфакторка (пароль)
app.post('/api/auth', async (req, res) => {
    const { username, password, type } = req.body;
    if (type === 'reg') {
        const hash = await bcrypt.hash(password, 10);
        db.run("INSERT INTO users (username, password, displayName) VALUES (?, ?, ?)", [username, hash, username], (err) => {
            if (err) return res.status(400).json({error: "Занят"});
            res.json({success: true});
        });
    } else {
        db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
            if (user && await bcrypt.compare(password, user.password)) {
                res.json({success: true, user});
            } else res.status(401).json({error: "Ошибка"});
        });
    }
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        const data = JSON.parse(raw);
        const stmt = db.prepare("INSERT INTO messages (sender, receiver, text, fileUrl, type) VALUES (?, ?, ?, ?, ?)");
        stmt.run(data.sender, data.receiver, data.text, data.fileUrl, data.type);
        wss.clients.forEach(c => c.send(JSON.stringify(data)));
    });
});

server.listen(process.env.PORT || 3000);
