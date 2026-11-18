ALTER TABLE public.envelopes ADD COLUMN finalization_pending boolean NOT NULL DEFAULT false,
  ADD CHECK (NOT finalization_pending OR status = 'sent');

-- The lease owns these three immutable names before the first external write.
-- A writer holds a share lock on this row only during a PUT. Losing the
-- lease removes the row, which drains current writers and bars later ones.
CREATE TABLE public.finalization_attempts (
  job_id uuid PRIMARY KEY,
  lease_token uuid NOT NULL,
  storage_keys text[] NOT NULL CHECK (cardinality(storage_keys) = 3)
);

CREATE FUNCTION public.retire_finalization_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  retired_keys text[];
BEGIN
  IF OLD.kind <> 'finalize_envelope' OR OLD.lease_token IS NULL THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
    RETURN OLD;
  END IF;
  DELETE FROM public.finalization_attempts
    WHERE job_id = OLD.id AND lease_token = OLD.lease_token RETURNING storage_keys INTO retired_keys;
  IF TG_OP = 'DELETE' OR NEW.state <> 'succeeded' THEN
    INSERT INTO public.pending_file_deletions (storage_key, envelope_id, queued_at)
      SELECT key, OLD.envelope_id, floor(extract(epoch FROM clock_timestamp()))
      FROM unnest(retired_keys) AS key ON CONFLICT (storage_key) DO NOTHING;
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER retire_finalization_attempt
AFTER UPDATE OF lease_token OR DELETE ON public.recovery_jobs
FOR EACH ROW EXECUTE FUNCTION public.retire_finalization_attempt();
