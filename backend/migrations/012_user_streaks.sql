CREATE TABLE IF NOT EXISTS user_streaks (
    first_user_id UUID NOT NULL REFERENCES users(id),
    second_user_id UUID NOT NULL REFERENCES users(id),
    streak_days INTEGER NOT NULL DEFAULT 0,
    last_practice_date DATE NOT NULL,
    PRIMARY KEY (first_user_id, second_user_id),
    CHECK (first_user_id < second_user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_streaks_first ON user_streaks(first_user_id);
CREATE INDEX IF NOT EXISTS idx_user_streaks_second ON user_streaks(second_user_id);
