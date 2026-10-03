begin;

-- Planejamento › Social Media: a etapa "Agendamento", entre a Produção e a
-- Campanha (só no Social Media; o Social Leads segue igual).
--
-- - Entram os posts aprovados com arte, inclusive o que vira anúncio.
-- - Cada post agendado tem data e hora (no fuso da empresa), os destinos
--   (Instagram — feed, carrossel ou Reels conforme a arte —, Stories e a
--   Página do Facebook), a legenda (a do plano, ou uma só do agendamento), o
--   primeiro comentário e a capa do Reels.
-- - A MAVI sugere as datas (api/_social-leads.ts, ação "schedule", com o
--   contexto de social_media_schedule_context); a equipe ajusta e confirma.
-- - Na hora marcada o pg_cron (mavi-social-media-schedules, a cada minuto)
--   avisa quem agendou, quem fez a arte e a equipe de criação do cliente:
--   arte e legenda prontas para publicar à mão, e "Marcar como publicado".
--   A publicação automática pelo Meta (app próprio, sem tocar na conexão das
--   Campanhas) entra numa próxima fase, no mesmo lugar.
-- - O link de aprovação mostra o calendário só para ver (datas, status e o
--   link do post publicado); cada cliente liga ou desliga
--   (social_media_accounts.link_calendar, ligado por padrão).
-- - Agendar, cancelar e publicar entram no histórico do post.
-- - A sugestão da MAVI é a funcionalidade 'social_media_schedule' em Quem usa
--   qual modelo.

-- ------------------------------------------------------------ tabelas
-- O que vale para o cliente inteiro no Social Media (a conexão do Meta vem
-- para cá na fase da publicação automática).
create table public.social_media_accounts (
 company_id uuid not null,
 contract_id uuid not null,
 link_calendar boolean not null default true,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 primary key (company_id, contract_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id) on delete cascade
);

create table public.social_media_schedules (
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid not null,
 number integer not null,
 scheduled_at timestamptz not null,
 destinations text[] not null check (cardinality(destinations) between 1 and 3
  and destinations <@ array['instagram', 'story', 'facebook']::text[]),
 -- null: a legenda do plano (acompanha as edições do post).
 caption text check (caption is null or length(caption) <= 2200),
 first_comment text not null default '' check (length(first_comment) <= 2200),
 -- {"art": "<id da arte>"} ou {"seconds": n} (capa do Reels).
 cover jsonb check (cover is null or jsonb_typeof(cover) = 'object'),
 -- scheduled: esperando a hora · due: a hora chegou, falta publicar ·
 -- published: publicado · failed: não deu para publicar (motivo em error).
 status text not null default 'scheduled' check (status in ('scheduled', 'due', 'published', 'failed')),
 reminded_at timestamptz,
 published_at timestamptz,
 published_url text check (published_url is null or length(published_url) <= 500),
 published_via text check (published_via in ('manual', 'meta')),
 published_by uuid,
 error text check (error is null or length(error) <= 1000),
 scheduled_by uuid not null default auth.uid(),
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (plan_id, number),
 foreign key (plan_id, number) references public.social_leads_posts(plan_id, number) on delete cascade,
 foreign key (company_id, plan_id) references public.social_leads_plans(company_id, id) on delete cascade,
 check ((status = 'published') = (published_at is not null))
);
create index social_media_schedules_due on public.social_media_schedules(scheduled_at) where status = 'scheduled';
create index social_media_schedules_contract on public.social_media_schedules(company_id, contract_id);

alter table public.social_media_accounts enable row level security;
alter table public.social_media_schedules enable row level security;
revoke all on public.social_media_accounts, public.social_media_schedules from anon, authenticated;
grant select on public.social_media_accounts, public.social_media_schedules to authenticated;
create policy social_media_accounts_read on public.social_media_accounts for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));
create policy social_media_schedules_read on public.social_media_schedules for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));

-- Ao vivo, como o resto do módulo.
create trigger broadcast_social_leads after insert or update or delete on public.social_media_accounts
 for each row execute function mavi_private.broadcast_social_leads();
create trigger broadcast_social_leads after insert or update or delete on public.social_media_schedules
 for each row execute function mavi_private.broadcast_social_leads();

