CREATE TABLE public.recovery_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email', 'finalize_envelope')),
  dedupe_key text NOT NULL UNIQUE,
  envelope_id text REFERENCES public.envelopes(id) ON DELETE CASCADE,
  -- Auth callbacks can run before their adapter transaction finishes. A user
  -- foreign key would wait on that transaction while it waits on the callback.
  user_id text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'running', 'succeeded', 'needs_attention', 'cancelled')),
  payload_digest bytea NOT NULL,
  payload_ciphertext bytea,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  first_attempt_at timestamptz,
  expires_at bigint,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((state IN ('succeeded', 'cancelled')) = (payload_ciphertext IS NULL))
);

CREATE INDEX recovery_jobs_pending_idx ON public.recovery_jobs (available_at, id)
  WHERE state = 'pending';
CREATE INDEX recovery_jobs_leased_idx ON public.recovery_jobs (lease_expires_at, id)
  WHERE state = 'running';
CREATE INDEX recovery_jobs_attention_idx ON public.recovery_jobs (updated_at, id)
  WHERE state = 'needs_attention';
CREATE INDEX recovery_jobs_envelope_idx ON public.recovery_jobs (envelope_id)
  WHERE envelope_id IS NOT NULL;
CREATE INDEX recovery_jobs_user_idx ON public.recovery_jobs (user_id)
  WHERE user_id IS NOT NULL;
