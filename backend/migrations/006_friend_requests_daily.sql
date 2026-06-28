ALTER TABLE friend_requests DROP CONSTRAINT IF EXISTS friend_requests_sender_id_receiver_id_key;

CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_receiver_date
    ON friend_requests(sender_id, receiver_id, created_at);
