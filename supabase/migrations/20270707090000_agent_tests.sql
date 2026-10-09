-- Agentes MAVI › Testes com leads simulados. As baterias rodam no motor;
-- aqui ficam os tetos (Painel da MAVI, só administradores e gestores), o
-- controle da bateria periódica de cada agente e o aviso na Caixa de entrada
-- quando a periódica acha problemas. De hora em hora o pg_cron acorda o
-- /api/ai ("agent-tests"): começa as periódicas vencidas e avisa as terminadas.

begin;

create table mavi_private.agent_test_settings (
  company_id uuid primary key references public.companies (id),
  -- Por bateria.
  max_conversations integer not null default 10 check (max_conversations between 1 and 50),
  max_turns integer not null default 8 check (max_turns between 2 and 20),
  run_cap_usd numeric(10, 4) not null default 1 check (run_cap_usd > 0 and run_cap_usd <= 100),
  -- Por agente, no mês (todas as baterias somadas).
  monthly_cap_usd numeric(10, 4) not null default 20 check (monthly_cap_usd > 0 and monthly_cap_usd <= 1000),
  -- Antes de publicar: conversas da bateria (o rascunho e a publicada, cada um).
  publish_conversations integer not null default 4 check (publish_conversations between 1 and 20),
  -- Periódica: liga/desliga, de quantos em quantos dias e quantas conversas.
  scheduled_enabled boolean not null default true,
  scheduled_every_days integer not null default 7 check (scheduled_every_days between 1 and 60),
  scheduled_conversations integer not null default 6 check (scheduled_conversations between 1 and 30),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table mavi_private.agent_test_schedule (
  agent_id text primary key,
  company_id uuid not null,
  last_run_at timestamptz not null,
  last_run_id text
);

-- Até onde os avisos das periódicas já foram lidos, e cada bateria avisada uma vez.
create table mavi_private.agent_test_notices (
  run_id text primary key,
  company_id uuid not null,
  recipients uuid[] not null default '{}',
  sent_at timestamptz not null default now()
);

-- Os tetos de uma empresa (os padrões quando ninguém mudou).
create function mavi_private.agent_test_limits(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(s) - 'company_id' - 'updated_by'
  from (select coalesce(x.max_conversations, 10) as max_conversations, coalesce(x.max_turns, 8) as max_turns,
               coalesce(x.run_cap_usd, 1) as run_cap_usd, coalesce(x.monthly_cap_usd, 20) as monthly_cap_usd,
               coalesce(x.publish_conversations, 4) as publish_conversations, coalesce(x.scheduled_enabled, true) as scheduled_enabled,
               coalesce(x.scheduled_every_days, 7) as scheduled_every_days, coalesce(x.scheduled_conversations, 6) as scheduled_conversations,
               x.updated_at, x.company_id, x.updated_by
        from (select 1) one left join mavi_private.agent_test_settings x on x.company_id = c) s
$$;
revoke all on function mavi_private.agent_test_limits(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ tela
create function public.agent_test_settings(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
  return mavi_private.agent_test_limits(p_company) || jsonb_build_object('can_edit', mavi_private.leader(p_company));
end $$;

create function public.agent_test_settings_set(p_company uuid, p_settings jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not mavi_private.leader(p_company) then
    raise exception 'Só administradores e gestores mudam os tetos dos testes.' using errcode = '42501';
  end if;
  insert into mavi_private.agent_test_settings as s (company_id, max_conversations, max_turns, run_cap_usd, monthly_cap_usd,
    publish_conversations, scheduled_enabled, scheduled_every_days, scheduled_conversations, updated_by, updated_at)
  values (p_company, (p_settings->>'max_conversations')::integer, (p_settings->>'max_turns')::integer,
    (p_settings->>'run_cap_usd')::numeric, (p_settings->>'monthly_cap_usd')::numeric, (p_settings->>'publish_conversations')::integer,
    (p_settings->>'scheduled_enabled')::boolean, (p_settings->>'scheduled_every_days')::integer,
    (p_settings->>'scheduled_conversations')::integer, auth.uid(), now())
  on conflict (company_id) do update set
    max_conversations = excluded.max_conversations, max_turns = excluded.max_turns, run_cap_usd = excluded.run_cap_usd,
    monthly_cap_usd = excluded.monthly_cap_usd, publish_conversations = excluded.publish_conversations,
    scheduled_enabled = excluded.scheduled_enabled, scheduled_every_days = excluded.scheduled_every_days,
    scheduled_conversations = excluded.scheduled_conversations, updated_by = excluded.updated_by, updated_at = now();
end $$;

revoke all on function public.agent_test_settings(uuid), public.agent_test_settings_set(uuid, jsonb) from public, anon;
grant execute on function public.agent_test_settings(uuid), public.agent_test_settings_set(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------ worker (segredo do /api/ai)
-- Dos agentes publicados com caixa, os que devem rodar a periódica agora (com os tetos da empresa).
create function public.agent_test_due(p_secret text, p_agents jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('agent_id', a.agent_id, 'limits', mavi_private.agent_test_limits(a.company_id)))
    from jsonb_to_recordset(coalesce(p_agents, '[]'::jsonb)) as a(agent_id text, company_id uuid)
    left join mavi_private.agent_test_schedule s on s.agent_id = a.agent_id
    where exists (select 1 from public.companies k where k.id = a.company_id)
      and (mavi_private.agent_test_limits(a.company_id)->>'scheduled_enabled')::boolean
      and (s.agent_id is null or s.last_run_at < now() - make_interval(days => (mavi_private.agent_test_limits(a.company_id)->>'scheduled_every_days')::integer))
  ), '[]'::jsonb);
end $$;

create function public.agent_test_scheduled(p_secret text, p_agent text, p_company uuid, p_run text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into mavi_private.agent_test_schedule (agent_id, company_id, last_run_at, last_run_id)
  values (p_agent, p_company, now(), p_run)
  on conflict (agent_id) do update set last_run_at = now(), last_run_id = excluded.last_run_id, company_id = excluded.company_id;
end $$;

-- Desde quando ler as periódicas terminadas (o último aviso, ou 2 dias atrás).
create function public.agent_test_since(p_secret text) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return coalesce((select max(sent_at) - interval '2 hours' from mavi_private.agent_test_notices), now() - interval '2 days');
end $$;

-- Aviso de uma periódica com problemas: para quem recebe o resumo semanal do
-- agente (ou, sem escolha, quem editou por último). Uma vez por bateria.
create function public.agent_test_notify(p_secret text, p_run text, p_agent text, p_company uuid, p_client uuid, p_creator text,
  p_title text, p_body text, p_link text) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_users uuid[]; n integer;
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  select case when s.agent_id is null then mavi_private.agent_report_default(p_company, p_client, coalesce(p_creator, ''))
              else array(select u from unnest(s.recipients) u where mavi_private.agent_report_can_read(p_company, u, p_client)) end
    into v_users
  from (select 1) one left join mavi_private.agent_report_settings s on s.agent_id = p_agent and s.company_id = p_company;
  insert into mavi_private.agent_test_notices (run_id, company_id, recipients) values (p_run, p_company, coalesce(v_users, '{}'))
  on conflict do nothing;
  if not found then return 0; end if;
  insert into public.notifications (company_id, user_id, actor_id, task_id, kind, title, body, link)
  select p_company, u, null, null, 'agent_test', left(p_title, 200), left(coalesce(p_body, ''), 300), p_link
  from unnest(coalesce(v_users, '{}')) u
  where exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = u and m.active);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.agent_test_due(text, jsonb), public.agent_test_scheduled(text, text, uuid, text), public.agent_test_since(text),
  public.agent_test_notify(text, text, text, uuid, uuid, text, text, text, text) from public, authenticated;
grant execute on function public.agent_test_due(text, jsonb), public.agent_test_scheduled(text, text, uuid, text), public.agent_test_since(text),
  public.agent_test_notify(text, text, text, uuid, uuid, text, text, text, text) to anon;

-- ------------------------------------------------------------ Caixa de entrada: tipo novo
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['agent_test']) x order by x);
 w := array(select distinct x from unnest(w || array['agent_test', 'notice']) x order by x);
 alter table public.notifications drop constraint notifications_kind_check;
 execute format('alter table public.notifications add constraint notifications_kind_check check (kind in (%s))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 alter table public.notifications drop constraint notifications_target_check;
 execute format('alter table public.notifications add constraint notifications_target_check check ('
  '((kind in (%s)) = (task_id is null)) '
  'and (task_id is not null or (title is not null and link is not null)) '
  'and ((kind = ''notice'') = (notice_id is not null)))', (select string_agg(quote_literal(x), ',') from unnest(w) x));
end $$;

-- ------------------------------------------------------------ agendamento
create function mavi_private.agent_tests_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"agent-tests"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.agent_tests_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('mavi-agent-tests', '23 * * * *', $job$ select mavi_private.agent_tests_kick(); $job$);
  end if;
end $$;

commit;
