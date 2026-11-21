-- High-entropy bearer token hashes identify completed envelopes on the
-- public verification page. The token itself is retained only in the
-- encrypted finalization recovery payload and the sealed PDF artifacts.
alter table public.envelopes
  add column if not exists public_verification_token_hash text
    check (public_verification_token_hash is null or length(public_verification_token_hash) = 64);

create unique index if not exists idx_envelopes_public_verification_token_hash
  on public.envelopes(public_verification_token_hash)
  where public_verification_token_hash is not null;
