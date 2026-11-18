-- user_id stays immutable because it is authenticated with the ciphertext.
-- NULL identifies old rows, including restores of pre-column logical backups.
ALTER TABLE public.recovery_jobs ADD COLUMN purge_with_user boolean;
