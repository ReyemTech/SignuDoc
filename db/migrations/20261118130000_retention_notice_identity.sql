-- Explicit values round-trip through logical backups. A pre-UUID backup
-- receives fresh defaults, so historical receipts cannot start a new grace period.
ALTER TABLE public.app_settings ADD COLUMN retention_policy_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public."user" ADD COLUMN retention_mailbox_revision uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.envelopes
  ADD COLUMN retention_custody_revision uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN retention_warning_key text;

CREATE FUNCTION public.refresh_retention_policy_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
  NEW.retention_policy_revision := gen_random_uuid();
  RETURN NEW;
END;
$$;
CREATE TRIGGER refresh_retention_policy_revision BEFORE UPDATE OF retention_days ON public.app_settings
  FOR EACH ROW WHEN (OLD.retention_days IS DISTINCT FROM NEW.retention_days)
  EXECUTE FUNCTION public.refresh_retention_policy_revision();

CREATE FUNCTION public.refresh_retention_mailbox_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
  NEW.retention_mailbox_revision := gen_random_uuid();
  RETURN NEW;
END;
$$;
CREATE TRIGGER refresh_retention_mailbox_revision BEFORE UPDATE OF email ON public."user"
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email)
  EXECUTE FUNCTION public.refresh_retention_mailbox_revision();

CREATE FUNCTION public.refresh_retention_custody_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $$
BEGIN
  NEW.retention_custody_revision := gen_random_uuid();
  RETURN NEW;
END;
$$;
CREATE TRIGGER refresh_retention_custody_revision BEFORE UPDATE OF user_id ON public.envelopes
  FOR EACH ROW WHEN (OLD.user_id IS DISTINCT FROM NEW.user_id)
  EXECUTE FUNCTION public.refresh_retention_custody_revision();

CREATE FUNCTION public.retention_notice_key(envelope text, policy uuid, custody uuid, mailbox uuid)
RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path TO pg_catalog
AS $$ SELECT 'retention-notice/' || envelope || '/' || policy::text || '/' || custody::text || '/' || mailbox::text $$;