-- O histórico do post ganha o agendamento.
alter table public.social_leads_post_events drop constraint if exists social_leads_post_events_kind_check;
alter table public.social_leads_post_events add constraint social_leads_post_events_kind_check
 check (kind in ('created', 'approved', 'rejected', 'reopened', 'edited', 'arts', 'task', 'comment',
  'scheduled', 'unscheduled', 'published'));

-- O custo da sugestão de datas entra no custo da MAVI do plano.
alter table public.social_leads_ai_usage drop constraint if exists social_leads_ai_usage_kind_check;
alter table public.social_leads_ai_usage add constraint social_leads_ai_usage_kind_check
 check (kind in ('generate', 'adjust', 'colors', 'briefing', 'schedule'));

-- ------------------------------------------------------------ ajudantes
create function mavi_private.company_tz(c uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select nullif(timezone, '') from public.companies where id = c), 'America/Sao_Paulo')
$$;
revoke all on function mavi_private.company_tz(uuid) from public, anon, authenticated;

-- O plano, conferido: existe, é do Social Media e quem chama pode gravar.
create function mavi_private.social_media_plan(p_plan uuid) returns public.social_leads_plans
language plpgsql stable security definer set search_path = '' as $$
declare p public.social_leads_plans; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if mavi_private.social_leads_module_of(p.company_id, p.contract_id) <> 'social_media' then
  raise exception 'O agendamento é do Social Media.' using errcode = '22023';
 end if;
 return p;
end $$;
revoke all on function mavi_private.social_media_plan(uuid) from public, anon, authenticated;

create function mavi_private.social_media_event(s public.social_media_schedules, p_kind text, p_note text,
 p_detail jsonb) returns void
language sql security definer set search_path = '' as $$
 insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id,
  actor_name, note, detail)
 values (s.company_id, s.contract_id, s.plan_id, s.number, p_kind, 'team', auth.uid(),
  mavi_private.social_leads_person(s.company_id, auth.uid()), left(coalesce(p_note, ''), 2000), coalesce(p_detail, '{}'))
$$;
revoke all on function mavi_private.social_media_event(public.social_media_schedules, text, text, jsonb)
 from public, anon, authenticated;

