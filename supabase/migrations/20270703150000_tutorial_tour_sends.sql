begin;

-- Onboarding: envios agendados (ex.: uma funcionalidade nova, ensinada a um
-- squad no dia do lançamento).
--
-- - Cada onboarding pode ter vários envios, cada um com data e hora e o seu
--   público: todos, papéis, equipes, squads e pessoas, menos as excluídas.
--   O envio dá acesso ao onboarding a quem o recebe, mesmo fora do público
--   do próprio onboarding.
-- - Na data (pg_cron a cada minuto; um envio para "agora" sai ao salvar), o
--   envio é entregue: quem recebe fica em tutorial_tour_send_people e o
--   onboarding começa sozinho para cada pessoa — na hora, se ela estiver
--   usando o sistema (aviso ao vivo; a tela pergunta de novo a lista), ou na
--   próxima vez que entrar. Começar o onboarding (por qualquer caminho) dá
--   o envio como recebido.
-- - Quem já fez: quem cria escolhe por envio ("só quem ainda não fez", o
--   padrão, ou todos do público).
-- - Avisos, por envio: caixa de entrada e/ou notificação do navegador. Para
--   a caixa de entrada sem push, notifications ganha a coluna push (padrão
--   ligado: nada muda para os outros avisos); para o push sem caixa de
--   entrada, mavi_private.tour_push manda só a notificação.
-- - Um onboarding em rascunho espera: o envio sai quando ele for publicado.

-- ------------------------------------------------------------ push opcional
alter table public.notifications add column if not exists push boolean not null default true;
drop trigger push_notification on public.notifications;
create trigger push_notification after insert on public.notifications
 for each row when (new.kind <> 'notice' and new.push) execute function mavi_private.push_notification();

-- Só a notificação do navegador (sem linha na caixa de entrada).
create function mavi_private.tour_push(c uuid, u uuid, p_title text, p_body text, p_url text) returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; subs jsonb; begin
 select * into cfg from mavi_private.push_config where id;
 if cfg.url is null then return; end if;
 if mavi_private.notifications_paused(c, u) then return; end if;
 select jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
  'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
  into subs from public.push_subscriptions s where s.user_id = u;
 if subs is null then return; end if;
 perform net.http_post(
  url := cfg.url,
  body := jsonb_build_object('subscriptions', subs, 'message', jsonb_build_object(
   'title', p_title, 'body', p_body, 'tag', 'tour-' || md5(p_url || u::text), 'url', p_url)),
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 8000);
exception when others then
 raise warning 'mavi tour push failed: %', sqlerrm;
