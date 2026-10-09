-- Agentes MAVI › Insights: o resumo semanal na Caixa de entrada.
-- Os agentes, as lacunas e os relatórios ficam no motor (mavi-agentes); aqui
-- só quem recebe o resumo de cada agente e o registro do que já foi enviado.
--
-- Padrão: ligado, para quem criou o agente. Quem edita o agente liga/desliga
-- e escolhe as pessoas (só quem vê o cliente no Drive recebe).
-- Toda segunda de manhã o pg_cron acorda o /api/ai ("agent-weekly"), que lê a
-- semana anterior no motor, pede a Leitura da MAVI e chama agent_report_send.

begin;

create table mavi_private.agent_report_settings (
  -- Id do agente no motor.
  agent_id text primary key check (length(agent_id) between 1 and 64),
  company_id uuid not null references public.companies (id),
  client_id uuid not null,
  weekly boolean not null default true,
  recipients uuid[] not null default '{}',
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table mavi_private.agent_report_sends (
  agent_id text not null,
  week_start date not null,
  company_id uuid not null,
  recipients uuid[] not null default '{}',
  sent_at timestamptz not null default now(),
  primary key (agent_id, week_start)
);

-- A pessoa vê o cliente (mesma regra do Drive, para qualquer pessoa).
create function mavi_private.agent_report_can_read(c uuid, u uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists (
  select 1 from public.memberships m
  where m.company_id = c and m.user_id = u and m.active
    and (m.role in ('admin', 'manager') or exists (
      select 1 from public.client_teams ct
      join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
      where ct.company_id = c and ct.client_id = p_client and tm.user_id = u)))
$$;

-- Quem cria o agente (o e-mail que o motor guardou) recebe por padrão.
create function mavi_private.agent_report_default(c uuid, p_client uuid, p_email text) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(m.user_id), '{}') from public.memberships m
 where m.company_id = c and m.active and p_email <> '' and lower(m.email) = lower(p_email)
   and mavi_private.agent_report_can_read(c, m.user_id, p_client)
$$;

revoke all on function mavi_private.agent_report_can_read(uuid, uuid, uuid), mavi_private.agent_report_default(uuid, uuid, text)
  from public, anon, authenticated;

-- ------------------------------------------------------------ tela (com o login da pessoa)
-- O que está configurado + quem pode receber (as pessoas que veem o cliente).
create function public.agent_report_settings(p_company uuid, p_client uuid, p_agent text, p_creator text default '')
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s mavi_private.agent_report_settings;
  v_recipients uuid[];
begin
  if not (mavi_private.leader(p_company) or mavi_private.drive_can_read(p_company, p_client)) then
    raise exception 'Sem acesso.' using errcode = '42501';
  end if;
  select * into s from mavi_private.agent_report_settings where agent_id = p_agent and company_id = p_company;
  v_recipients := case when s.agent_id is null then mavi_private.agent_report_default(p_company, p_client, coalesce(p_creator, ''))
                       else s.recipients end;
  return jsonb_build_object(
    'weekly', coalesce(s.weekly, true),
    'custom', s.agent_id is not null,
    'recipients', to_jsonb(coalesce(v_recipients, '{}')),
    'updated_at', s.updated_at,
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.user_id, 'name', m.name, 'email', m.email) order by m.name)
      from public.memberships m
      where m.company_id = p_company and m.active and mavi_private.agent_report_can_read(p_company, m.user_id, p_client)
    ), '[]'::jsonb),
    'last_sent', (select max(week_start) from mavi_private.agent_report_sends where agent_id = p_agent)
  );
end $$;

