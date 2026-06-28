CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lessons (
    id SERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    content JSONB NOT NULL DEFAULT '{}',
    difficulty TEXT NOT NULL DEFAULT 'beginner',
    order_index INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_progress (
    id SERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    score REAL NOT NULL DEFAULT 0.0,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_user_progress_user_id ON user_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_lessons_order ON lessons(order_index);

-- Seed lessons
INSERT INTO lessons (title, description, content, difficulty, order_index) VALUES
('Notas Do, Re, Mi', 'Aprende las tres primeras notas: Do, Re y Mi', '{"notes": ["C4", "D4", "E4"], "expected": ["C4", "D4", "E4"], "tempo": 80}', 'beginner', 1),
('Notas Fa, Sol, La, Si', 'Continúa con Fa, Sol, La y Si', '{"notes": ["F4", "G4", "A4", "B4"], "expected": ["F4", "G4", "A4", "B4"], "tempo": 80}', 'beginner', 2),
('Escala de Do Mayor', 'Toca la escala completa de Do Mayor', '{"notes": ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"], "expected": ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"], "tempo": 90}', 'beginner', 3),
('Canción: Estrellita', 'Toca "Estrellita, ¿dónde estás?"', '{"notes": ["C4", "C4", "G4", "G4", "A4", "A4", "G4", "F4", "F4", "E4", "E4", "D4", "D4", "C4"], "expected": ["C4", "C4", "G4", "G4", "A4", "A4", "G4", "F4", "F4", "E4", "E4", "D4", "D4", "C4"], "tempo": 100}', 'easy', 4)
ON CONFLICT DO NOTHING;
