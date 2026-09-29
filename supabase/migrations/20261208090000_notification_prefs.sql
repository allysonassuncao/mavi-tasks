-- Notificações: cada pessoa escolhe o que recebe (Meu perfil › Notificações).
--
-- * notification_prefs guarda, por pessoa e empresa, só o que ela mudou; o
--   resto segue o padrão (mavi_private.notification_default). Vale em todos os
--   navegadores e celulares dela.
-- * Um tipo desligado não chega: o gatilho filter_notification descarta a
--   linha antes de gravar, então não vai para a caixa de entrada, nem em tempo
--   real, nem por push. Os avisos do Mural não passam pelo filtro (quem
--   publica decide como eles saem).
-- * Pausar (1 hora, até amanhã, até retomar) mantém a caixa de entrada e só
--   segura o navegador: o push não sai e o app aberto não mostra o aviso.
-- * Avisos novos: a mudança de status, conforme o papel da pessoa na tarefa
--   (criador, responsável, participante), e "tarefa para validar" para quem
--   valida quando a tarefa entra em Em validação. Quem fez a mudança não é
--   avisado, e as alterações em massa (mavi.bulk_tasks) não avisam uma a uma.

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review'));

-- ------------------------------------------------------------ preferências
create table public.notification_prefs (
 company_id uuid not null,
 user_id uuid not null,
 prefs jsonb not null default '{}' check (jsonb_typeof(prefs) = 'object'),
 paused_until timestamptz,
 updated_at timestamptz not null default now(),
 primary key (company_id, user_id),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
alter table public.notification_prefs enable row level security;
-- Só pelas funções abaixo.

-- As chaves que existem: um tipo de aviso, ou "status.<status>.<papel>".
create function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;
revoke all on function mavi_private.notification_pref_keys() from public, anon, authenticated;

-- O padrão de quem nunca mexeu: os avisos que já existiam, "tarefa para
-- validar" e Alteração/Correção para o responsável.
create function mavi_private.notification_default(k text) returns boolean
language sql immutable set search_path = '' as $$
 select case when k like 'status.%' then k in ('status.rejected.assignee', 'status.correction.assignee')
  else true end
$$;
revoke all on function mavi_private.notification_default(text) from public, anon, authenticated;

create function mavi_private.wants_notification(c uuid, u uuid, k text) returns boolean
language sql stable security definer set search_path = '' as $$
 select coalesce((select (p.prefs ->> k)::boolean from public.notification_prefs p
  where p.company_id = c and p.user_id = u), mavi_private.notification_default(k))
$$;
revoke all on function mavi_private.wants_notification(uuid, uuid, text) from public, anon, authenticated;

create function mavi_private.notifications_paused(c uuid, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.notification_prefs p
  where p.company_id = c and p.user_id = u and p.paused_until > now())
$$;
revoke all on function mavi_private.notifications_paused(uuid, uuid) from public, anon, authenticated;

-- O que a pessoa recebe hoje (com os padrões preenchidos) e até quando pausou.
create function public.my_notification_prefs(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); p public.notification_prefs; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 select * into p from public.notification_prefs where company_id = p_company and user_id = me;
 return jsonb_build_object(
  'prefs', (select jsonb_object_agg(k, coalesce((p.prefs ->> k)::boolean, mavi_private.notification_default(k)))
   from unnest(mavi_private.notification_pref_keys()) k),
  'paused_until', case when p.paused_until > now() then p.paused_until end);
end $$;
revoke all on function public.my_notification_prefs(uuid) from public, anon;
grant execute on function public.my_notification_prefs(uuid) to authenticated;

-- Grava as escolhas (só chaves conhecidas, com true/false); devolve o estado.
create function public.save_notification_prefs(p_company uuid, p_prefs jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); clean jsonb; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 if jsonb_typeof(p_prefs) <> 'object' then raise exception 'Preferências inválidas'; end if;
 select coalesce(jsonb_object_agg(key, value), '{}') into clean from jsonb_each(p_prefs)
  where key = any(mavi_private.notification_pref_keys()) and jsonb_typeof(value) = 'boolean';
 insert into public.notification_prefs(company_id, user_id, prefs) values (p_company, me, clean)
 on conflict (company_id, user_id) do update
  set prefs = public.notification_prefs.prefs || excluded.prefs, updated_at = now();
 return public.my_notification_prefs(p_company);
end $$;
revoke all on function public.save_notification_prefs(uuid, jsonb) from public, anon;
grant execute on function public.save_notification_prefs(uuid, jsonb) to authenticated;

-- Pausa até a hora dada (null retoma). "Até retomar" é 'infinity'.
create function public.pause_notifications(p_company uuid, p_until timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 insert into public.notification_prefs(company_id, user_id, paused_until)
 values (p_company, me, case when p_until > now() then p_until end)
 on conflict (company_id, user_id) do update
  set paused_until = excluded.paused_until, updated_at = now();
 return public.my_notification_prefs(p_company);
end $$;
revoke all on function public.pause_notifications(uuid, timestamptz) from public, anon;
grant execute on function public.pause_notifications(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------ filtro
-- O tipo desligado não é gravado. "status" já é conferido por papel ao ser
-- criado; o Mural segue as regras do próprio aviso.
create function mavi_private.filter_notification() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.kind in ('notice', 'notice_animation', 'status') then return new; end if;
 if not mavi_private.wants_notification(new.company_id, new.user_id,
  case new.kind when 'tasks_assigned' then 'assigned' else new.kind end) then return null; end if;
 return new;
end $$;
revoke all on function mavi_private.filter_notification() from public, anon, authenticated;
create trigger filter_notification before insert on public.notifications
 for each row execute function mavi_private.filter_notification();

-- ------------------------------------------------------------ status e validação
-- Quem valida a tarefa: o criador, ou os supervisores da equipe quando o
-- projeto pede validação pelo supervisor (como mavi_private.can_approve, sem
-- avisar todos os gestores e administradores, que também podem validar).
create function mavi_private.task_validators(t public.tasks) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct u) filter (where u is not null), '{}') from (
  select t.creator_id u
  where not exists(select 1 from public.projects p where p.company_id = t.company_id
   and p.id = t.project_id and p.requires_review and p.approver = 'supervisor')
  union
  select tm.user_id from public.projects p
  join public.contracts k on k.company_id = t.company_id and k.id = t.contract_id
  join public.team_members tm on tm.company_id = t.company_id and tm.supervisor
  join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
  where p.company_id = t.company_id and p.id = t.project_id and p.requires_review and p.approver = 'supervisor'
   and (tm.team_id = t.team_id or (t.team_id is null and exists(select 1 from public.client_teams ct
    where ct.company_id = k.company_id and ct.client_id = k.client_id and ct.team_id = tm.team_id)))) v
$$;
revoke all on function mavi_private.task_validators(public.tasks) from public, anon, authenticated;

create function mavi_private.notify_task_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); u uuid; roles text[]; verb text; validators uuid[] := '{}'; begin
 if coalesce(current_setting('mavi.bulk_tasks', true), '') = '1' then return null; end if;
 -- Em validação já aprovada internamente só espera o cliente: ninguém valida.
 if new.status = 'review' and new.internal_approved_by is null then
  validators := mavi_private.task_validators(new);
 end if;
 verb := case
  when old.status = 'review' and new.status = 'done' then 'aprovou a entrega'
  when old.status = 'review' and new.status in ('rejected', 'correction')
   then 'reprovou e moveu para ' || mavi_private.status_label(new.status)
  when old.status = 'done' then 'reabriu em ' || mavi_private.status_label(new.status)
  else 'moveu para ' || mavi_private.status_label(new.status) end;
 for u in select distinct x from unnest(mavi_private.task_people(new) || validators) x loop
  continue when u is not distinct from me;
  continue when not exists(select 1 from public.memberships
   where company_id = new.company_id and user_id = u and active);
  if u = any(validators) and mavi_private.wants_notification(new.company_id, u, 'review') then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title)
   values (new.company_id, u, me, new.id, 'review', 'enviou para você validar');
   continue;
  end if;
  roles := array_remove(array[
   case when u = new.creator_id then 'creator' end,
   case when u = new.assignee_id then 'assignee' end,
   case when u <> new.creator_id and u is distinct from new.assignee_id
    and u = any(coalesce(new.participant_ids, '{}')) then 'participant' end], null);
  if exists(select 1 from unnest(roles) r
   where mavi_private.wants_notification(new.company_id, u, 'status.' || new.status || '.' || r)) then
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title)
   values (new.company_id, u, me, new.id, 'status', verb
    || case when u = new.assignee_id and new.assignee_id is distinct from old.assignee_id
        then ' e passou a tarefa para você' else '' end);
  end if;
 end loop;
 return null;
