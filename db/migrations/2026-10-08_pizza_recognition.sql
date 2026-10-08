CREATE TABLE IF NOT EXISTS pizza_users (
 team_id text NOT NULL, user_id text NOT NULL, identity jsonb NOT NULL, eligible boolean NOT NULL,
 refreshed_at timestamptz NOT NULL DEFAULT now(), earned integer NOT NULL DEFAULT 0 CHECK(earned >= 0), balance integer NOT NULL DEFAULT 0 CHECK(balance >= 0), PRIMARY KEY(team_id,user_id)
);
CREATE TABLE IF NOT EXISTS pizza_inbox (
 id uuid PRIMARY KEY, team_id text NOT NULL, event_id text NOT NULL, kind text NOT NULL, payload jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','complete','rejected')),
 lease_owner uuid, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz NOT NULL DEFAULT now(), safe_error text, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
 UNIQUE(team_id,event_id)
);
CREATE INDEX IF NOT EXISTS pizza_inbox_ready ON pizza_inbox(retry_at,lease_until) WHERE status IN ('pending','running');
CREATE TABLE IF NOT EXISTS pizza_daily_usage (
 team_id text NOT NULL, giver_id text NOT NULL, local_day date NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 5), daily_limit integer NOT NULL DEFAULT 5 CHECK(daily_limit=5), timezone text NOT NULL DEFAULT 'Asia/Dubai' CHECK(timezone='Asia/Dubai'), PRIMARY KEY(team_id,giver_id,local_day)
);
CREATE TABLE IF NOT EXISTS pizza_awards (
 id uuid PRIMARY KEY, team_id text NOT NULL, channel_id text NOT NULL, message_ts text NOT NULL, giver_id text NOT NULL,
 local_day date NOT NULL, reason text, total integer NOT NULL CHECK(total>0), result text NOT NULL CHECK(result IN('accepted','rejected')), rejection text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(team_id,channel_id,message_ts), UNIQUE(team_id,id)
);
CREATE INDEX IF NOT EXISTS pizza_awards_period ON pizza_awards(team_id,local_day) WHERE result='accepted';
CREATE TABLE IF NOT EXISTS pizza_award_recipients (
 team_id text NOT NULL, award_id uuid NOT NULL, recipient_id text NOT NULL, amount integer NOT NULL CHECK(amount>0),
 PRIMARY KEY(award_id,recipient_id), FOREIGN KEY(team_id,award_id) REFERENCES pizza_awards(team_id,id), FOREIGN KEY(team_id,recipient_id) REFERENCES pizza_users(team_id,user_id)
);
CREATE TABLE IF NOT EXISTS pizza_rewards (
 id uuid PRIMARY KEY, team_id text NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), cost integer NOT NULL CHECK(cost>0), description text NOT NULL DEFAULT '' CHECK(length(description)<=2000), active boolean NOT NULL DEFAULT true, stock integer CHECK(stock>=0), UNIQUE(team_id,id)
);
CREATE TABLE IF NOT EXISTS pizza_redemption_intents (
 id uuid PRIMARY KEY, team_id text NOT NULL, user_id text NOT NULL, reward_id uuid NOT NULL, confirmed_cost integer NOT NULL CHECK(confirmed_cost>0), expires_at timestamptz NOT NULL, redemption_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(team_id,id), FOREIGN KEY(team_id,reward_id) REFERENCES pizza_rewards(team_id,id)
);
CREATE TABLE IF NOT EXISTS pizza_redemptions (
 id uuid PRIMARY KEY, team_id text NOT NULL, intent_id uuid NOT NULL, user_id text NOT NULL, reward_id uuid NOT NULL,
 cost integer NOT NULL CHECK(cost>0), reward_name text NOT NULL, description text NOT NULL, reserved_stock boolean NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','fulfilled','cancelled')), admin_actor text, acted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,intent_id), UNIQUE(team_id,id), FOREIGN KEY(team_id,intent_id) REFERENCES pizza_redemption_intents(team_id,id), FOREIGN KEY(team_id,user_id) REFERENCES pizza_users(team_id,user_id), FOREIGN KEY(team_id,reward_id) REFERENCES pizza_rewards(team_id,id)
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pizza_intent_redemption_fk' AND conrelid='pizza_redemption_intents'::regclass) THEN
  ALTER TABLE pizza_redemption_intents ADD CONSTRAINT pizza_intent_redemption_fk FOREIGN KEY(team_id,redemption_id) REFERENCES pizza_redemptions(team_id,id);
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS pizza_ledger (
 id bigserial PRIMARY KEY, team_id text NOT NULL, user_id text NOT NULL, kind text NOT NULL CHECK(kind IN('award','redeem','refund')), reference_id uuid NOT NULL, actor text NOT NULL,
 earned_delta integer NOT NULL, balance_delta integer NOT NULL, operation_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(team_id,operation_key), FOREIGN KEY(team_id,user_id) REFERENCES pizza_users(team_id,user_id), CHECK((kind='award' AND earned_delta>0 AND balance_delta=earned_delta) OR (kind='redeem' AND earned_delta=0 AND balance_delta<0) OR (kind='refund' AND earned_delta=0 AND balance_delta>0))
);
CREATE OR REPLACE FUNCTION pizza_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pizza ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS pizza_ledger_immutable ON pizza_ledger;
CREATE TRIGGER pizza_ledger_immutable BEFORE UPDATE OR DELETE ON pizza_ledger FOR EACH ROW EXECUTE FUNCTION pizza_ledger_immutable();
CREATE TABLE IF NOT EXISTS pizza_outbox (
 id uuid PRIMARY KEY, team_id text NOT NULL, notification_key text NOT NULL, target jsonb, payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','running','sent','expired','ambiguous')), lease_owner uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, retry_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, sent_at timestamptz, external_ref text, safe_error text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(team_id,notification_key)
);
CREATE INDEX IF NOT EXISTS pizza_outbox_ready ON pizza_outbox(retry_at,lease_until) WHERE status IN('pending','running');
