begin;

-- Browser notifications that arrive even with the app closed (Web Push).
--
-- A new task for someone else, or a mention, becomes a row in
-- public.notifications (the in-app inbox). Each new row is handed to the
-- push sender (the Vercel function /api/push) through pg_net — queued with
-- the transaction and sent only after it commits — together with the
-- recipient's registered browsers. The sender signs the messages with the
-- VAPID key and reports browsers that no longer exist (push_gone).
--
-- Setup, once (the secret is the PUSH_SECRET set on Vercel):
--   insert into mavi_private.push_config(url, secret)
--   values ('https://<domínio>/api/push', '<PUSH_SECRET>');
do $$ begin
 create extension if not exists pg_net with schema extensions;
exception when others then
 raise notice 'pg_net unavailable (%): browser push stays off', sqlerrm;
end $$;

-- 1. "Nova tarefa para você": the task's assignee, when someone else
-- created it for them.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned'));
create function mavi_private.notify_new_task() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.assignee_id is distinct from new.creator_id and exists (
  select 1 from public.memberships
  where company_id = new.company_id and user_id = new.assignee_id and active) then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind)
  values (new.company_id, new.assignee_id, new.creator_id, new.id, 'assigned');
 end if;
 return null;
end $$;
revoke all on function mavi_private.notify_new_task() from public, anon, authenticated;
create trigger notify_new_task after insert on public.tasks
 for each row execute function mavi_private.notify_new_task();

-- 2. The browsers each person enabled notifications on. Only reachable
-- through the functions below; the keys never go back to the client.
create table public.push_subscriptions (
 endpoint text primary key check (endpoint ~ '^https://' and length(endpoint) <= 2000),
 user_id uuid not null references auth.users(id) on delete cascade,
 p256dh text not null check (length(p256dh) <= 200),
 auth text not null check (length(auth) <= 100),
 user_agent text check (length(user_agent) <= 400),
 created_at timestamptz not null default now(),
 seen_at timestamptz not null default now()
);
create index push_subscriptions_user on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;

-- A browser belongs to whoever is signed in on it now: saving an endpoint
-- another account had moves it to the current person.
create function public.save_push_subscription(p_endpoint text, p_p256dh text,
 p_auth text, p_user_agent text default null) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if auth.uid() is null then raise exception 'Sem permissão' using errcode = '42501'; end if;
 insert into public.push_subscriptions(endpoint, user_id, p256dh, auth, user_agent)
 values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_user_agent, 400))
 on conflict (endpoint) do update set user_id = excluded.user_id,
  p256dh = excluded.p256dh, auth = excluded.auth,
  user_agent = excluded.user_agent, seen_at = now();
end $$;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

create function public.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
 delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;
revoke all on function public.remove_push_subscription(text) from public, anon;
grant execute on function public.remove_push_subscription(text) to authenticated;

-- 3. Where to hand notifications over, and the secret proving it's us.
create table mavi_private.push_config (
 id boolean primary key default true check (id),
 url text not null check (url ~ '^https://'),
 secret text not null check (length(secret) >= 32)
);
revoke all on mavi_private.push_config from public, anon, authenticated;

create function mavi_private.push_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; subs jsonb; t public.tasks;
 actor text; excerpt text; title text; body text; begin
 select * into cfg from mavi_private.push_config where id;
 if cfg.url is null then return null; end if;
 select jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
  'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
  into subs from public.push_subscriptions s where s.user_id = new.user_id;
 if subs is null then return null; end if;
 select * into t from public.tasks where company_id = new.company_id and id = new.task_id;
 select name into actor from public.memberships
  where company_id = new.company_id and user_id = new.actor_id;
 if new.kind = 'assigned' then
  title := 'Nova tarefa para você';
  body := coalesce(actor, 'Alguém') || ' criou: ' || t.title
   || ' · prazo ' || to_char(t.due_date, 'DD/MM');
 else
  select left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 140)
   into excerpt from public.comments c where c.id = new.comment_id;
  title := coalesce(actor, 'Alguém') || ' mencionou você';
  body := t.title || coalesce(': ' || nullif(excerpt, ''), '');
 end if;
 perform net.http_post(
  url := cfg.url,
  body := jsonb_build_object('subscriptions', subs, 'message', jsonb_build_object(
   'title', title, 'body', body, 'tag', new.id, 'url', '/tarefas/' || new.task_id)),
  headers := jsonb_build_object('Content-Type', 'application/json',
   'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 8000);
 return null;
exception when others then
 -- The notification stays in the inbox even if it can't be pushed.
 raise warning 'mavi push failed: %', sqlerrm;
 return null;
end $$;
revoke all on function mavi_private.push_notification() from public, anon, authenticated;
create trigger push_notification after insert on public.notifications
 for each row execute function mavi_private.push_notification();

-- The sender reports browsers that no longer exist (HTTP 404/410).
create function public.push_gone(p_secret text, p_endpoints text[]) returns integer
language plpgsql security definer set search_path = '' as $$ declare n integer; begin
 if not exists (select 1 from mavi_private.push_config where id and secret = p_secret) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 delete from public.push_subscriptions where endpoint = any(p_endpoints);
 get diagnostics n = row_count;
 return n;
end $$;
revoke all on function public.push_gone(text, text[]) from public;
grant execute on function public.push_gone(text, text[]) to anon, authenticated;

commit;
