"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.query = query;
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
let pgPool = null;
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
// PostgreSQL Pool Connection Initialization
if (process.env.DATABASE_URL) {
    try {
        pgPool = new pg_1.Pool({
            connectionString: process.env.DATABASE_URL,
            connectionTimeoutMillis: 5000,
            ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
        });
        pgPool.connect(async (err, client, release) => {
            if (err) {
                console.error('🗄️ PostgreSQL connection failed. Error:', err.message);
            }
            else {
                console.log('🗄️ Connected to PostgreSQL database.');
                release();
                await initPostgresSchema();
            }
        });
    }
    catch (e) {
        console.error('Failed to create PostgreSQL Pool:', e.message);
    }
}
else {
    console.warn('🗄️ WARNING: No DATABASE_URL provided. Please set DATABASE_URL environment variable.');
}
/**
 * Universal query wrapper for PostgreSQL
 */
async function query(sqlText, params = []) {
    if (!pgPool) {
        throw new Error('Database connection uninitialized. DATABASE_URL environment variable missing.');
    }
    const res = await pgPool.query(sqlText, params);
    return { rows: res.rows };
}
