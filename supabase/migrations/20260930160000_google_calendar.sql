begin;

-- Agenda: each person connects their own Google Calendar. Events are read
-- and written live in Google through /api/google; nothing of the calendar
-- is copied here. This only keeps the connection: the refresh token (and
-- the current access token), encrypted by the server with AES-256-GCM under
-- GOOGLE_TOKEN_KEY, which the database never sees. A connection belongs to
-- the person (not to a company) and only that person's session reaches it.
create table mavi_private.google_connections (
 user_id uuid primary key references auth.users(id) on delete cascade,
 account_email text not null default '',
 scope text not null default '',
 refresh_token_cipher text not null,
 access_token_cipher text,
 access_expires_at timestamptz,
 connected_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
alter table mavi_private.google_connections enable row level security;
revoke all on mavi_private.google_connections from public, anon, authenticated;

-- One-time values tying Google's redirect back to whoever started it.
create table mavi_private.google_oauth_states (
 state text primary key check (state ~ '^[0-9a-f]{64}$'),
 user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table mavi_private.google_oauth_states enable row level security;
revoke all on mavi_private.google_oauth_states from public, anon, authenticated;

-- Starts a connection: a fresh state for the signed-in person (15 minutes).
create function public.google_begin_connect() returns text
language plpgsql security definer set search_path = '' as $$
declare s text := encode(extensions.gen_random_bytes(32), 'hex'); begin
  if auth.uid() is null then raise exception 'Entre para conectar sua agenda.' using errcode = '42501'; end if;
  delete from mavi_private.google_oauth_states where created_at < now() - interval '15 minutes' or user_id = auth.uid();
  insert into mavi_private.google_oauth_states(state, user_id) values (s, auth.uid());
  return s;
end $$;

-- Finishes it, from Google's redirect (no session there: the server calls
-- it anonymously). Only a fresh, unused state binds the tokens, and only to
-- the person who started it.
create function public.google_complete_connect(p_state text, p_email text, p_scope text,
 p_refresh_cipher text, p_access_cipher text, p_expires_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare who uuid; begin
  delete from mavi_private.google_oauth_states
  where state = p_state and created_at > now() - interval '15 minutes'
  returning user_id into who;
  if who is null then raise exception 'Conexão expirada. Tente conectar de novo.' using errcode = '42501'; end if;
  if coalesce(p_refresh_cipher, '') !~ '^v1:' then raise exception 'Resposta do Google incompleta.' using errcode = '22023'; end if;
  insert into mavi_private.google_connections(user_id, account_email, scope, refresh_token_cipher,
   access_token_cipher, access_expires_at)
  values (who, left(coalesce(p_email, ''), 320), left(coalesce(p_scope, ''), 2000), p_refresh_cipher,
   p_access_cipher, p_expires_at)
  on conflict (user_id) do update set account_email = excluded.account_email, scope = excluded.scope,
   refresh_token_cipher = excluded.refresh_token_cipher, access_token_cipher = excluded.access_token_cipher,
   access_expires_at = excluded.access_expires_at, connected_at = now(), updated_at = now();
end $$;

-- What the page shows: connected or not, and which Google account.
create function public.google_connection() returns table(account_email text, connected_at timestamptz, scope text)
language sql stable security definer set search_path = '' as $$
 select c.account_email, c.connected_at, c.scope from mavi_private.google_connections c where c.user_id = auth.uid()
$$;

-- For /api/google only: the caller's encrypted tokens (useless without the
-- server's key), and saving a refreshed access token.
create function public.google_tokens() returns table(refresh_token_cipher text, access_token_cipher text,
 access_expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
 select c.refresh_token_cipher, c.access_token_cipher, c.access_expires_at
 from mavi_private.google_connections c where c.user_id = auth.uid()
$$;

create function public.google_save_access(p_access_cipher text, p_expires_at timestamptz) returns void
language sql security definer set search_path = '' as $$
 update mavi_private.google_connections set access_token_cipher = p_access_cipher,
  access_expires_at = p_expires_at, updated_at = now()
 where user_id = auth.uid()
$$;

create function public.google_disconnect() returns void
language sql security definer set search_path = '' as $$
 delete from mavi_private.google_connections where user_id = auth.uid()
$$;

revoke all on function public.google_begin_connect(), public.google_complete_connect(text, text, text, text, text, timestamptz),
 public.google_connection(), public.google_tokens(), public.google_save_access(text, timestamptz),
 public.google_disconnect() from public, anon, authenticated;
grant execute on function public.google_begin_connect(), public.google_connection(), public.google_tokens(),
 public.google_save_access(text, timestamptz), public.google_disconnect() to authenticated;
grant execute on function public.google_complete_connect(text, text, text, text, text, timestamptz) to anon, authenticated;

commit;