-- ------------------------------------------------------------ agendar
-- p_items: [{number, at: "AAAA-MM-DDTHH:MM" (fuso da empresa), destinations,
-- caption (null = a do plano), first_comment, cover}]. Grava tudo ou nada.
create function public.social_media_schedule_save(p_plan uuid, p_items jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; i jsonb; x public.social_leads_posts; o public.social_media_schedules;
 s public.social_media_schedules; num integer; at_text text; at timestamptz; dest text[]; cap text; com text;
 cov jsonb; st text; tz text; n integer := 0; begin
 p := mavi_private.social_media_plan(p_plan);
 if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 16 then
  raise exception 'Nada para agendar.' using errcode = '22023';
 end if;
 tz := mavi_private.company_tz(p.company_id);
 for i in select value from jsonb_array_elements(p_items) loop
  if jsonb_typeof(i) <> 'object' or jsonb_typeof(i->'number') <> 'number' then
   raise exception 'Agendamento inválido.' using errcode = '22023';
  end if;
  num := (i->>'number')::integer;
  select * into x from public.social_leads_posts where plan_id = p.id and number = num for update;
  if not found then raise exception 'Post % não encontrado.', num using errcode = 'P0002'; end if;
  if x.decision <> 'approved' then
   raise exception 'Post %: só posts aprovados entram no agendamento.', num using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(x.arts, '[]')) = 0 then
   raise exception 'Post %: envie a arte antes de agendar.', num using errcode = '22023';
  end if;
  at_text := i->>'at';
  if coalesce(at_text, '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$' then
   raise exception 'Post %: data e hora inválidas.', num using errcode = '22023';
  end if;
  begin
   at := (replace(at_text, 'T', ' ')::timestamp) at time zone tz;
  exception when others then
   raise exception 'Post %: data e hora inválidas.', num using errcode = '22023';
  end;
  if jsonb_typeof(i->'destinations') <> 'array' then
   raise exception 'Post %: escolha onde publicar.', num using errcode = '22023';
  end if;
  select array_agg(distinct d order by d) into dest from jsonb_array_elements_text(i->'destinations') d;
  if dest is null or not dest <@ array['instagram', 'story', 'facebook']::text[] then
   raise exception 'Post %: escolha onde publicar.', num using errcode = '22023';
  end if;
  cap := case when jsonb_typeof(i->'caption') = 'string' then i->>'caption' end;
  if length(cap) > 2200 then
   raise exception 'Post %: a legenda passou de 2.200 caracteres (limite do Instagram).', num using errcode = '22023';
  end if;
  com := coalesce(case when jsonb_typeof(i->'first_comment') = 'string' then trim(i->>'first_comment') end, '');
  if length(com) > 2200 then
   raise exception 'Post %: o primeiro comentário passou de 2.200 caracteres.', num using errcode = '22023';
  end if;
  cov := case when jsonb_typeof(i->'cover') = 'object' then i->'cover' end;
  if cov is not null and not coalesce(
   (jsonb_typeof(cov->'art') = 'string' and exists (select 1 from jsonb_array_elements(x.arts) a where a->>'id' = cov->>'art'))
   or (jsonb_typeof(cov->'seconds') = 'number' and (cov->>'seconds')::numeric between 0 and 900), false) then
   raise exception 'Post %: capa do Reels inválida.', num using errcode = '22023';
  end if;
  select * into o from public.social_media_schedules where plan_id = p.id and number = num for update;
  if found and o.status = 'published' then
   raise exception 'Post % já foi publicado.', num using errcode = '22023';
  end if;
  -- Hora nova (ou de novo depois de uma falha): volta a esperar a hora.
  st := case when not found or o.scheduled_at <> at or o.status = 'failed' then 'scheduled' else o.status end;
  if st = 'scheduled' and at < now() + interval '1 minute' then
   raise exception 'Post %: escolha uma data e hora no futuro.', num using errcode = '22023';
  end if;
  insert into public.social_media_schedules(company_id, contract_id, plan_id, number, scheduled_at, destinations,
   caption, first_comment, cover, status, scheduled_by, updated_by)
  values (p.company_id, p.contract_id, p.id, num, at, dest, cap, com, cov, st, auth.uid(), auth.uid())
  on conflict (plan_id, number) do update set scheduled_at = excluded.scheduled_at,
   destinations = excluded.destinations, caption = excluded.caption, first_comment = excluded.first_comment,
   cover = excluded.cover, status = excluded.status,
   reminded_at = case when excluded.status = 'scheduled' then null else social_media_schedules.reminded_at end,
   error = case when excluded.status = 'scheduled' then null else social_media_schedules.error end,
   updated_by = auth.uid(), updated_at = now()
  returning * into s;
  if o.plan_id is null or o.scheduled_at <> s.scheduled_at or o.destinations <> s.destinations then
   perform mavi_private.social_media_event(s, 'scheduled', '', jsonb_build_object(
    'at', s.scheduled_at, 'previous', o.scheduled_at, 'destinations', to_jsonb(s.destinations)));
  end if;
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function public.social_media_schedule_save(uuid, jsonb) from public, anon;
grant execute on function public.social_media_schedule_save(uuid, jsonb) to authenticated;

create function public.social_media_schedule_cancel(p_plan uuid, p_number integer) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_media_schedules; begin
 p := mavi_private.social_media_plan(p_plan);
 delete from public.social_media_schedules where plan_id = p.id and number = p_number and status <> 'published'
 returning * into s;
 if not found then
  raise exception 'Agendamento não encontrado (ou o post já foi publicado).' using errcode = 'P0002';
 end if;
 perform mavi_private.social_media_event(s, 'unscheduled', '', jsonb_build_object('at', s.scheduled_at));
end $$;
revoke all on function public.social_media_schedule_cancel(uuid, integer) from public, anon;
grant execute on function public.social_media_schedule_cancel(uuid, integer) to authenticated;

-- Publicado à mão (com o link do post, opcional) ou desfeito.
create function public.social_media_schedule_published(p_plan uuid, p_number integer, p_published boolean,
 p_url text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_media_schedules; u text := nullif(trim(coalesce(p_url, '')), ''); begin
 p := mavi_private.social_media_plan(p_plan);
 if u is not null and (u !~* '^https://[^\s]+$' or length(u) > 500) then
  raise exception 'O link do post precisa começar com https://.' using errcode = '22023';
 end if;
 select * into s from public.social_media_schedules where plan_id = p.id and number = p_number for update;
 if not found then raise exception 'Agendamento não encontrado.' using errcode = 'P0002'; end if;
 if p_published then
  update public.social_media_schedules set status = 'published', published_at = coalesce(published_at, now()),
   published_url = coalesce(u, published_url), published_via = coalesce(published_via, 'manual'),
   published_by = coalesce(published_by, auth.uid()), error = null, updated_by = auth.uid(), updated_at = now()
  where plan_id = p.id and number = p_number returning * into s;
  perform mavi_private.social_media_event(s, 'published', '', jsonb_build_object('url', s.published_url,
   'via', s.published_via));
 elsif s.status = 'published' then
  if s.published_via = 'meta' then
   raise exception 'Publicado pelo Meta: para tirar do ar, apague o post na rede.' using errcode = '22023';
  end if;
  update public.social_media_schedules set status = case when scheduled_at <= now() then 'due' else 'scheduled' end,
   published_at = null, published_url = null, published_via = null, published_by = null,
   updated_by = auth.uid(), updated_at = now()
  where plan_id = p.id and number = p_number returning * into s;
  perform mavi_private.social_media_event(s, 'published', 'desfeito', jsonb_build_object('undone', true));
 end if;
end $$;
revoke all on function public.social_media_schedule_published(uuid, integer, boolean, text) from public, anon;
grant execute on function public.social_media_schedule_published(uuid, integer, boolean, text) to authenticated;

create function public.social_media_set_link_calendar(p_contract uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 select company_id into c from public.contracts where id = p_contract;
 if c is null or not mavi_private.social_leads_can_write(c, p_contract) then
  raise exception 'Cliente não encontrado.' using errcode = 'P0002';
 end if;
 if mavi_private.social_leads_module_of(c, p_contract) <> 'social_media' then
  raise exception 'O agendamento é do Social Media.' using errcode = '22023';
 end if;
 insert into public.social_media_accounts(company_id, contract_id, link_calendar, updated_by)
 values (c, p_contract, coalesce(p_enabled, true), auth.uid())
 on conflict (company_id, contract_id) do update set link_calendar = excluded.link_calendar,
  updated_by = excluded.updated_by, updated_at = now();
end $$;
revoke all on function public.social_media_set_link_calendar(uuid, boolean) from public, anon;
grant execute on function public.social_media_set_link_calendar(uuid, boolean) to authenticated;

-- ------------------------------------------------------------ sugestão da MAVI
-- O que a MAVI lê para sugerir as datas (chamada pelo servidor com o login de
-- quem pediu).
create function public.social_media_schedule_context(p_company uuid, p_contract uuid, p_plan uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.social_leads_plans; b public.social_leads_briefings; client text; tz text; begin
 p := mavi_private.social_media_plan(p_plan);
 if p.company_id <> p_company or p.contract_id <> p_contract then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 tz := mavi_private.company_tz(p.company_id);
 select * into b from public.social_leads_briefings where company_id = p.company_id and contract_id = p.contract_id;
 select c.name into client from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p.company_id and k.id = p.contract_id;
 return jsonb_build_object(
  'client_name', coalesce(nullif(b.fields->>'clientName', ''), client),
  'briefing', coalesce(b.fields, '{}'),
  'label', p.label,
  'timezone', tz,
  'now', to_char(now() at time zone tz, 'YYYY-MM-DD"T"HH24:MI'),
  'weekday', to_char(now() at time zone tz, 'ID'),
  'posts', coalesce((select jsonb_agg(jsonb_build_object('numero', x.number, 'pilar', x.pillar, 'gancho', x.hook,
    'formato', x.format, 'cta', x.cta, 'ehAnuncio', x.is_ad,
    'artes', jsonb_array_length(x.arts),
    'video', exists (select 1 from jsonb_array_elements(x.arts) a where a->>'type' like 'video/%'),
    'agendado', (select to_char(s.scheduled_at at time zone tz, 'YYYY-MM-DD"T"HH24:MI')
     from public.social_media_schedules s where s.plan_id = x.plan_id and s.number = x.number),
    'publicado', exists (select 1 from public.social_media_schedules s where s.plan_id = x.plan_id
     and s.number = x.number and s.status = 'published')) order by x.number)
   from public.social_leads_posts x where x.plan_id = p.id and x.decision = 'approved'
    and jsonb_array_length(x.arts) > 0), '[]'),
  -- Os outros agendamentos do cliente (outros meses), para não amontoar.
  'outros', coalesce((select jsonb_agg(to_char(s.scheduled_at at time zone tz, 'YYYY-MM-DD"T"HH24:MI')
    order by s.scheduled_at)
   from public.social_media_schedules s where s.company_id = p.company_id and s.contract_id = p.contract_id
    and s.plan_id <> p.id and s.scheduled_at > now() - interval '7 days'), '[]'));
end $$;
revoke all on function public.social_media_schedule_context(uuid, uuid, uuid) from public, anon;
grant execute on function public.social_media_schedule_context(uuid, uuid, uuid) to authenticated;

-- ------------------------------------------------------------ na hora marcada
-- Quem é avisado: quem agendou, quem mexeu por último, quem fez a arte e a
-- equipe de criação do módulo (ou o squad) que atende o cliente.
create function mavi_private.social_media_schedule_people(s public.social_media_schedules) returns setof uuid
language sql stable security definer set search_path = '' as $$
 select distinct u from (
  select s.scheduled_by as u
  union select s.updated_by
  union select t.assignee_id from public.social_leads_posts x
   join public.tasks t on t.company_id = x.company_id and t.id = x.task_id
   where x.plan_id = s.plan_id and x.number = s.number
  union select tm.user_id from public.contracts k
   join public.social_leads_settings st on st.company_id = k.company_id and st.product_id = k.product_id
   join public.client_teams ct on ct.company_id = k.company_id and ct.client_id = k.client_id
    and ct.team_id = coalesce(st.design_team_id, st.team_id)
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where k.company_id = s.company_id and k.id = s.contract_id
 ) w
 where u is not null and exists (select 1 from public.memberships m
  where m.company_id = s.company_id and m.user_id = w.u and m.active)
$$;
revoke all on function mavi_private.social_media_schedule_people(public.social_media_schedules) from public, anon, authenticated;

create function mavi_private.social_media_run_schedules() returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.social_media_schedules; x public.social_leads_posts; p public.social_leads_plans; client text;
 err text; who uuid; link text; n integer := 0; begin
 for s in select * from public.social_media_schedules where status = 'scheduled' and scheduled_at <= now()
  order by scheduled_at limit 200 for update skip locked loop
  select * into x from public.social_leads_posts where plan_id = s.plan_id and number = s.number;
  select * into p from public.social_leads_plans where id = s.plan_id;
  err := case when x.decision <> 'approved' then 'O post não está mais aprovado.'
   when jsonb_array_length(coalesce(x.arts, '[]')) = 0 then 'O post ficou sem arte.' end;
  update public.social_media_schedules set status = case when err is null then 'due' else 'failed' end,
   reminded_at = now(), error = err, updated_at = now()
  where plan_id = s.plan_id and number = s.number;
  select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
  from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
  left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
  where k.company_id = s.company_id and k.id = s.contract_id;
  link := mavi_private.social_leads_module_path('social_media') || '?contrato=' || s.contract_id
   || '&mes=' || p.month_number || '&secao=agendamento&post=' || s.number;
  for who in select mavi_private.social_media_schedule_people(s) loop
   insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
   values (s.company_id, who, null, null, 'social_leads',
    case when err is null then format('Hora de publicar o post %s de %s', s.number, client)
     else format('O post %s de %s não pode ser publicado', s.number, client) end,
    case when err is null then format('%s · arte e legenda prontas no Agendamento. Publique e marque como publicado.', p.label)
     else err || ' Ajuste e agende de novo.' end,
    link);
  end loop;
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.social_media_run_schedules() from public, anon, authenticated;

do $$ begin
 if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-social-media-schedules', '* * * * *',
   'select mavi_private.social_media_run_schedules()');
 else
  raise notice 'pg_cron unavailable: social_media_run_schedules must be scheduled on the hosted database';
 end if;
end $$;

-- ------------------------------------------------------------ carteira
-- A da migração 20261210090000, com agendados e publicados no plano.
create or replace function public.social_leads_portfolio(p_company uuid, p_module text default 'social_leads') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m text := mavi_private.social_leads_valid_module(p_module); s public.social_leads_settings;
 leader boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 select * into s from public.social_leads_settings where company_id = p_company and module = m;
 if not found then return jsonb_build_object('configured', false, 'module', m, 'items', '[]'::jsonb); end if;
 leader := mavi_private.leader(p_company);
 return jsonb_build_object('configured', true, 'module', m, 'product_id', s.product_id, 'team_id', s.team_id,
  'design_team_id', s.design_team_id, 'art_days', s.art_days, 'items', coalesce((
  select jsonb_agg(jsonb_build_object(
   'contract_id', k.id, 'contract_name', k.name, 'client_id', cl.id, 'client_name', cl.name, 'client_color', cl.color,
   'contract_created_at', k.created_at,
   'can_write', mavi_private.social_leads_can_write(k.company_id, k.id),
   'briefing', (select jsonb_build_object('fields', b.fields, 'campaign_objective', b.campaign_objective,
     'responsible_id', b.responsible_id, 'updated_at', b.updated_at)
    from public.social_leads_briefings b where b.company_id = k.company_id and b.contract_id = k.id),
   'plan_count', (select count(*) from public.social_leads_plans p where p.company_id = k.company_id and p.contract_id = k.id),
   'plan', (select jsonb_build_object('id', p.id, 'month_number', p.month_number, 'label', p.label,
     'created_at', p.created_at, 'updated_at', p.updated_at, 'share_enabled', p.share_enabled, 'shared_at', p.shared_at,
     'alerts', jsonb_array_length(coalesce(p.content->'alertas', '[]')),
     'alerts_unread', (select count(*) from jsonb_array_elements_text(coalesce(p.content->'alertas', '[]')) a
      where not exists (select 1 from public.social_leads_alert_reads r where r.plan_id = p.id and r.alert_hash = md5(a))),
     'first_alert', p.content->'alertas'->>0,
     'posts', (select count(*) from public.social_leads_posts x where x.plan_id = p.id),
     'approved', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and x.decision = 'approved'),
     'rejected', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and x.decision = 'rejected'),
     'last_decision_at', (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id),
     'tasks', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and x.task_id is not null),
     'arts', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and jsonb_array_length(x.arts) > 0),
     'scheduled', (select count(*) from public.social_media_schedules z where z.plan_id = p.id),
     'published', (select count(*) from public.social_media_schedules z where z.plan_id = p.id and z.status = 'published'),
     'due', (select count(*) from public.social_media_schedules z where z.plan_id = p.id and z.status in ('due', 'failed')))
    from public.social_leads_plans p where p.company_id = k.company_id and p.contract_id = k.id
    order by p.month_number desc limit 1),
   'job', (select jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'error', j.error,
     'created_at', j.created_at, 'finished_at', j.finished_at)
    from public.social_leads_jobs j where j.company_id = k.company_id and j.contract_id = k.id
    order by j.created_at desc limit 1),
   -- Campanhas é dos líderes: os demais só sabem se está no ar.
   'campaign', (select jsonb_build_object('id', case when leader then c.id end, 'name', case when leader then c.name end,
     'active', c.status = 'active')
    from public.ad_campaigns c join public.contracts ck on ck.company_id = c.company_id and ck.id = c.contract_id
    where c.company_id = k.company_id and ck.client_id = k.client_id and c.platform = 'meta' and not c.archived
    order by (c.status = 'active') desc, (c.contract_id = k.id) desc, c.created_at desc limit 1)
  ) order by cl.name, k.name)
  from public.contracts k
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  where k.company_id = p_company and k.product_id = s.product_id and not k.archived and not cl.archived
   and mavi_private.contract_read(k.company_id, k.id)
 ), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------ link do cliente
