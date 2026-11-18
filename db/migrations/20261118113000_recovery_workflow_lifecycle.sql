-- The signing deadline may move while an invitation's frozen message and
-- provider key survive. This expiry is mutable scheduling data.
ALTER TABLE public.recovery_jobs ADD COLUMN signing_expires_at bigint
  CHECK (signing_expires_at >= 0);

-- Lockout audits precede mail materialization. These processing fields are
-- independent of the immutable audit fields covered by the hash chain.
ALTER TABLE public.system_audit_events
  ADD COLUMN signing_lock_alert_reconciled_at timestamptz,
  ADD COLUMN signing_lock_alert_retry_at timestamptz;

CREATE INDEX system_audit_pending_signing_lock_alerts_idx
  ON public.system_audit_events (sequence)
  WHERE event = 'signing_locked'
    AND metadata @> '{"durableAlert":true}'::jsonb
    AND signing_lock_alert_reconciled_at IS NULL;

CREATE INDEX system_audit_signing_lock_state_idx
  ON public.system_audit_events (target_user_id, sequence DESC)
  WHERE event IN ('signing_locked', 'signing_unlocked', 'account_deleted');

-- Equal day counts in two separate policy periods are distinct decisions.
CREATE SEQUENCE public.retention_policy_generation_seq AS bigint;
ALTER TABLE public.app_settings ADD COLUMN retention_policy_generation bigint
  NOT NULL DEFAULT nextval('public.retention_policy_generation_seq');
ALTER SEQUENCE public.retention_policy_generation_seq
  OWNED BY public.app_settings.retention_policy_generation;

CREATE FUNCTION public.version_retention_policy() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog, public AS $$
BEGIN
  NEW.retention_policy_generation := nextval('public.retention_policy_generation_seq');
  RETURN NEW;
END;
$$;

CREATE TRIGGER version_retention_policy
  BEFORE UPDATE OF retention_days ON public.app_settings
  FOR EACH ROW WHEN (OLD.retention_days IS DISTINCT FROM NEW.retention_days)
  EXECUTE FUNCTION public.version_retention_policy();

ALTER TABLE public.envelopes ADD COLUMN retention_warning_policy_generation bigint;
