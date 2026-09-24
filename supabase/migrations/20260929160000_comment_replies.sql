begin;

-- Replies to a comment. Conversations are one level deep, as in ClickUp: a
-- reply points at the conversation's first comment, and answering a reply
-- joins that same conversation. Always on the same task.
alter table public.comments add constraint comments_task_unique unique (company_id, task_id, id);
alter table public.comments add column parent_id uuid;
alter table public.comments add constraint comments_parent_fk
 foreign key (company_id, task_id, parent_id)
 references public.comments(company_id, task_id, id) on delete cascade;
alter table public.comments add constraint comments_parent_not_self check (parent_id is distinct from id);
create index comments_parent on public.comments(parent_id) where parent_id is not null;

-- p_parent is optional: the old two-argument call still posts a comment.
drop function public.add_comment(uuid, text);
create function public.add_comment(p_task uuid, p_body text, p_parent uuid default null)
returns public.comments
language plpgsql security definer set search_path = '' as $$
declare t public.tasks; root uuid; result public.comments; begin
 select * into t from public.tasks where id = p_task;
 if not found or not mavi_private.task_access(t.company_id, t.id) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if p_parent is not null then
  select coalesce(c.parent_id, c.id) into root from public.comments c
  where c.company_id = t.company_id and c.task_id = t.id and c.id = p_parent;
  if root is null then
   raise exception 'O comentário respondido não existe nesta tarefa' using errcode = '22023';
  end if;
 end if;
 insert into public.comments(company_id, task_id, body, parent_id)
 values (t.company_id, t.id, trim(p_body), root) returning * into result;
 return result;
end $$;
revoke all on function public.add_comment(uuid, text, uuid) from public, anon;
grant execute on function public.add_comment(uuid, text, uuid) to authenticated;

-- "Respondeu": everyone already in the conversation (who opened it or
-- replied), still active, except the reply's author and whoever this reply
-- mentions (comment_mentions, which runs first, already told them).
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply'));
create function mavi_private.comment_replies() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.notifications(company_id, user_id, actor_id, task_id, comment_id, kind)
 select distinct new.company_id, c.author_id, new.author_id, new.task_id, new.id, 'reply'
 from public.comments c
 join public.memberships m on m.company_id = c.company_id and m.user_id = c.author_id and m.active
 where c.company_id = new.company_id and c.task_id = new.task_id
  and (c.id = new.parent_id or c.parent_id = new.parent_id)
  and c.author_id is distinct from new.author_id
  and not exists (select 1 from public.notifications n
   where n.comment_id = new.id and n.user_id = c.author_id);
 return null;
end $$;
revoke all on function mavi_private.comment_replies() from public, anon, authenticated;
create trigger comment_replies after insert on public.comments
 for each row when (new.parent_id is not null)
 execute function mavi_private.comment_replies();

-- Browser push says who replied (same as before for the other kinds).
create or replace function mavi_private.push_notification() returns trigger
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
  title := coalesce(actor, 'Alguém') || case when new.kind = 'reply'
   then ' respondeu um comentário' else ' mencionou você' end;
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

commit;
