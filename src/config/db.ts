import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

let pgPool: Pool | null = null;

async function initPostgresSchema() {
  if (!pgPool) return;
  console.log('🗄️ Database: Initializing PostgreSQL database schema...');
  try {
    // Enable uuid-ossp extension if available
    try {
      await pgPool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
    } catch (extErr: any) {
      console.warn('🗄️ Note: uuid-ossp extension not enabled, falling back to manual UUIDs.');
    }

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        app_id VARCHAR(10) UNIQUE NOT NULL,
        age INTEGER NOT NULL CHECK (age >= 18),
        gender VARCHAR(20) NOT NULL CHECK (gender IN ('man', 'woman')),
        total_stars BIGINT NOT NULL DEFAULT 5,
        total_ratings BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_users_app_id ON users(app_id);
      CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_one TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_two TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'blocked')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_user_pair UNIQUE (user_one, user_two)
      );

      CREATE INDEX IF NOT EXISTS idx_connections_users ON connections(user_one, user_two);
      CREATE INDEX IF NOT EXISTS idx_connections_status ON connections(status);

      CREATE TABLE IF NOT EXISTS persistent_messages (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_text TEXT,
        media_url TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_persistent_messages_conn ON persistent_messages(connection_id, created_at);

      CREATE TABLE IF NOT EXISTS permanent_blocks (
        id TEXT PRIMARY KEY,
        blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT unique_block_pair UNIQUE (blocker_id, blocked_id)
      );

      CREATE INDEX IF NOT EXISTS idx_permanent_blocks_blocker ON permanent_blocks(blocker_id);

      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reported_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reason VARCHAR(100) NOT NULL,
        snapshot_payload TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
    `);
    console.log('🗄️ PostgreSQL schema initialized with full indexes and constraints.');
  } catch (err: any) {
    console.error('Failed to initialize PostgreSQL schema:', err.message);
  }
}

// PostgreSQL Pool Connection Initialization
if (process.env.DATABASE_URL) {
  try {
    const isLocalhost = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 10000,
      ssl: isLocalhost ? false : { rejectUnauthorized: false },
    });
    pgPool.connect(async (err: any, client: any, release: any) => {
      if (err) {
        console.error('🗄️ PostgreSQL connection failed. Error:', err.message);
      } else {
        console.log('🗄️ Connected to PostgreSQL database.');
        release();
        await initPostgresSchema();
      }
    });
  } catch (e: any) {
    console.error('Failed to create PostgreSQL Pool:', e.message);
  }
} else {
  console.warn('🗄️ WARNING: No DATABASE_URL provided. Running without PostgreSQL database.');
}

/**
 * Universal query wrapper for PostgreSQL
 */
export async function query(sqlText: string, params: any[] = []): Promise<{ rows: any[] }> {
  if (!pgPool) {
    throw new Error('Database connection uninitialized. DATABASE_URL environment variable missing.');
  }
  const res = await pgPool.query(sqlText, params);
  return { rows: res.rows };
}
