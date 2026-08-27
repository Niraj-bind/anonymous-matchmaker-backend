-- Initial Schema Migration for Zero-Footprint Matchmaker & Decoupled Chat
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Users Table (Zero personal data)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    username VARCHAR(32) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    app_id VARCHAR(6) UNIQUE NOT NULL,
    age INT NOT NULL CHECK (age >= 18),
    gender VARCHAR(10) NOT NULL CHECK (gender IN ('man', 'woman')),
    total_stars BIGINT NOT NULL DEFAULT 5,
    total_ratings BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_app_id ON users(app_id);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- 2. Connections Table (Layer 2 Friends Hub)
CREATE TABLE IF NOT EXISTS connections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_one UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_two UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_pair UNIQUE (user_one, user_two)
);

CREATE INDEX IF NOT EXISTS idx_connections_users ON connections(user_one, user_two);

-- 3. Persistent Messages Table (Layer 2 DM History)
CREATE TABLE IF NOT EXISTS persistent_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    connection_id UUID NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_text TEXT,
    media_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_persistent_messages_connection ON persistent_messages(connection_id, created_at);

-- 4. Permanent Blocks Table (Layer 2 Lifetime Blocks)
CREATE TABLE IF NOT EXISTS permanent_blocks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_block_pair UNIQUE (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_permanent_blocks_blocker ON permanent_blocks(blocker_id);

-- 5. Reports Table (Safety & Objectionable Content Snapshots)
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason VARCHAR(50) NOT NULL,
    snapshot_payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id);