create function public.agent_report_settings_set(p_company uuid, p_client uuid, p_contract uuid, p_agent text, p_weekly boolean, p_recipients uuid[])
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (mavi_private.leader(p_company) or (p_contract is not null and mavi_private.drive_can_write(p_company, p_client, p_contract))) then
    raise exception 'Só quem edita este produto do cliente no Drive muda o resumo.' using errcode = '42501';
  end if;
  if length(coalesce(p_agent, '')) not between 1 and 64 then
    raise exception 'Agente inválido.' using errcode = '22023';
  end if;
  insert into mavi_private.agent_report_settings (agent_id, company_id, client_id, weekly, recipients, updated_by, updated_at)
  values (p_agent, p_company, p_client, p_weekly,
          coalesce((select array_agg(distinct u) from unnest(coalesce(p_recipients, '{}')) u
                    where mavi_private.agent_report_can_read(p_company, u, p_client)), '{}'),
          auth.uid(), now())
  on conflict (agent_id) do update set
    weekly = excluded.weekly, recipients = excluded.recipients, client_id = excluded.client_id,
    updated_by = excluded.updated_by, updated_at = now()
  where mavi_private.agent_report_settings.company_id = p_company;
end $$;

revoke all on function public.agent_report_settings(uuid, uuid, text, text), public.agent_report_settings_set(uuid, uuid, uuid, text, boolean, uuid[])
  from public, anon;
grant execute on function public.agent_report_settings(uuid, uuid, text, text), public.agent_report_settings_set(uuid, uuid, uuid, text, boolean, uuid[])
  to authenticated;

-- ------------------------------------------------------------ worker (segredo do /api/ai)
-- Dos agentes do motor (com a empresa/cliente do MAVI Tasks), quem recebe o
-- resumo desta semana: ligado, com alguém para receber e ainda não enviado.
create function public.agent_report_targets(p_secret text, p_agents jsonb, p_week date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('agent_id', x.agent_id, 'recipients', to_jsonb(x.recipients)))
    from (
      select a.agent_id,
        case when s.agent_id is null then mavi_private.agent_report_default(a.company_id, a.client_id, a.creator)
             else array(select u from unnest(s.recipients) u where mavi_private.agent_report_can_read(a.company_id, u, a.client_id)) end as recipients
      from jsonb_to_recordset(coalesce(p_agents, '[]'::jsonb)) as a(agent_id text, company_id uuid, client_id uuid, creator text)
      left join mavi_private.agent_report_settings s on s.agent_id = a.agent_id and s.company_id = a.company_id
      where coalesce(s.weekly, true)
        and exists (select 1 from public.companies k where k.id = a.company_id)
        and not exists (select 1 from mavi_private.agent_report_sends r where r.agent_id = a.agent_id and r.week_start = p_week)
    ) x
    where cardinality(x.recipients) > 0
  ), '[]'::jsonb);
end $$;

-- Grava o aviso na Caixa de entrada de cada pessoa (uma vez por agente e semana).
create function public.agent_report_send(p_secret text, p_agent text, p_company uuid, p_week date, p_users uuid[],
  p_title text, p_body text, p_link text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  insert into mavi_private.agent_report_sends (agent_id, week_start, company_id, recipients)
  values (p_agent, p_week, p_company, coalesce(p_users, '{}'))
  on conflict do nothing;
  if not found then return 0; end if;
  insert into public.notifications (company_id, user_id, actor_id, task_id, kind, title, body, link)
  select p_company, u, null, null, 'agent_report', left(p_title, 200), left(coalesce(p_body, ''), 300), p_link
  from unnest(coalesce(p_users, '{}')) u
  where exists (select 1 from public.memberships m where m.company_id = p_company and m.user_id = u and m.active);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.agent_report_targets(text, jsonb, date), public.agent_report_send(text, text, uuid, date, uuid[], text, text, text)
  from public, authenticated;
grant execute on function public.agent_report_targets(text, jsonb, date), public.agent_report_send(text, text, uuid, date, uuid[], text, text, text)
  to anon;

-- ------------------------------------------------------------ Caixa de entrada: tipo novo
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['agent_report']) x order by x);
 w := array(select distinct x from unnest(w || array['agent_report', 'notice']) x order by x);
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
-- Segunda, das 8h às 11h (Brasília), de hora em hora: o que não coube numa
-- rodada vai na próxima (o envio é uma vez por agente e semana).
create function mavi_private.agent_weekly_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"agent-weekly"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.agent_weekly_kick() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('mavi-agent-weekly', '0 11-14 * * 1', $job$ select mavi_private.agent_weekly_kick(); $job$);
  end if;
end $$;

commit;