end $$;
revoke all on function mavi_private.notify_task_status() from public, anon, authenticated;
create trigger notify_task_status after update of status on public.tasks
 for each row when (old.status is distinct from new.status)
 execute function mavi_private.notify_task_status();

-- ------------------------------------------------------------ caixa de entrada
-- "headline": o que aconteceu, nos avisos de status e de validação.
drop function public.my_notifications(uuid, integer);
create function public.my_notifications(p_company uuid, p_limit integer default 30)
returns table(id uuid, kind text, task_id uuid, task_title text, actor_id uuid, actor_name text,
 excerpt text, read_at timestamptz, created_at timestamptz, link text, headline text)
language sql stable security definer set search_path = '' as $$
 select n.id, n.kind, n.task_id, coalesce(t.title, n.title), n.actor_id, m.name,
  coalesce(nullif(left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 160), ''), n.body),
  n.read_at, n.created_at, n.link, case when n.task_id is not null then n.title end
 from public.notifications n
 left join public.tasks t on t.company_id = n.company_id and t.id = n.task_id
 left join public.memberships m on m.company_id = n.company_id and m.user_id = n.actor_id
 left join public.comments c on c.id = n.comment_id
 where n.company_id = p_company and n.user_id = auth.uid() and mavi_private.member(p_company)
  and (n.task_id is null or t.id is not null)
 order by n.created_at desc
 limit least(greatest(coalesce(p_limit, 30), 1), 100)
