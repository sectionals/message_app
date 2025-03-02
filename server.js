require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');

// Multer config (image uploads => /uploads folder)
const upload = multer({ dest: 'uploads/' });

const app = express();
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true
}));

// Serve images & static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname)));

// Session config
app.use(session({
  secret: 'supersecretkey',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set to true if using HTTPS
}));

// Create HTTP server & attach Socket.IO
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

// SQLite init
const db = new sqlite3.Database('./messages.db', (err) => {
  if (err) console.error("❌ DB Error:", err);
  else console.log("✅ Connected to SQLite Database");
});

/* -----------------------------------------
   CREATE TABLES IF NOT EXISTS
----------------------------------------- */

// Basic user table
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    isAdmin INTEGER DEFAULT 0,
    bio TEXT,
    location TEXT,
    profileImage TEXT,
    bannerImage TEXT,
    theme TEXT DEFAULT 'default',
    xp INTEGER DEFAULT 0
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    message TEXT NOT NULL,
    image TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    sharedPostId TEXT
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS likes (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    userId TEXT NOT NULL
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS follows (
    id TEXT PRIMARY KEY,
    followerId TEXT NOT NULL,
    followingId TEXT NOT NULL
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    userId TEXT NOT NULL,
    comment TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS dms (
    id TEXT PRIMARY KEY,
    senderId TEXT NOT NULL,
    receiverId TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    isRead INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Group chat
db.run(`
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    groupName TEXT NOT NULL,
    creatorId TEXT NOT NULL
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS group_members (
    id TEXT PRIMARY KEY,
    groupId TEXT NOT NULL,
    userId TEXT NOT NULL
)`);
db.run(`
  CREATE TABLE IF NOT EXISTS group_messages (
    id TEXT PRIMARY KEY,
    groupId TEXT NOT NULL,
    userId TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Ephemeral stories
db.run(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    expiresAt DATETIME
)`);

// Hashtags
db.run(`
  CREATE TABLE IF NOT EXISTS hashtags (
    id TEXT PRIMARY KEY,
    hashtag TEXT NOT NULL,
    postId TEXT NOT NULL
)`);

// Password reset
db.run(`
  CREATE TABLE IF NOT EXISTS passwordResets (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    token TEXT NOT NULL,
    expiresAt DATETIME
)`);

// Badges
db.run(`
  CREATE TABLE IF NOT EXISTS badges (
    id TEXT PRIMARY KEY,
    userId TEXT NOT NULL,
    badgeName TEXT NOT NULL,
    awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// Voice channels
db.run(`
  CREATE TABLE IF NOT EXISTS voiceChannels (
    id TEXT PRIMARY KEY,
    channelName TEXT NOT NULL,
    creatorId TEXT NOT NULL
)`);

/* -----------------------------------------
   SOCKET.IO
----------------------------------------- */
io.on('connection', (socket) => {
  console.log("🔌 A user connected");
  socket.on('joinGroup', (groupId) => {
    socket.join(groupId);
    console.log(`Socket joined group: ${groupId}`);
  });
  socket.on('disconnect', () => {
    console.log("🔌 A user disconnected");
  });
});

// Helper to broadcast notifications
function sendNotification(userId, data) {
  io.emit('notification', { userId, ...data });
}

/* -----------------------------------------
   BASIC ROUTES (Multi-Page)
----------------------------------------- */
app.get('/', (req, res) => {
  res.redirect('/login');
});
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/feed');
  res.sendFile(path.join(__dirname, 'login.html'));
});
app.get('/feed', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'feed.html'));
});
app.get('/dms', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'dms.html'));
});
app.get('/voice', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'voice.html'));
});
app.get('/profile', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'profile.html'));
});

/* -----------------------------------------
   AUTH
----------------------------------------- */
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  res.json(req.session.user);
});

app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username/password required" });
  try {
    const hashed = await bcrypt.hash(password, 10);
    db.run("INSERT INTO users (id, username, password) VALUES (?, ?, ?)",
      [uuidv4(), username, hashed],
      (err) => {
        if (err) return res.status(400).json({ error: "Username already exists" });
        res.status(201).json({ message: "User created successfully" });
      }
    );
  } catch (err) {
    res.status(500).json({ error: "Error creating user" });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err || !user) return res.status(400).json({ error: "Invalid user/pass" });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: "Invalid user/pass" });
    req.session.user = user;
    res.json({ message: "Login success", user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ message: "Logged out" });
});

/* -----------------------------------------
   EXAMPLE DMS ROUTE (FIX for "Load DMs")
----------------------------------------- */
app.get('/api/dms', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not logged in" });
  }
  const userId = req.session.user.id;
  db.all(`
    SELECT d.*, s.username as senderName, r.username as receiverName
    FROM dms d
    JOIN users s ON d.senderId = s.id
    JOIN users r ON d.receiverId = r.id
    WHERE d.senderId = ? OR d.receiverId = ?
    ORDER BY d.timestamp ASC
  `, [userId, userId], (err, rows) => {
    if (err) {
      console.error("Error fetching DMs:", err);
      return res.status(500).json({ error: "Failed to fetch DMs." });
    }
    // If no DMs, return empty array
    res.json(rows);
  });
});

/* -----------------------------------------
   ... PASTE YOUR OTHER ROUTES ...
   (posts, likes, ephemeral stories, hashtags, search, theming, admin, password resets, etc.)
----------------------------------------- */

// Example: ephemeral stories GET
app.get('/api/stories', (req, res) => {
  // Return all unexpired stories
  const now = new Date().toISOString();
  db.all(`
    SELECT s.*, u.username
    FROM stories s
    JOIN users u ON s.userId = u.id
    WHERE s.expiresAt > ?
  `, [now], (err, rows) => {
    if (err) return res.status(500).json({ error: "Failed to fetch stories" });
    res.json(rows);
  });
});

/* -----------------------------------------
   PROFILE (Advanced)
----------------------------------------- */
app.post('/api/profile', upload.single('profileImage'), (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Not logged in" });
  const userId = req.session.user.id;
  const { bio, location } = req.body;
  let imagePath = null;
  if (req.file) imagePath = req.file.path;

  db.run(`
    UPDATE users
    SET bio = COALESCE(?, bio),
        location = COALESCE(?, location),
        profileImage = COALESCE(?, profileImage)
    WHERE id = ?
  `, [bio, location, imagePath, userId], (err) => {
    if (err) return res.status(500).json({ error: "Failed to update profile" });
    res.json({ message: "Profile updated" });
  });
});

app.get('/api/users/:id', (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM users WHERE id = ?`, [id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: "User not found" });
    db.all(`SELECT * FROM posts WHERE username = ? ORDER BY timestamp DESC`, [user.username], (err2, posts) => {
      if (err2) return res.status(500).json({ error: "Failed to fetch user posts" });
      res.json({ user, posts });
    });
  });
});

/* -----------------------------------------
   START SERVER
----------------------------------------- */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}\n`);
});