end $$;
revoke all on function mavi_private.tour_push(uuid, uuid, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------ tabelas
create table public.tutorial_tour_sends (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 tour_id uuid not null,
 starts_at timestamptz not null,
 aud_all boolean not null default false,
 aud_roles text[] not null default '{}' check (aud_roles <@ array['admin', 'manager', 'member']::text[]),
 aud_teams uuid[] not null default '{}',
 aud_squads uuid[] not null default '{}',
 aud_users uuid[] not null default '{}',
 aud_exclude uuid[] not null default '{}',
 -- Também quem já fez o onboarding.
 repeat_done boolean not null default false,
 notify_inbox boolean not null default true,
 notify_push boolean not null default true,
 status text not null default 'scheduled' check (status in ('scheduled', 'sent', 'canceled')),
 sent_at timestamptz,
 people integer not null default 0,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(company_id, id),
 foreign key(company_id, tour_id) references public.tutorial_tours(company_id, id) on delete cascade
);
create index tutorial_tour_sends_due on public.tutorial_tour_sends(status, starts_at);
create index tutorial_tour_sends_tour on public.tutorial_tour_sends(company_id, tour_id);
alter table public.tutorial_tour_sends enable row level security;
revoke all on public.tutorial_tour_sends from public, anon, authenticated;

create table public.tutorial_tour_send_people (
 company_id uuid not null,
 send_id uuid not null,
 tour_id uuid not null,
 user_id uuid not null,
 delivered_at timestamptz not null default now(),
 started_at timestamptz,
 primary key(send_id, user_id),
 foreign key(company_id, send_id) references public.tutorial_tour_sends(company_id, id) on delete cascade
);
create index tutorial_tour_send_people_user on public.tutorial_tour_send_people(company_id, user_id, tour_id);
alter table public.tutorial_tour_send_people enable row level security;
revoke all on public.tutorial_tour_send_people from public, anon, authenticated;

-- ------------------------------------------------------------ público
-- O de antes (fase 3) e quem recebeu um envio dele.
create or replace function mavi_private.tour_for_user(t public.tutorial_tours, u uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select t.status = 'published' and u is not null
  and exists (select 1 from public.memberships m where m.company_id = t.company_id and m.user_id = u and m.active)
  and ((not (u = any(t.aud_exclude)) and (
   t.aud_all or u = any(t.aud_users)
   or exists (select 1 from public.memberships m
    where m.company_id = t.company_id and m.user_id = u and m.role = any(t.aud_roles))
   or exists (select 1 from public.team_members tm
    where tm.company_id = t.company_id and tm.user_id = u and tm.team_id = any(t.aud_teams))
   or exists (select 1 from public.cs_squad_members sm
    where sm.company_id = t.company_id and sm.user_id = u and sm.squad_id = any(t.aud_squads))
   or exists (select 1 from public.team_members tm join public.client_teams ct
     on ct.company_id = tm.company_id and ct.team_id = tm.team_id
    where tm.company_id = t.company_id and tm.user_id = u and ct.client_id = any(t.aud_clients))
   or exists (select 1 from public.team_members tm join public.product_teams pt
     on pt.company_id = tm.company_id and pt.team_id = tm.team_id
    where tm.company_id = t.company_id and tm.user_id = u and pt.product_id = any(t.aud_products))))
  or exists (select 1 from public.tutorial_tour_send_people sp where sp.tour_id = t.id and sp.user_id = u))
$$;

-- As pessoas ativas do público de um envio (sem as excluídas).
create function mavi_private.tour_send_people(s public.tutorial_tour_sends) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select m.user_id from public.memberships m
 where m.company_id = s.company_id and m.active and not (m.user_id = any(s.aud_exclude)) and (
  s.aud_all or m.user_id = any(s.aud_users) or m.role = any(s.aud_roles)
  or exists (select 1 from public.team_members tm
   where tm.company_id = s.company_id and tm.user_id = m.user_id and tm.team_id = any(s.aud_teams))
  or exists (select 1 from public.cs_squad_members sm
   where sm.company_id = s.company_id and sm.user_id = m.user_id and sm.squad_id = any(s.aud_squads)))
$$;
revoke all on function mavi_private.tour_send_people(public.tutorial_tour_sends) from public, anon, authenticated;

-- ------------------------------------------------------------ entregar
-- Entrega um envio vencido de um onboarding publicado. Devolve quantas
-- pessoas receberam (nulo: ainda não era hora ou o onboarding não está no ar).
create function mavi_private.tour_send_deliver(p_send uuid) returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.tutorial_tour_sends; t public.tutorial_tours; v_users uuid[]; v_title text; v_body text; v_link text;
 u uuid; begin
 select * into s from public.tutorial_tour_sends where id = p_send for update;
 if not found or s.status <> 'scheduled' or s.starts_at > now() then return null; end if;
 select * into t from public.tutorial_tours where id = s.tour_id;
 if t.status <> 'published' or jsonb_array_length(t.steps) = 0 then return null; end if;

 with ins as (
  insert into public.tutorial_tour_send_people(company_id, send_id, tour_id, user_id)
  select s.company_id, s.id, s.tour_id, p.u from mavi_private.tour_send_people(s) p(u)
  where s.repeat_done or not exists (select 1 from public.tutorial_tour_progress pr
   where pr.tour_id = s.tour_id and pr.user_id = p.u and (pr.status = 'completed' or pr.times_completed > 0))
  on conflict do nothing
  returning user_id)
 select coalesce(array_agg(user_id), '{}') into v_users from ins;

 v_title := left('Novidade: ' || t.title, 300);
 v_body := left(coalesce(nullif(t.summary, ''), 'Um tour guiado de ' || jsonb_array_length(t.steps) || ' passos pelas telas do sistema.'), 500);
 v_link := '/tutoriais?aba=onboarding&iniciar=' || t.id;
 if s.notify_inbox then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link, push)
  select s.company_id, x, s.created_by, null, 'tutorial', v_title, v_body, v_link, s.notify_push
  from unnest(v_users) x;
 elsif s.notify_push then
  foreach u in array v_users loop
   perform mavi_private.tour_push(s.company_id, u, v_title, v_body, v_link);
  end loop;
 end if;

 update public.tutorial_tour_sends set status = 'sent', sent_at = now(), people = cardinality(v_users), updated_at = now()
 where id = s.id;
 -- A tela de quem está no sistema pergunta de novo os seus automáticos.
 perform mavi_private.broadcast(s.company_id, jsonb_build_object('kind', 'tutorials', 'send', s.id));
 return cardinality(v_users);
end $$;

-- A cada minuto: os envios que chegaram à hora.
create function mavi_private.tutorial_tour_sends_run() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0; begin
 for r in select x.id from public.tutorial_tour_sends x where x.status = 'scheduled' and x.starts_at <= now()
  order by x.starts_at limit 200 loop
  if mavi_private.tour_send_deliver(r.id) is not null then n := n + 1; end if;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.tour_send_deliver(uuid), mavi_private.tutorial_tour_sends_run()
 from public, anon, authenticated;

-- Começar o onboarding (por qualquer caminho) dá os envios dele como recebidos.
create function mavi_private.tour_send_started() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 update public.tutorial_tour_send_people set started_at = now()
 where tour_id = new.tour_id and user_id = new.user_id and started_at is null and delivered_at <= now();
 return null;
end $$;
revoke all on function mavi_private.tour_send_started() from public, anon, authenticated;
create trigger tour_send_started after insert or update on public.tutorial_tour_progress
 for each row execute function mavi_private.tour_send_started();

-- ------------------------------------------------------------ salvar e ler
-- Cria ou altera um envio ainda agendado. p_content: {starts_at, aud_all,
-- aud_roles, aud_teams, aud_squads, aud_users, aud_exclude, repeat_done,
-- notify_inbox, notify_push}. Um envio para agora (ou no passado) sai na hora.
create function public.save_tutorial_tour_send(p_tour uuid, p_send uuid, p_content jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorial_tours; s public.tutorial_tour_sends; v_at timestamptz; v_all boolean; v_roles text[];
 v_teams uuid[]; v_squads uuid[]; v_users uuid[]; v_exclude uuid[]; v_people integer; begin
 select * into t from public.tutorial_tours where id = p_tour;
 if not found or not mavi_private.tour_can_edit(t) then
  raise exception 'Só um administrador ou o gestor que criou o onboarding agenda envios.' using errcode = '42501';
 end if;
 if jsonb_typeof(p_content) <> 'object' then raise exception 'Conteúdo inválido' using errcode = '22023'; end if;
 begin v_at := (p_content->>'starts_at')::timestamptz;
 exception when others then raise exception 'Escolha a data e a hora do envio.' using errcode = '22023'; end;
 if v_at is null then raise exception 'Escolha a data e a hora do envio.' using errcode = '22023'; end if;
 if v_at > now() + interval '1 year' then raise exception 'Agende até um ano à frente.' using errcode = '22023'; end if;
 v_all := coalesce((p_content->>'aud_all')::boolean, false);
 v_roles := array(select distinct r from jsonb_array_elements_text(
  case when jsonb_typeof(p_content->'aud_roles') = 'array' then p_content->'aud_roles' else '[]' end) r
  where r in ('admin', 'manager', 'member') order by r);
 v_teams := mavi_private.tour_ids(t.company_id, p_content->'aud_teams', 'teams');
 v_squads := mavi_private.tour_ids(t.company_id, p_content->'aud_squads', 'cs_squads');
 v_users := array(select m.user_id from public.memberships m where m.company_id = t.company_id and m.user_id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p_content->'aud_users') = 'array' then p_content->'aud_users' else '[]' end))
  order by m.user_id);
 v_exclude := array(select m.user_id from public.memberships m where m.company_id = t.company_id and m.user_id::text in (
  select jsonb_array_elements_text(case when jsonb_typeof(p_content->'aud_exclude') = 'array' then p_content->'aud_exclude' else '[]' end))
  order by m.user_id);
 if v_all then v_roles := '{}'; v_teams := '{}'; v_squads := '{}'; v_users := '{}'; end if;
 if not v_all and cardinality(v_roles) + cardinality(v_teams) + cardinality(v_squads) + cardinality(v_users) = 0 then
  raise exception 'Escolha para quem é o envio: todos, papéis, equipes, squads ou pessoas.' using errcode = '22023';
 end if;

 if p_send is null then
  insert into public.tutorial_tour_sends(company_id, tour_id, starts_at, created_by)
  values (t.company_id, t.id, v_at, auth.uid()) returning * into s;
 else
  select * into s from public.tutorial_tour_sends where id = p_send and tour_id = t.id for update;
  if not found then raise exception 'Envio não encontrado' using errcode = 'P0002'; end if;
  if s.status <> 'scheduled' then raise exception 'Este envio já saiu ou foi cancelado.' using errcode = '22023'; end if;
 end if;
 update public.tutorial_tour_sends set starts_at = v_at, aud_all = v_all, aud_roles = v_roles, aud_teams = v_teams,
  aud_squads = v_squads, aud_users = v_users, aud_exclude = v_exclude,
  repeat_done = coalesce((p_content->>'repeat_done')::boolean, false),
  notify_inbox = coalesce((p_content->>'notify_inbox')::boolean, true),
  notify_push = coalesce((p_content->>'notify_push')::boolean, true), updated_at = now()
 where id = s.id;
 v_people := mavi_private.tour_send_deliver(s.id);
 select * into s from public.tutorial_tour_sends where id = s.id;
 return jsonb_build_object('id', s.id, 'status', s.status, 'people', case when s.status = 'sent' then s.people end,
  'waiting', s.status = 'scheduled' and s.starts_at <= now());
