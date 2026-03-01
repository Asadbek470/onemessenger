const express = require('express');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const db = new Database('messenger.db');

// Инициализация базы данных
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    displayName TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    text TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API для загрузки истории
app.get('/api/messages', (req, res) => {
    const rows = db.prepare('SELECT * FROM messages ORDER BY timestamp ASC').all();
    res.json(rows);
});

// WebSocket логика
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            if (data.type === 'chat') {
                const stmt = db.prepare('INSERT INTO messages (sender, text) VALUES (?, ?)');
                stmt.run(data.sender, data.text);
                
                // Рассылка всем
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify(data));
                    }
                });
            }
        } catch (e) { console.error("WS Error:", e); }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server active on port ${PORT}`));