-- A da migração 20261121090000, com o calendário (Social Media, quando ligado).
create or replace function public.social_leads_shared_plan(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.social_leads_plans; b public.social_leads_briefings; cl text; co public.companies;
 cal boolean; begin
 select * into p from public.social_leads_plans where share_token = p_token and share_enabled;
 if not found then raise exception 'Link inválido ou desativado.' using errcode = 'P0002'; end if;
 select * into b from public.social_leads_briefings where company_id = p.company_id and contract_id = p.contract_id;
 select c.name into cl from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p.company_id and k.id = p.contract_id;
 select * into co from public.companies where id = p.company_id;
 cal := mavi_private.social_leads_module_of(p.company_id, p.contract_id) = 'social_media'
  and coalesce((select a.link_calendar from public.social_media_accounts a
   where a.company_id = p.company_id and a.contract_id = p.contract_id), true);
 return jsonb_build_object(
  'company', co.name, 'company_logo', co.logo_url,
  'client', coalesce(nullif(b.fields->>'clientName', ''), cl),
  'label', p.label, 'month_number', p.month_number, 'created_at', p.created_at,
  'responsible', (select name from public.memberships where company_id = p.company_id and user_id = b.responsible_id),
  'diagnostico', p.content->'diagnostico', 'pilares', p.content->'pilares', 'publico', p.content->>'publico',
  'campanha', jsonb_build_object('objetivo', p.content->'campanha'->>'objetivo',
   'regiao', p.content->'campanha'->>'regiao', 'idadeGenero', p.content->'campanha'->>'idadeGenero'),
  'posts', coalesce((select jsonb_agg(jsonb_build_object('numero', x.number, 'badge', x.pillar, 'gancho', x.hook,
    'direcaoCopy', x.copy_direction, 'direcaoVisual', x.visual_direction, 'formato', x.format, 'cta', x.cta,
    'textoImagem', x.image_text, 'textoVideo', x.video_text, 'legenda', x.caption,
    'ehAnuncio', x.is_ad, 'decision', x.decision, 'note', x.note, 'decided_at', x.decided_at,
    'decided_via', x.decided_via,
    'arts', coalesce((select jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type'))
      from jsonb_array_elements(x.arts) a), '[]')) order by x.number)
   from public.social_leads_posts x where x.plan_id = p.id), '[]'),
  -- Só para ver: quando sai cada post e, publicado, o link.
  'calendar', case when cal then coalesce((select jsonb_agg(jsonb_build_object('numero', s.number,
    'at', s.scheduled_at, 'destinations', to_jsonb(s.destinations),
    'published', s.status = 'published', 'url', s.published_url) order by s.scheduled_at, s.number)
   from public.social_media_schedules s where s.plan_id = p.id), '[]') end,
  'timezone', mavi_private.company_tz(p.company_id));
end $$;

-- ------------------------------------------------------------ Quem usa qual modelo
-- 'social_media_schedule': a sugestão das datas do Agendamento.
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
   'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
   'personal_radar', 'personal_assistant', 'personal_radar_check', 'social_media_schedule')));

