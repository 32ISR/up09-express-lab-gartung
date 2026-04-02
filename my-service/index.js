const express = require("express");
const db = require("./db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
const SECRET = "trtfgdgdgfgddddrrreww"

const PORT = 3000;

// проверка токена
const auth = (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
        return res.status(401).json({ error: "Нет токена" });
    }
    
    try {
        const decoded = jwt.verify(token, SECRET);
        const user = db.prepare("SELECT id, username, email, role FROM users WHERE id = ?").get(decoded.id);
        if (!user) {
            return res.status(401).json({ error: "Пользователь не найден" });
        }
        req.user = user;
        next();
    } catch {
        res.status(403).json({ error: "Токен невалидный" });
    }
};

// проверка роли
const checkRole = (...roles) => {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: "Не авторизован" });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Нет прав" });
        next();
    };
};

// вход
app.post("/api/auth/register", (req, res) => {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
        return res.status(400).json({ error: "Заполните все поля" });
    }
    
    const exists = db.prepare("SELECT id FROM users WHERE username = ? OR email = ?").get(username, email);
    if (exists) {
        return res.status(409).json({ error: "Пользователь уже есть" });
    }
    
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare("INSERT INTO users (username, email, password) VALUES (?, ?, ?)").run(username, email, hash);
    
    const user = db.prepare("SELECT id, username, email, role FROM users WHERE id = ?").get(result.lastInsertRowid);
    const token = jwt.sign({ ...user }, SECRET, { expiresIn: "24h" });
    
    res.status(201).json({ token, user });
});

app.post("/api/auth/login", (req, res) => {
    const { username, password } = req.body;
    
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: "Неверный логин или пароль" });
    }
    
    const { password: _, ...safeUser } = user;
    const token = jwt.sign({ ...safeUser }, SECRET, { expiresIn: "24h" });
    
    res.json({ token, user: safeUser });
});

app.get("/api/auth/profile", auth, (req, res) => {
    res.json(req.user);
});

//книги
app.get("/api/books", (req, res) => {
    const { genre, author } = req.query;
    let sql = "SELECT b.*, u.username as addedBy FROM books b JOIN users u ON b.createdBy = u.id WHERE 1=1";
    const params = [];
    
    if (genre) {
        sql += " AND genre = ?";
        params.push(genre);
    }
    if (author) {
        sql += " AND author LIKE ?";
        params.push(`%${author}%`);
    }
    
    sql += " ORDER BY createdAt DESC";
    const books = db.prepare(sql).all(...params);
    res.json(books);
});

app.get("/api/books/:id", (req, res) => {
    const book = db.prepare(`
        SELECT b.*, u.username as addedBy 
        FROM books b 
        JOIN users u ON b.createdBy = u.id 
        WHERE b.id = ?
    `).get(req.params.id);
    
    if (!book) {
        return res.status(404).json({ error: "Книга не найдена" });
    }
    
    const reviews = db.prepare(`
        SELECT r.*, u.username 
        FROM reviews r 
        JOIN users u ON r.userId = u.id 
        WHERE bookId = ?
        ORDER BY createdAt DESC
    `).all(req.params.id);
    
    book.reviews = reviews;
    res.json(book);
});

app.post("/api/books", auth, (req, res) => {
    const { title, author, year, genre, description } = req.body;
    
    if (!title || !author) {
        return res.status(400).json({ error: "Название и автор обязательны" });
    }
    
    const result = db.prepare(`
        INSERT INTO books (title, author, year, genre, description, createdBy)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, author, year || null, genre || null, description || null, req.user.id);
    
    const book = db.prepare(`
        SELECT b.*, u.username as addedBy 
        FROM books b 
        JOIN users u ON b.createdBy = u.id 
        WHERE b.id = ?
    `).get(result.lastInsertRowid);
    
    res.status(201).json(book);
});

app.put("/api/books/:id", auth, (req, res) => {
    const book = db.prepare("SELECT * FROM books WHERE id = ?").get(req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });
    if (book.createdBy !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ error: "Не ваша книга" });
    }
    
    const { title, author, year, genre, description } = req.body;
    db.prepare(`
        UPDATE books 
        SET title = COALESCE(?, title), 
            author = COALESCE(?, author), 
            year = COALESCE(?, year), 
            genre = COALESCE(?, genre), 
            description = COALESCE(?, description) 
        WHERE id = ?
    `).run(title, author, year, genre, description, req.params.id);
    
    const updated = db.prepare(`
        SELECT b.*, u.username as addedBy 
        FROM books b 
        JOIN users u ON b.createdBy = u.id 
        WHERE b.id = ?
    `).get(req.params.id);
    
    res.json(updated);
});

app.delete("/api/books/:id", auth, (req, res) => {
    const book = db.prepare("SELECT * FROM books WHERE id = ?").get(req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });
    if (book.createdBy !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ error: "Не ваша книга" });
    }
    
    db.prepare("DELETE FROM books WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// отзывы
app.post("/api/books/:id/reviews", auth, (req, res) => {
    const { rating, comment } = req.body;
    
    const book = db.prepare("SELECT id FROM books WHERE id = ?").get(req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });
    if (!rating || rating < 1 || rating > 5 || !comment) {
        return res.status(400).json({ error: "Рейтинг от 1 до 5 и комментарий обязательны" });
    }
    
    const result = db.prepare(`
        INSERT INTO reviews (bookId, userId, rating, comment) 
        VALUES (?, ?, ?, ?)
    `).run(req.params.id, req.user.id, rating, comment);
    
    const review = db.prepare(`
        SELECT r.*, u.username 
        FROM reviews r 
        JOIN users u ON r.userId = u.id 
        WHERE r.id = ?
    `).get(result.lastInsertRowid);
    
    res.status(201).json(review);
});

app.get("/api/books/:id/reviews", (req, res) => {
    const reviews = db.prepare(`
        SELECT r.*, u.username 
        FROM reviews r 
        JOIN users u ON r.userId = u.id 
        WHERE bookId = ?
        ORDER BY createdAt DESC
    `).all(req.params.id);
    
    res.json(reviews);
});

app.delete("/api/reviews/:id", auth, (req, res) => {
    const review = db.prepare("SELECT * FROM reviews WHERE id = ?").get(req.params.id);
    if (!review) return res.status(404).json({ error: "Отзыв не найден" });
    if (review.userId !== req.user.id && req.user.role !== "admin") {
        return res.status(403).json({ error: "Не ваш отзыв" });
    }
    
    db.prepare("DELETE FROM reviews WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// админе
app.get("/api/admin/users", auth, checkRole("admin"), (req, res) => {
    const users = db.prepare("SELECT id, username, email, role, createdAt FROM users ORDER BY createdAt DESC").all();
    res.json(users);
});

app.delete("/api/admin/users/:id", auth, checkRole("admin"), (req, res) => {
    if (parseInt(req.params.id) === req.user.id) {
        return res.status(400).json({ error: "Нельзя удалить себя" });
    }
    
    db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

app.get("/", (req, res) => {
    res.json({ message: "Book API работает" });
});

app.listen(PORT, () => {
    console.log(`Сервер на http://localhost:${PORT}`);
});