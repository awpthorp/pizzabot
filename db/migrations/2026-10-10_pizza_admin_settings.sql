CREATE TABLE IF NOT EXISTS pizza_settings (
  team_id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  daily_limit integer NOT NULL DEFAULT 5 CHECK (daily_limit BETWEEN 0 AND 1000),
  small_cost integer NOT NULL DEFAULT 6 CHECK (small_cost BETWEEN 1 AND 1000000),
  medium_cost integer NOT NULL DEFAULT 8 CHECK (medium_cost BETWEEN 1 AND 1000000),
  large_cost integer NOT NULL DEFAULT 12 CHECK (large_cost BETWEEN 1 AND 1000000),
  weekly_enabled boolean NOT NULL DEFAULT true,
  monthly_enabled boolean NOT NULL DEFAULT true
);
-- Lowering a limit below today's usage does not erase consumed allowance.
ALTER TABLE pizza_daily_usage DROP CONSTRAINT IF EXISTS pizza_daily_usage_used_check;
ALTER TABLE pizza_daily_usage DROP CONSTRAINT IF EXISTS pizza_daily_usage_daily_limit_check;
ALTER TABLE pizza_daily_usage ADD CONSTRAINT pizza_daily_usage_used_check CHECK (used >= 0);
ALTER TABLE pizza_daily_usage ADD CONSTRAINT pizza_daily_usage_daily_limit_check CHECK (daily_limit BETWEEN 0 AND 1000);
ALTER TABLE pizza_ledger DROP CONSTRAINT IF EXISTS pizza_ledger_kind_check;
ALTER TABLE pizza_ledger DROP CONSTRAINT IF EXISTS pizza_ledger_check;
ALTER TABLE pizza_ledger ADD CONSTRAINT pizza_ledger_kind_check CHECK (kind IN ('award','redeem','refund','adjustment'));
ALTER TABLE pizza_ledger ADD CONSTRAINT pizza_ledger_check CHECK (
  (kind='award' AND earned_delta>0 AND balance_delta=earned_delta) OR
  (kind='redeem' AND earned_delta=0 AND balance_delta<0) OR
  (kind='refund' AND earned_delta=0 AND balance_delta>0) OR
  (kind='adjustment' AND earned_delta=0 AND balance_delta<>0)
);
CREATE TABLE IF NOT EXISTS pizza_settings_changes (
  team_id text NOT NULL, job_id uuid NOT NULL, actor text NOT NULL,
  old_values jsonb NOT NULL, new_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_id,job_id)
);
CREATE TABLE IF NOT EXISTS pizza_balance_adjustments (
  team_id text NOT NULL, job_id uuid NOT NULL, actor text NOT NULL, recipient text NOT NULL,
  delta integer NOT NULL CHECK (delta BETWEEN -1000000 AND 1000000 AND delta<>0),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  before_balance integer NOT NULL CHECK (before_balance >= 0),
  after_balance integer NOT NULL CHECK (after_balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (team_id,job_id),
  CHECK (after_balance::bigint=before_balance::bigint+delta),
  FOREIGN KEY (team_id,recipient) REFERENCES pizza_users(team_id,user_id)
);
CREATE INDEX IF NOT EXISTS pizza_settings_history ON pizza_settings_changes(team_id,created_at DESC);
CREATE INDEX IF NOT EXISTS pizza_adjustment_history ON pizza_balance_adjustments(team_id,created_at DESC);