-- A da migração 20270307090000, com a sugestão de datas do Agendamento.
create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature', 'skill') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text', 'task_audio',
  'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
  'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
  'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
  'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
  'personal_radar', 'personal_assistant', 'personal_radar_check', 'social_media_schedule') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 select p.kind into v_kind from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
  and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model);
 if v_kind is null then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 -- Transcrição: o endpoint de transcrição da OpenAI e um modelo que transcreve.
 if mavi_private.ai_transcribe_feature(v_feature) then
  if v_kind not in ('openai', 'groq', 'mistral', 'custom') then
   raise exception 'A transcrição usa a OpenAI, o Groq, a Mistral ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_transcribe_model(p_model) then
   raise exception 'Escolha um modelo de transcrição (Whisper, gpt-4o-transcribe, Voxtral…).' using errcode = '22023';
  end if;
 -- Imagens: o endpoint de imagens da OpenAI e um modelo que gera imagens.
 elsif v_feature = 'image_generation' then
  if v_kind not in ('openai', 'google', 'xai', 'openrouter', 'custom') then
   raise exception 'As imagens usam a OpenAI, o Google, a xAI, o OpenRouter ou um endereço compatível.' using errcode = '22023';
  end if;
  if not mavi_private.ai_image_model(p_model) then
   raise exception 'Escolha um modelo de imagem (gpt-image-1, Imagen, grok-2-image…).' using errcode = '22023';
  end if;
 -- Busca na internet: a da Claude (nativa) ou a do OpenRouter (plugin web e modelos online).
 elsif v_feature = 'web_search' then
  if v_kind not in ('anthropic', 'openrouter') then
   raise exception 'A busca na internet usa a Claude (Anthropic) ou o OpenRouter.' using errcode = '22023';
  end if;
  if mavi_private.ai_non_chat_model(p_model) then
   raise exception 'Escolha um modelo de conversa para a busca.' using errcode = '22023';
  end if;
 elsif mavi_private.ai_non_chat_model(p_model) then
  raise exception 'Este modelo só transcreve, gera vetores ou imagens: escolha um modelo de conversa.' using errcode = '22023';
 end if;
 -- O termômetro e a conferência do Radar leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, na conferência do Radar ou na autoavaliação da MAVI.'
   using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id)
  or p_type = 'skill' and not exists (select 1 from public.ai_skills where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
