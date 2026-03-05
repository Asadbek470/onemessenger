const sqlite3 = require("sqlite3").verbose()

const db = new sqlite3.Database("database.db")

function init(){

db.run(`
CREATE TABLE IF NOT EXISTS users(
id INTEGER PRIMARY KEY,
username TEXT UNIQUE,
passwordHash TEXT,
createdAt TEXT
)
`)

db.run(`
CREATE TABLE IF NOT EXISTS messages(
id INTEGER PRIMARY KEY,
sender TEXT,
receiver TEXT,
text TEXT,
createdAt TEXT
)
`)

db.run(`
CREATE TABLE IF NOT EXISTS sessions(
id INTEGER PRIMARY KEY,
username TEXT,
device TEXT,
createdAt TEXT
)
`)

db.run(`
CREATE TABLE IF NOT EXISTS blocked_users(
blocker TEXT,
blocked TEXT
)
`)

}

init()

module.exports = db
