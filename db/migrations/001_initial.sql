BEGIN;
CREATE SCHEMA IF NOT EXISTS bugout;
CREATE TABLE IF NOT EXISTS bugout.schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS bugout.investigations (
  id uuid PRIMARY KEY, actor text NOT NULL, intake jsonb NOT NULL,
  redactions jsonb NOT NULL DEFAULT '[]', analysis jsonb NOT NULL DEFAULT '{}', plan jsonb,
  plan_hash text CHECK (plan_hash IS NULL OR plan_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('queued','analyzing','awaiting_reporter','awaiting_approval','running','finalizing','completed','cancelled','failed')),
  outcome text CHECK (outcome IN ('reproduced','intermittent','not_reproduced','blocked','inconclusive')),
  delivery_status text NOT NULL DEFAULT 'not_requested' CHECK (delivery_status = 'not_requested'),
  version integer NOT NULL DEFAULT 0, current_round integer NOT NULL DEFAULT 0 CHECK (current_round BETWEEN 0 AND 2),
  failure_count integer NOT NULL DEFAULT 0, incomplete_reason text,
  cancel_requested_at timestamptz, cleanup_status text NOT NULL DEFAULT 'not_required',
  wait_expires_at timestamptz, deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE IF NOT EXISTS bugout.state_transitions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, investigation_id uuid NOT NULL REFERENCES bugout.investigations ON DELETE CASCADE,
  previous_status text, new_status text NOT NULL, actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bugout.follow_up_rounds (
  id uuid PRIMARY KEY, investigation_id uuid NOT NULL REFERENCES bugout.investigations ON DELETE CASCADE,
  round_number integer NOT NULL CHECK (round_number BETWEEN 1 AND 2), questions jsonb NOT NULL, answers jsonb,
  status text NOT NULL CHECK (status IN ('open','answered','expired')), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz, UNIQUE (investigation_id, round_number)
);
CREATE TABLE IF NOT EXISTS bugout.approvals (
  id uuid PRIMARY KEY, investigation_id uuid NOT NULL REFERENCES bugout.investigations ON DELETE CASCADE,
  plan_hash text NOT NULL, decision text NOT NULL CHECK (decision IN ('approved','rejected')), actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (investigation_id, plan_hash)
);
CREATE TABLE IF NOT EXISTS bugout.execution_runs (
  id uuid PRIMARY KEY, investigation_id uuid NOT NULL REFERENCES bugout.investigations ON DELETE CASCADE,
  repeat_index integer NOT NULL CHECK (repeat_index BETWEEN 1 AND 3), plan_hash text NOT NULL,
  runner_status text NOT NULL DEFAULT 'reserved', evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (investigation_id, repeat_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_unfinished_run ON bugout.execution_runs (investigation_id) WHERE evidence IS NULL;
CREATE TABLE IF NOT EXISTS bugout.reports (
  investigation_id uuid PRIMARY KEY REFERENCES bugout.investigations ON DELETE CASCADE,
  json_report jsonb NOT NULL, markdown text NOT NULL, schema_version integer NOT NULL DEFAULT 1,
  rule_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bugout.idempotency (
  actor text NOT NULL, operation text NOT NULL, key text NOT NULL, request_hash text NOT NULL,
  investigation_id uuid REFERENCES bugout.investigations ON DELETE CASCADE,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (actor, operation, key)
);
CREATE TABLE IF NOT EXISTS bugout.outbox (
  id uuid PRIMARY KEY, investigation_id uuid NOT NULL REFERENCES bugout.investigations ON DELETE CASCADE,
  dispatched_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pending_outbox ON bugout.outbox (created_at) WHERE dispatched_at IS NULL;
CREATE INDEX IF NOT EXISTS investigations_status_time ON bugout.investigations (status, updated_at);
CREATE INDEX IF NOT EXISTS investigations_retention ON bugout.investigations (completed_at);
CREATE INDEX IF NOT EXISTS transitions_investigation ON bugout.state_transitions (investigation_id, created_at);
INSERT INTO bugout.schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
