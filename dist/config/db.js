"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = query;
const pg_1 = require("pg");
const sqlite3_1 = __importDefault(require("sqlite3"));
const path_1 = __importDefault(require("path"));
const dotenv_1 = __importDefault(require("dotenv"));
const uuid_1 = require("uuid");
dotenv_1.default.config();
let isPostgresAvailable = false;
let pgPool = null;
let sqliteDb = null;
const dbFilePath = path_1.default.join(__dirname, '../../matchmaker.sqlite');
async function initPostgresSchema() {
    if (!pgPool)
        return;
    console.log('🗄️ Database: Initializing PostgreSQL database schema...');
    try {
        await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        app_id TEXT UNIQUE NOT NULL,
        age INTEGER NOT NULL CHECK (age >= 18),
        gender TEXT NOT NULL,
        total_stars INTEGER NOT NULL DEFAULT 5,
        total_ratings INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_one TEXT NOT NULL,
        user_two TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_one, user_two)
      );

      CREATE TABLE IF NOT EXISTS persistent_messages (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        message_text TEXT,
        media_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS permanent_blocks (
        id TEXT PRIMARY KEY,
        blocker_id TEXT NOT NULL,
        blocked_id TEXT NOT NULL,
        blocked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blocker_id, blocked_id)
      );

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL,
        reported_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        snapshot_payload TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
        console.log('🗄️ PostgreSQL schema initialized successfully.');
    }
    catch (err) {
        console.error('Failed to initialize PostgreSQL schema:', err);
    }
}
function initSqliteSchema() {
    if (!sqliteDb)
        return;
    console.log('🗄️ Database: Initializing local SQLite database schema...');
    sqliteDb.serialize(() => {
        sqliteDb?.run(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        app_id TEXT UNIQUE NOT NULL,
        age INTEGER NOT NULL CHECK (age >= 18),
        gender TEXT NOT NULL,
        total_stars INTEGER NOT NULL DEFAULT 5,
        total_ratings INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
        sqliteDb?.run(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_one TEXT NOT NULL,
        user_two TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_one, user_two)
      );
    `);
        sqliteDb?.run(`
      CREATE TABLE IF NOT EXISTS persistent_messages (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        message_text TEXT,
        media_url TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
        sqliteDb?.run(`
      CREATE TABLE IF NOT EXISTS permanent_blocks (
        id TEXT PRIMARY KEY,
        blocker_id TEXT NOT NULL,
        blocked_id TEXT NOT NULL,
        blocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(blocker_id, blocked_id)
      );
    `);
        sqliteDb?.run(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL,
        reported_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        snapshot_payload TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `);
        // Self-healing migration: Assign UUIDs to any legacy connections with NULL or empty IDs
        sqliteDb?.all(`SELECT rowid, id FROM connections WHERE id IS NULL OR id = '' OR id = 'null'`, [], (err, rows) => {
            if (!err && rows && rows.length > 0) {
                console.log(`🗄️ Repairing ${rows.length} legacy connection records with missing IDs...`);
                for (const row of rows) {
                    sqliteDb?.run(`UPDATE connections SET id = ? WHERE rowid = ?`, [(0, uuid_1.v4)(), row.rowid]);
                }
            }
        });
    });
}
// Initialize SQLite immediately as ready fallback
sqliteDb = new sqlite3_1.default.Database(dbFilePath, (err) => {
    if (err) {
        console.error('Failed to open SQLite database:', err);
    }
    else {
        initSqliteSchema();
    }
});
// Try PostgreSQL connection
if (process.env.DATABASE_URL) {
    try {
        pgPool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
            connectionTimeoutMillis: 5000,
            ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
        });
        pgPool.connect(async (err, client, release) => {
            if (err) {
                console.warn('🗄️ PostgreSQL connection failed. Using local SQLite database (matchmaker.sqlite). Error:', err.message);
                isPostgresAvailable = false;
            }
            else {
                console.log('🗄️ Connected to PostgreSQL database.');
                isPostgresAvailable = true;
                release();
                await initPostgresSchema();
            }
        });
    }
    catch (e) {
        isPostgresAvailable = false;
    }
}
else {
    console.log('🗄️ No DATABASE_URL provided. Using local SQLite database (matchmaker.sqlite).');
}
/**
 * Universal query wrapper handling both PostgreSQL ($1, $2) and SQLite (?)
 */
async function query(sqlText, params = []) {
    if (isPostgresAvailable && pgPool) {
        const res = await pgPool.query(sqlText, params);
        return { rows: res.rows };
    }
    // Convert Postgres $1, $2, etc. to SQLite ? placeholders AND duplicate params array elements accordingly!
    const paramMatches = sqlText.match(/\$\d+/g);
    let convertedSql = sqlText;
    let sqliteParams = params;
    if (paramMatches && !isPostgresAvailable) {
        sqliteParams = [];
        paramMatches.forEach((match) => {
            const index = parseInt(match.replace('$', ''), 10) - 1;
            sqliteParams.push(params[index]);
        });
        convertedSql = sqlText.replace(/\$\d+/g, '?');
    }
    // Convert PostgreSQL functions & types to SQLite compatibility
    convertedSql = convertedSql
        .replace(/uuid_generate_v4\(\)/gi, "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))")
        .replace(/gen_random_uuid\(\)/gi, "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))")
        .replace(/CURRENT_TIMESTAMP/gi, "datetime('now')");
    // Handle ON CONFLICT for SQLite
    if (convertedSql.includes('ON CONFLICT (user_one, user_two) DO UPDATE SET')) {
        convertedSql = convertedSql.split('ON CONFLICT')[0]; // Simple insert/ignore
        convertedSql = convertedSql.replace(/INSERT INTO/i, 'INSERT OR REPLACE INTO');
    }
    else if (convertedSql.includes('ON CONFLICT (blocker_id, blocked_id) DO NOTHING')) {
        convertedSql = convertedSql.replace(/INSERT INTO/i, 'INSERT OR IGNORE INTO');
        convertedSql = convertedSql.split('ON CONFLICT')[0];
    }
    // Handle RETURNING clause for SQLite
    let hasReturning = false;
    if (convertedSql.toUpperCase().includes('RETURNING')) {
        hasReturning = true;
        convertedSql = convertedSql.split(/RETURNING/i)[0];
    }
    return new Promise((resolve, reject) => {
        if (!sqliteDb) {
            return reject(new Error('SQLite database not initialized'));
        }
        const trimmed = convertedSql.trim().toUpperCase();
        if (trimmed.startsWith('SELECT')) {
            sqliteDb.all(convertedSql, sqliteParams, (err, rows) => {
                if (err)
                    return reject(err);
                resolve({ rows: rows || [] });
            });
        }
        else {
            sqliteDb.run(convertedSql, sqliteParams, function (err) {
                if (err)
                    return reject(err);
                if (hasReturning && trimmed.startsWith('INSERT INTO USERS')) {
                    sqliteDb?.get('SELECT * FROM users WHERE rowid = ?', [this.lastID], (e, row) => {
                        if (e)
                            return reject(e);
                        resolve({ rows: row ? [row] : [] });
                    });
                }
                else if (hasReturning && trimmed.startsWith('INSERT INTO CONNECTIONS')) {
                    sqliteDb?.get('SELECT * FROM connections WHERE rowid = ?', [this.lastID], (e, row) => {
                        if (e)
                            return reject(e);
                        resolve({ rows: row ? [row] : [] });
                    });
                }
                else if (hasReturning && trimmed.startsWith('INSERT INTO PERSISTENT_MESSAGES')) {
                    sqliteDb?.get('SELECT * FROM persistent_messages WHERE rowid = ?', [this.lastID], (e, row) => {
                        if (e)
                            return reject(e);
                        resolve({ rows: row ? [row] : [] });
                    });
                }
                else if (hasReturning && trimmed.startsWith('UPDATE USERS')) {
                    sqliteDb?.get('SELECT * FROM users WHERE id = ?', [sqliteParams[sqliteParams.length - 1]], (e, row) => {
                        if (e)
                            return reject(e);
                        resolve({ rows: row ? [row] : [] });
                    });
                }
                else {
                    resolve({ rows: [] });
                }
            });
        }
    });
}
