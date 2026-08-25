const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8443;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

// ============== ПОДКЛЮЧЕНИЕ К БАЗЕ ==============
const db = new sqlite3.Database('./data/miligram.db');

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      avatar TEXT,
      status TEXT DEFAULT 'offline',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      from_user TEXT,
      to_user TEXT,
      text TEXT,
      media_url TEXT,
      delivered BOOLEAN DEFAULT 0,
      read BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS chats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT DEFAULT 'private',
      name TEXT,
      participants TEXT
    )
  `);
});

// ============== МИДЛВЭРЫ ==============
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ============== АВТОРИЗАЦИЯ ==============
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Все поля обязательны' });

  const hashed = await bcrypt.hash(password, 10);
  db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashed], function(err) {
    if (err) return res.status(400).json({ error: 'Пользователь уже существует' });
    res.json({ success: true });
  });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
    if (!user) return res.status(401).json({ error: 'Неверные данные' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Неверные данные' });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    db.run('UPDATE users SET status = "online" WHERE username = ?', [username]);
    res.json({ success: true, token, username: user.username });
  });
});

app.post('/logout', (req, res) => {
  const { username } = req.body;
  db.run('UPDATE users SET status = "offline" WHERE username = ?', [username]);
  res.json({ success: true });
});

// ============== ПОЛЬЗОВАТЕЛИ ==============
app.get('/users', (req, res) => {
  db.all('SELECT username, avatar, status FROM users', (err, rows) => {
    res.json(rows);
  });
});

// ============== СООБЩЕНИЯ ==============
app.post('/send', (req, res) => {
  const { chat_id, from_user, to_user, text, media_url } = req.body;
  db.run(
    'INSERT INTO messages (chat_id, from_user, to_user, text, media_url, delivered, read) VALUES (?, ?, ?, ?, ?, 0, 0)',
    [chat_id, from_user, to_user, text, media_url],
    function(err) {
      if (err) return res.status(500).json({ error: 'Ошибка сохранения' });
      res.json({ success: true, message_id: this.lastID });
    }
  );
});

app.get('/messages/:chatId', (req, res) => {
  const chatId = req.params.chatId;
  db.all('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC', [chatId], (err, rows) => {
    res.json(rows);
  });
});

app.post('/mark-delivered', (req, res) => {
  const { chat_id, username } = req.body;
  db.run(
    'UPDATE messages SET delivered = 1 WHERE chat_id = ? AND to_user = ?',
    [chat_id, username]
  );
  res.json({ success: true });
});

app.get('/unread/:username', (req, res) => {
  const username = req.params.username;
  db.all('SELECT * FROM messages WHERE to_user = ? AND delivered = 0', [username], (err, rows) => {
    res.json(rows);
  });
});

// ============== ЗАГРУЗКА МЕДИА ==============
const storage = multer.diskStorage({
  destination: './data/uploads',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage });

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нет файла' });
  res.json({
    success: true,
    url: `/uploads/${req.file.filename}`
  });
});

app.use('/uploads', express.static('data/uploads'));

// ============== WEB SOCKET (мгновенная доставка) ==============
const wss = new WebSocket.Server({ port: 8081 });

const clients = new Map();

wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'login') {
        username = msg.username;
        clients.set(username, ws);
      }

      if (msg.type === 'message') {
        const receiver = clients.get(msg.to_user);
        if (receiver) {
          receiver.send(JSON.stringify({
            type: 'message',
            from: username,
            text: msg.text,
            time: new Date()
          }));
        }
      }
    } catch (e) {
      console.error('WebSocket error:', e);
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(username);
      db.run('UPDATE users SET status = "offline" WHERE username = ?', [username]);
    }
  });
});

// ============== ЗАПУСК ==============
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Miligram Messenger запущен на порту ${PORT}`);
  console.log(`✅ WebSocket запущен на порту 8081`);
});
