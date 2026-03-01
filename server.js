const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const multer = require('multer');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const db = new sqlite3.Database('messenger.db');

app.use(express.json());
app.use(express.static('public'));

const upload = multer({ dest: 'public/uploads/' });

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, bio TEXT, avatar TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS messages (sender TEXT, receiver TEXT, text TEXT, fileUrl TEXT, type TEXT)");
});

// Роуты авторизации
app.post('/api/auth/reg', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [req.body.username, hash], (err) => {
        if (err) return res.status(400).json({ error: "Юзер уже есть" });
        res.json({ success: true });
    });
});

app.post('/api/auth/login', (req, res) => {
    db.get("SELECT * FROM users WHERE username = ?", [req.body.username], async (err, user) => {
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            res.json({ success: true });
        } else res.status(401).json({ error: "Неверный пароль" });
    });
});

// Поиск
app.get('/api/search', (req, res) => {
    db.all("SELECT username FROM users WHERE username LIKE ?", [`%${req.query.q}%`], (err, rows) => {
        res.json(rows);
    });
});

server.listen(process.env.PORT || 3000);