$$;
revoke all on function public.my_notifications(uuid, integer) from public, anon;
grant execute on function public.my_notifications(uuid, integer) to authenticated;

-- ------------------------------------------------------------ push
-- Em pausa, o push não sai (a caixa de entrada continua). Status e validação
-- levam o que aconteceu no título.
create or replace function mavi_private.push_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; subs jsonb; t public.tasks;
 actor text; excerpt text; title text; body text; url text; begin
 select * into cfg from mavi_private.push_config where id;
 if cfg.url is null then return null; end if;
 if mavi_private.notifications_paused(new.company_id, new.user_id) then return null; end if;
 select jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
  'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
  into subs from public.push_subscriptions s where s.user_id = new.user_id;
 if subs is null then return null; end if;
 if new.task_id is null then
  title := new.title;
  body := coalesce(new.body, '');
  url := new.link;
 else
  select * into t from public.tasks where company_id = new.company_id and id = new.task_id;
  select name into actor from public.memberships
   where company_id = new.company_id and user_id = new.actor_id;
  if new.kind = 'assigned' then
   title := 'Nova tarefa para você';
   body := coalesce(actor, 'Alguém') || ' criou: ' || t.title
    || ' · prazo ' || to_char(t.due_date, 'DD/MM');
  elsif new.kind in ('status', 'review') then
   title := coalesce(actor, 'Alguém') || ' ' || new.title;
   body := t.title || ' · prazo ' || to_char(t.due_date, 'DD/MM');
  else
   select left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 140)
    into excerpt from public.comments c where c.id = new.comment_id;
   title := coalesce(actor, 'Alguém') || case when new.kind = 'reply'
    then ' respondeu um comentário' else ' mencionou você' end;
   body := t.title || coalesce(': ' || nullif(excerpt, ''), '');
  end if;
  url := '/tarefas/' || new.task_id;
 end if;
 perform net.http_post(
  url := cfg.url,
  body := jsonb_build_object('subscriptions', subs, 'message', jsonb_build_object(
   'title', title, 'body', body, 'tag', new.id, 'url', url)),
  headers := jsonb_build_object('Content-Type', 'application/json',
   'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 8000);
 return null;
exception when others then
 -- The notification stays in the inbox even if it can't be pushed.
 raise warning 'mavi push failed: %', sqlerrm;
 return null;
end $$;