end $$;

create function public.cancel_tutorial_tour_send(p_send uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare s public.tutorial_tour_sends; t public.tutorial_tours; begin
 select * into s from public.tutorial_tour_sends where id = p_send for update;
 if not found then raise exception 'Envio não encontrado' using errcode = 'P0002'; end if;
 select * into t from public.tutorial_tours where id = s.tour_id;
 if not mavi_private.tour_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if s.status <> 'scheduled' then raise exception 'Este envio já saiu.' using errcode = '22023'; end if;
 update public.tutorial_tour_sends set status = 'canceled', updated_at = now() where id = s.id;
end $$;

-- Os envios de um onboarding (quem edita), com quantos começaram e concluíram.
create function public.tutorial_tour_sends(p_tour uuid)
returns table(id uuid, starts_at timestamptz, aud_all boolean, aud_roles text[], aud_teams uuid[], aud_squads uuid[],
 aud_users uuid[], aud_exclude uuid[], repeat_done boolean, notify_inbox boolean, notify_push boolean, status text,
 sent_at timestamptz, people integer, started integer, completed integer, created_by_name text)
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorial_tours; begin
 select * into t from public.tutorial_tours x where x.id = p_tour;
 if not found or not mavi_private.tour_can_edit(t) then return; end if;
 return query
 select s.id, s.starts_at, s.aud_all, s.aud_roles, s.aud_teams, s.aud_squads, s.aud_users, s.aud_exclude,
  s.repeat_done, s.notify_inbox, s.notify_push, s.status, s.sent_at, s.people,
  (select count(*)::integer from public.tutorial_tour_send_people p where p.send_id = s.id and p.started_at is not null),
  (select count(*)::integer from public.tutorial_tour_send_people p
   join public.tutorial_tour_progress pr on pr.tour_id = p.tour_id and pr.user_id = p.user_id
   where p.send_id = s.id and pr.completed_at >= p.delivered_at),
  mavi_private.member_name(s.company_id, s.created_by)
 from public.tutorial_tour_sends s where s.tour_id = t.id
 order by (s.status = 'scheduled') desc, s.starts_at desc;
end $$;

-- Os automáticos da pessoa: os de antes (fase 3) e os envios recebidos
-- ainda não começados (send_id).
drop function public.my_auto_tutorial_tours(uuid);
create function public.my_auto_tutorial_tours(p_company uuid)
returns table(id uuid, title text, start_page text, trg_visit boolean, trg_login boolean, screen_only boolean,
 send_id uuid)
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then return; end if;
 return query
 (select t.id, t.title, t.start_page, false, false, false, sp.send_id
  from public.tutorial_tour_send_people sp
  join public.tutorial_tours t on t.id = sp.tour_id
  join public.tutorial_tour_sends s on s.id = sp.send_id
  where sp.company_id = p_company and sp.user_id = auth.uid() and sp.started_at is null and s.status = 'sent'
   and t.status = 'published' and jsonb_array_length(t.steps) > 0
  order by sp.delivered_at
  limit 20)
 union all
 (select t.id, t.title, t.start_page, t.trg_visit, t.trg_login,
   cardinality(t.scr_clients) + cardinality(t.scr_products) > 0, null::uuid
  from public.tutorial_tours t
  where t.company_id = p_company and t.status = 'published' and (t.trg_visit or t.trg_login)
   and jsonb_array_length(t.steps) > 0 and mavi_private.tour_for_me(t)
   and not exists (select 1 from public.tutorial_tour_progress p where p.tour_id = t.id and p.user_id = auth.uid())
  order by t.published_at, t.id
  limit 50);
end $$;

revoke all on function public.save_tutorial_tour_send(uuid, uuid, jsonb), public.cancel_tutorial_tour_send(uuid),
 public.tutorial_tour_sends(uuid), public.my_auto_tutorial_tours(uuid) from public, anon, authenticated;
grant execute on function public.save_tutorial_tour_send(uuid, uuid, jsonb), public.cancel_tutorial_tour_send(uuid),
 public.tutorial_tour_sends(uuid), public.my_auto_tutorial_tours(uuid) to authenticated;

-- ------------------------------------------------------------ agendamento
-- O PostgreSQL dos testes não tem pg_cron.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-tutorial-tour-sends', '* * * * *', 'select mavi_private.tutorial_tour_sends_run()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.tutorial_tour_sends_run() on the hosted database';
 end if;
end $$;

notify pgrst, 'reload schema';

commit;
