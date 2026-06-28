CREATE TABLE IF NOT EXISTS multiplayer_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID NOT NULL REFERENCES users(id),
    lesson_id INTEGER NOT NULL REFERENCES lessons(id),
    code VARCHAR(6) NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'playing', 'finished', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_multiplayer_sessions_code ON multiplayer_sessions(code);
CREATE INDEX IF NOT EXISTS idx_multiplayer_sessions_host ON multiplayer_sessions(host_id);

CREATE TABLE IF NOT EXISTS multiplayer_participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES multiplayer_sessions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id),
    score REAL NOT NULL DEFAULT 0,
    perfects INTEGER NOT NULL DEFAULT 0,
    goods INTEGER NOT NULL DEFAULT 0,
    lates INTEGER NOT NULL DEFAULT 0,
    misses INTEGER NOT NULL DEFAULT 0,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    UNIQUE(session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_multiplayer_participants_session ON multiplayer_participants(session_id);
