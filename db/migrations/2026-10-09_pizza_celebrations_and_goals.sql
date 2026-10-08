-- Optional tiers do not change any existing price or accounting values.
ALTER TABLE pizza_rewards ADD COLUMN IF NOT EXISTS tier text;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pizza_reward_tier_check' AND conrelid='pizza_rewards'::regclass) THEN
  ALTER TABLE pizza_rewards ADD CONSTRAINT pizza_reward_tier_check CHECK(tier IS NULL OR tier IN ('small','medium','large'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS pizza_reward_goals (
 team_id text NOT NULL, user_id text NOT NULL, reward_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,user_id), FOREIGN KEY(team_id,reward_id) REFERENCES pizza_rewards(team_id,id)
);
CREATE TABLE IF NOT EXISTS pizza_celebrations (
 team_id text NOT NULL, period_kind text NOT NULL CHECK(period_kind IN ('week','month')), period_start timestamptz NOT NULL,
 period_end timestamptz NOT NULL, due_at timestamptz NOT NULL, notification_key text NOT NULL, queued_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(team_id,period_kind,period_start), UNIQUE(team_id,notification_key), CHECK(period_end>period_start AND due_at>=period_end)
);
CREATE INDEX IF NOT EXISTS pizza_awards_original_time ON pizza_awards(team_id,(message_ts::numeric)) WHERE result='accepted';
CREATE INDEX IF NOT EXISTS pizza_pending_award_time ON pizza_inbox(team_id,kind) WHERE kind='award' AND status IN ('pending','running');
