begin;

-- Equipe e configurações › Avisos de falhas: as rotinas que rodam sozinhas
-- (varredura do WhatsApp, sincronização das campanhas, Agente Conversacional…)
-- avisam na caixa de entrada (e por push) quando dão problema.
--
-- * Cada rotina já guarda o próprio erro na sua tabela. Gatilhos nessas
--   tabelas contam aqui o resultado de cada execução (mavi_private.job_report):
--   o último sucesso, a última falha e as falhas seguidas de cada item (a
--   campanha, o grupo, o servidor do n8n; '' quando a rotina é uma só). Os
--   workers não mudam. Um erro aqui nunca derruba a rotina.
-- * O admin escolhe, por rotina: ligar ou desligar, quem recebe (padrão:
--   todos os administradores), avisar ao falhar N vezes seguidas, avisar
--   quando ficar X horas sem nenhum sucesso (parada), avisar quando voltar a
--   funcionar e lembrar a cada X horas enquanto continuar. Sem linha em
--   job_alert_settings vale o padrão do catálogo (mavi_private.job_catalog).
-- * mavi_private.job_alerts_run (pg_cron a cada 2 minutos) manda os avisos,
--   juntando os itens da mesma rotina num aviso só ("falhou em 4 campanhas").
-- * O aviso é o tipo 'job_alert' (link para onde a rotina aparece) e respeita
--   as preferências da pessoa (Meu perfil › Notificações).

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature', 'tasks_assigned', 'due_risk', 'status', 'review', 'ai_skill', 'ai_answer',
  'radar_report', 'radar_alert', 'media_balance', 'priority', 'tasks_priority', 'copilot_lessons', 'mavi_lessons',
  'campaign_alert', 'campaign_insight', 'job_alert'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature',
   'tasks_assigned', 'due_risk', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert', 'media_balance',
   'tasks_priority', 'copilot_lessons', 'mavi_lessons', 'campaign_alert', 'campaign_insight', 'job_alert'))
   = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- A da migração 20270327090000, com as falhas das rotinas.
create or replace function mavi_private.notification_pref_keys() returns text[]
language sql immutable set search_path = '' as $$
 select array['assigned', 'mention', 'reply', 'review', 'due_risk',
  'social_leads', 'ai_share', 'success_case', 'temperature', 'ai_skill', 'ai_answer', 'radar_report', 'radar_alert',
  'media_balance', 'priority', 'campaign_alert', 'campaign_insight', 'job_alert']
  || array(select 'status.' || s || '.' || r
   from unnest(array['progress', 'returned', 'review', 'rejected', 'correction', 'done']) s,
        unnest(array['creator', 'assignee', 'participant']) r)
$$;

-- ------------------------------------------------------------ catálogo
-- As rotinas, na ordem da tela. noun/nouns: o item de cada falha (nulo: a
-- rotina é uma só). fails: registra falhas (os Leads da Make só dizem quando
-- chegaram). stale_ok: "parada" faz sentido (roda o tempo todo, não só
-- quando há o que fazer). fail_after e stale_hours: os padrões.
create function mavi_private.job_catalog()
returns table(job text, sort integer, label text, noun text, nouns text, fails boolean, stale_ok boolean,
 fail_after integer, stale_hours integer, link text)
language sql immutable set search_path = '' as $$
 values
  ('whatsapp_sweep', 1, 'Varredura do WhatsApp', null::text, null::text, true, true, 3, 6,
   '/configuracoes#config-whatsapp'),
  ('whatsapp_groups', 2, 'Leitura dos grupos do WhatsApp', 'grupo', 'grupos', true, false, 3, null::integer,
   '/configuracoes#config-whatsapp'),
  ('ads_sync', 3, 'Sincronização diária das campanhas', 'campanha', 'campanhas', true, true, 1, 30, '/campanhas'),
  ('ads_today', 4, 'Resultados de hoje das campanhas', 'campanha', 'campanhas', true, true, 4, null, '/campanhas'),
  ('campaign_insights', 5, 'Insights da MAVI nas campanhas', 'campanha', 'campanhas', true, false, 1, null,
   '/campanhas'),
  ('campaign_daily', 6, 'Leitura do dia da MAVI', 'campanha', 'campanhas', true, true, 1, null, '/campanhas'),
  ('make_leads', 7, 'Leads da página de captura da Make', null, null, false, true, null, 24, '/campanhas'),
  ('agent_sync', 8, 'Leitura do Agente Conversacional (n8n)', 'servidor', 'servidores', true, true, 2, 3,
   '/agente-conversacional'),
  ('social_media', 9, 'Publicação automática do Social Media', null, null, true, false, 1, null,
   '/planejamento/social-media'),
  ('radar', 10, 'Leituras do Radar do cliente', null, null, true, true, 3, null, '/radar'),
  ('temperature', 11, 'Leituras do Termômetro', null, null, true, true, 3, null, '/termometro'),
  ('task_recurrences', 12, 'Repetição de tarefas', 'tarefa', 'tarefas', true, false, 1, null, '/tarefas')
$$;
revoke all on function mavi_private.job_catalog() from public, anon, authenticated;

-- ------------------------------------------------------------ tabelas
-- O que o admin escolheu. Campos nulos desligam a opção: fail_after (não
-- avisa por falhas), stale_hours (não avisa quando parar), remind_hours
-- (avisa uma vez só). recipients nulo: todos os administradores.
create table public.job_alert_settings (
 company_id uuid not null references public.companies(id) on delete cascade,
 job text not null,
 active boolean not null default true,
 fail_after integer check (fail_after between 1 and 50),
 stale_hours integer check (stale_hours between 1 and 720),
 notify_recovery boolean not null default true,
 remind_hours integer check (remind_hours between 1 and 168),
 recipients uuid[] check (cardinality(recipients) <= 200),
 updated_by uuid references auth.users(id) on delete set null,
 updated_at timestamptz not null default now(),
 primary key (company_id, job)
);
alter table public.job_alert_settings enable row level security;
revoke all on public.job_alert_settings from public, anon, authenticated;

-- A saúde de cada rotina: o último sucesso e a última falha, e o aviso de
-- parada (stale_since: o último sucesso quando o aviso saiu).
create table mavi_private.job_status (
 company_id uuid not null references public.companies(id) on delete cascade,
 job text not null,
 last_ok_at timestamptz,
 last_fail_at timestamptz,
 last_error text,
 stale_alerted_at timestamptz,
 stale_reminded_at timestamptz,
 stale_since timestamptz,
 stale_recovered_at timestamptz,
 primary key (company_id, job)
);
alter table mavi_private.job_status enable row level security;
revoke all on mavi_private.job_status from public, anon, authenticated;

-- Os itens com falha (a linha some quando o item volta e não houve aviso,
-- ou depois do aviso de volta). alerted_at: o aviso de falha já saiu;
-- recovered_at: voltou e o aviso de volta espera a próxima rodada
-- (alerted_streak: quantas falhas foram).
create table mavi_private.job_failures (
 company_id uuid not null references public.companies(id) on delete cascade,
 job text not null,
 subject text not null default '',
 label text not null default '',
 streak integer not null default 0,
 since timestamptz,
 last_error text,
 last_error_at timestamptz,
 alerted_at timestamptz,
 reminded_at timestamptz,
 recovered_at timestamptz,
 alerted_streak integer,
 primary key (company_id, job, subject)
);
alter table mavi_private.job_failures enable row level security;
revoke all on mavi_private.job_failures from public, anon, authenticated;

-- ------------------------------------------------------------ o registro
-- Uma execução de uma rotina: deu certo (p_ok) ou falhou (p_error), para um
-- item (p_subject, com o nome em p_label) ou para a rotina toda (''). Nunca
-- derruba quem chamou.
create function mavi_private.job_report(c uuid, p_job text, p_ok boolean, p_error text default null,
 p_subject text default '', p_label text default '') returns void
language plpgsql security definer set search_path = '' as $$
declare f mavi_private.job_failures; v_error text; v_subject text := coalesce(p_subject, '');
 v_label text := left(coalesce(p_label, ''), 200); begin
 if c is null or p_job is null then return; end if;
 v_error := left(coalesce(nullif(btrim(p_error), ''), 'Erro sem detalhes.'), 1000);
 insert into mavi_private.job_status as s(company_id, job, last_ok_at, last_fail_at, last_error)
 values (c, p_job, case when p_ok then now() end, case when not p_ok then now() end,
  case when not p_ok then v_error end)
 on conflict (company_id, job) do update set
  last_ok_at = case when p_ok then now() else s.last_ok_at end,
  last_fail_at = case when p_ok then s.last_fail_at else now() end,
  last_error = case when p_ok then s.last_error else v_error end,
  stale_recovered_at = case when p_ok and s.stale_alerted_at is not null then now() else s.stale_recovered_at end,
  stale_alerted_at = case when p_ok then null else s.stale_alerted_at end,
  stale_reminded_at = case when p_ok then null else s.stale_reminded_at end;

 select * into f from mavi_private.job_failures
 where company_id = c and job = p_job and subject = v_subject for update;
 if p_ok then
  if not found then return; end if;
  if f.alerted_at is null and f.recovered_at is null then
   delete from mavi_private.job_failures where company_id = c and job = p_job and subject = v_subject;
  elsif f.alerted_at is not null then
   update mavi_private.job_failures set recovered_at = now(), alerted_streak = f.streak, streak = 0,
    alerted_at = null, reminded_at = null, label = coalesce(nullif(v_label, ''), label)
   where company_id = c and job = p_job and subject = v_subject;
  end if;
 elsif not found then
  insert into mavi_private.job_failures(company_id, job, subject, label, streak, since, last_error, last_error_at)
  values (c, p_job, v_subject, v_label, 1, now(), v_error, now());
 elsif f.recovered_at is not null then
  -- Voltou e falhou de novo antes do aviso de volta: é a mesma falha.
  update mavi_private.job_failures set recovered_at = null, alerted_at = now(), reminded_at = now(),
   streak = coalesce(f.alerted_streak, 0) + 1, last_error = v_error, last_error_at = now(),
   label = coalesce(nullif(v_label, ''), label)
  where company_id = c and job = p_job and subject = v_subject;
 else
  update mavi_private.job_failures set streak = f.streak + 1, since = coalesce(f.since, now()),
   last_error = v_error, last_error_at = now(), label = coalesce(nullif(v_label, ''), label)
  where company_id = c and job = p_job and subject = v_subject;
 end if;
exception when others then
 raise warning 'job_report % failed: %', p_job, sqlerrm;
end $$;
revoke all on function mavi_private.job_report(uuid, text, boolean, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------ gatilhos
-- WhatsApp: a varredura (sucesso: last_sweep_at anda; falha: o erro).
create function mavi_private.job_whatsapp_sweep() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.last_sweep_at is distinct from old.last_sweep_at then
  perform mavi_private.job_report(new.company_id, 'whatsapp_sweep', true);
 elsif new.last_sweep_error is not null then
  perform mavi_private.job_report(new.company_id, 'whatsapp_sweep', false, new.last_sweep_error);
 end if;
 return null;
end $$;
create trigger job_whatsapp_sweep after update of last_sweep_at, last_sweep_error on mavi_private.whatsapp_config
 for each row execute function mavi_private.job_whatsapp_sweep();

-- WhatsApp: a leitura de cada grupo.
create function mavi_private.job_whatsapp_group() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.sync_error is not null then
  perform mavi_private.job_report(new.company_id, 'whatsapp_groups', false, new.sync_error, new.id::text, new.title);
 elsif new.synced_at is distinct from old.synced_at then
  perform mavi_private.job_report(new.company_id, 'whatsapp_groups', true, null, new.id::text, new.title);
 end if;
 return null;
end $$;
create trigger job_whatsapp_group after update of synced_at, sync_error on public.whatsapp_groups
 for each row execute function mavi_private.job_whatsapp_group();

-- Campanhas: a sincronização agendada de cada campanha.
create function mavi_private.job_ads_sync() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.job_report(new.company_id, 'ads_sync', new.status = 'ok', new.message, new.campaign_id::text,
  (select a.name from public.ad_campaigns a where a.company_id = new.company_id and a.id = new.campaign_id));
 return null;
end $$;
create trigger job_ads_sync after insert on public.ad_sync_runs
 for each row when (new.trigger = 'schedule') execute function mavi_private.job_ads_sync();

-- Campanhas: a leitura de hoje de cada campanha.
create function mavi_private.job_ads_today() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.job_report(new.company_id, 'ads_today', new.error is null, new.error, new.campaign_id::text,
  (select a.name from public.ad_campaigns a where a.company_id = new.company_id and a.id = new.campaign_id));
 return null;
end $$;
create trigger job_ads_today_ins after insert on public.ad_today_metrics
 for each row execute function mavi_private.job_ads_today();
create trigger job_ads_today_upd after update of tried_at on public.ad_today_metrics
 for each row execute function mavi_private.job_ads_today();

-- Campanhas: a análise dos Insights e a Leitura do dia (pulada não conta).
create function mavi_private.job_campaign_run() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.job_report(new.company_id, tg_argv[0], new.status = 'done', nullif(new.note, ''),
  new.campaign_id::text,
  (select a.name from public.ad_campaigns a where a.company_id = new.company_id and a.id = new.campaign_id));
 return null;
end $$;
create trigger job_campaign_insights after update of status on public.campaign_insight_runs
 for each row when (new.status in ('done', 'failed') and old.status is distinct from new.status)
 execute function mavi_private.job_campaign_run('campaign_insights');
create trigger job_campaign_daily after update of status on public.campaign_daily_reads
 for each row when (new.status in ('done', 'failed') and old.status is distinct from new.status)
 execute function mavi_private.job_campaign_run('campaign_daily');

-- Leads da Make: só quando chegaram (a falha aparece como "parada").
create function mavi_private.job_make_leads() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 for c in select distinct y.company_id from public.ad_cycles y where y.destination = 'make_landing_page' loop
  perform mavi_private.job_report(c, 'make_leads', true);
 end loop;
 return null;
end $$;
create trigger job_make_leads after update of seen_at on mavi_private.make_capture_state
 for each row when (new.seen_at is distinct from old.seen_at) execute function mavi_private.job_make_leads();

-- Agente Conversacional: a leitura de cada servidor do n8n (sucesso: a
-- leitura completa; falha: a tentativa terminou com erro).
create function mavi_private.job_agent_sync() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.last_sync_at is distinct from old.last_sync_at and new.last_sync_at is not null then
  perform mavi_private.job_report(new.company_id, 'agent_sync', true, null, new.id::text, new.name);
 elsif new.last_attempt_at is not null and new.last_attempt_at is distinct from old.last_attempt_at
  and new.last_error is not null then
  perform mavi_private.job_report(new.company_id, 'agent_sync', false, new.last_error, new.id::text, new.name);
 end if;
 return null;
end $$;
create trigger job_agent_sync after update of last_attempt_at on public.agent_instances
 for each row execute function mavi_private.job_agent_sync();

-- Social Media: a publicação automática pelo Meta (o post que ficou sem arte
-- não é falha da rotina).
create function mavi_private.job_social_media() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.status = 'published' then
  perform mavi_private.job_report(new.company_id, 'social_media', true);
 elsif old.status = 'publishing' and new.error is not null then
  perform mavi_private.job_report(new.company_id, 'social_media', false,
   format('Post %s de %s: %s', new.number,
    coalesce(mavi_private.social_media_client_name(new.company_id, new.contract_id), 'cliente'), new.error));
 end if;
 return null;
end $$;
create trigger job_social_media after update of status on public.social_media_schedules
 for each row when (old.status is distinct from new.status) execute function mavi_private.job_social_media();

-- Radar e Termômetro: cada leitura (a tentativa com erro, ou a leitura pronta).
create function mavi_private.job_signal() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.attempts > old.attempts and new.last_error is not null then
  perform mavi_private.job_report(new.company_id, tg_argv[0], false, new.last_error);
 elsif new.status = 'done' and old.status is distinct from 'done' then
  perform mavi_private.job_report(new.company_id, tg_argv[0], true);
 end if;
 return null;
end $$;
create trigger job_radar after update of attempts, status on public.radar_signals
 for each row execute function mavi_private.job_signal('radar');
create trigger job_temperature after update of attempts, status on public.temperature_signals
 for each row execute function mavi_private.job_signal('temperature');

-- Repetição de tarefas: cada cópia aberta ou o erro ao abrir.
create function mavi_private.job_task_recurrence() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 if new.copies <> old.copies then
  perform mavi_private.job_report(new.company_id, 'task_recurrences', true, null, new.id::text, new.title);
 elsif new.last_error is not null then
  perform mavi_private.job_report(new.company_id, 'task_recurrences', false, new.last_error, new.id::text, new.title);
 end if;
 return null;
end $$;
create trigger job_task_recurrence after update of copies, last_error on public.task_recurrences
 for each row execute function mavi_private.job_task_recurrence();

revoke all on function mavi_private.job_whatsapp_sweep(), mavi_private.job_whatsapp_group(),
 mavi_private.job_ads_sync(), mavi_private.job_ads_today(), mavi_private.job_campaign_run(),
 mavi_private.job_make_leads(), mavi_private.job_agent_sync(), mavi_private.job_social_media(),
 mavi_private.job_signal(), mavi_private.job_task_recurrence() from public, anon, authenticated;

-- ------------------------------------------------------------ configuração
-- O que vale para a rotina: a escolha do admin ou o padrão do catálogo.
create function mavi_private.job_alert_config(c uuid, p_job text) returns public.job_alert_settings
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select s from public.job_alert_settings s where s.company_id = c and s.job = p_job),
  (select row(c, k.job, true, k.fail_after, k.stale_hours, true, 24, null, null, now())::public.job_alert_settings
   from mavi_private.job_catalog() k where k.job = p_job))
$$;

-- Quem recebe: as pessoas escolhidas que seguem ativas, ou os administradores.
create function mavi_private.job_alert_people(c uuid, p_recipients uuid[]) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(m.user_id order by m.user_id), '{}') from public.memberships m
 where m.company_id = c and m.active
  and case when p_recipients is null then m.role = 'admin' else m.user_id = any(p_recipients) end
$$;

-- "04/10 às 09:12" no fuso da empresa; "7 h" / "2 dias".
create function mavi_private.job_when(c uuid, t timestamptz) returns text
language sql stable security definer set search_path = '' as $$
 select to_char(t at time zone coalesce((select timezone from public.companies where id = c), 'America/Sao_Paulo'),
  'DD/MM "às" HH24:MI')
$$;
create function mavi_private.job_span(t timestamptz) returns text
language sql stable set search_path = '' as $$
 select case when h < 1 then 'menos de 1 h' when h < 48 then h || ' h' else (h / 24) || ' dias' end
 from (select floor(extract(epoch from now() - t) / 3600)::int as h) x
$$;

-- Um aviso para cada pessoa. p_kind: fail, remind, recover, stale,
-- stale_remind, stale_recover, test. p_rows: os itens [{subject, label,
-- streak, since, error}] (um só para a rotina toda); p_since: desde quando
-- está parada.
create function mavi_private.job_alert_send(c uuid, p_people uuid[], p_job text, p_kind text,
 p_rows jsonb default '[]', p_since timestamptz default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare k record; r jsonb := p_rows -> 0; n integer := jsonb_array_length(coalesce(p_rows, '[]'));
 v_item text; v_title text; v_body text; v_link text; v_list text; v_count integer; begin
 select * into k from mavi_private.job_catalog() x where x.job = p_job;
 if k.job is null or cardinality(coalesce(p_people, '{}')) = 0 then return 0; end if;
 v_item := case when n = 1 and coalesce(r ->> 'label', '') <> '' then ' · ' || (r ->> 'label') else '' end;
 v_list := (select string_agg(case when coalesce(x ->> 'label', '') <> '' then (x ->> 'label') || ': ' else '' end
   || coalesce(x ->> 'error', ''), ' · ') from jsonb_array_elements(coalesce(p_rows, '[]')) x);
 v_link := case when n = 1 and p_job in ('ads_sync', 'ads_today', 'campaign_insights', 'campaign_daily')
  and (r ->> 'subject') ~ '^[0-9a-f-]{36}$'
  then '/campanhas/' || (r ->> 'subject') || case when p_job = 'campaign_insights' then '?aba=insights' else '' end
  else k.link end;
 case p_kind
  when 'fail' then
   if n > 1 then
    v_title := format('Falhou: %s em %s %s', k.label, n, k.nouns);
    v_body := v_list;
   else
    v_title := 'Falhou: ' || k.label || v_item;
    v_body := case when (r ->> 'streak')::int > 1 then format('%s vezes seguidas. Último erro: ', r ->> 'streak')
     else 'Erro: ' end || coalesce(r ->> 'error', '');
   end if;
  when 'remind' then
   if n > 1 then
    v_title := format('Ainda falhando: %s em %s %s', k.label, n, k.nouns);
    v_body := v_list;
   else
    v_title := 'Ainda falhando: ' || k.label || v_item;
    v_body := format('Desde %s, %s %s seguidas. Último erro: %s',
     mavi_private.job_when(c, (r ->> 'since')::timestamptz), r ->> 'streak',
     case when (r ->> 'streak')::int = 1 then 'falha' else 'falhas' end, coalesce(r ->> 'error', ''));
   end if;
  when 'recover' then
   if n > 1 then
    v_title := format('Voltou a funcionar: %s em %s %s', k.label, n, k.nouns);
    v_body := 'Voltaram: ' || (select string_agg(nullif(x ->> 'label', ''), ', ') from jsonb_array_elements(p_rows) x)
     || '.';
   else
    v_title := 'Voltou a funcionar: ' || k.label || v_item;
    v_body := format('Estava falhando desde %s.', mavi_private.job_when(c, (r ->> 'since')::timestamptz));
   end if;
  when 'stale' then
   v_title := 'Parada: ' || k.label;
   v_body := format('Nenhuma execução com sucesso há %s (a última foi em %s).', mavi_private.job_span(p_since),
    mavi_private.job_when(c, p_since));
  when 'stale_remind' then
   v_title := 'Ainda parada: ' || k.label;
   v_body := format('Nenhuma execução com sucesso há %s (a última foi em %s).', mavi_private.job_span(p_since),
    mavi_private.job_when(c, p_since));
  when 'stale_recover' then
   v_title := 'Voltou a funcionar: ' || k.label;
   v_body := case when p_since is null then 'Voltou a rodar com sucesso.'
    else format('Estava parada desde %s.', mavi_private.job_when(c, p_since)) end;
  when 'test' then
   v_title := 'Teste: ' || k.label;
   v_body := 'Aviso de teste. Os avisos de falha desta rotina chegam assim, na caixa de entrada e no navegador.';
 end case;
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select c, u, null, null, 'job_alert', left(v_title, 300), left(v_body, 500), v_link from unnest(p_people) u;
 get diagnostics v_count = row_count;
 return v_count;
end $$;

-- A rodada (pg_cron a cada 2 minutos): falhas novas, lembretes, voltas e
-- rotinas paradas, por empresa e rotina. Devolve quantos avisos saíram.
create function mavi_private.job_alerts_run() returns integer
language plpgsql security definer set search_path = '' as $$
declare k record; cfg public.job_alert_settings; v_people uuid[]; v_rows jsonb; st mavi_private.job_status;
 n integer := 0; begin
 for k in
  select x.company_id, c.* from (select company_id, job from mavi_private.job_status
   union select company_id, job from mavi_private.job_failures) x
  join mavi_private.job_catalog() c on c.job = x.job
  order by x.company_id, c.sort
 loop
  begin
   cfg := mavi_private.job_alert_config(k.company_id, k.job);
   v_people := case when cfg.active then mavi_private.job_alert_people(k.company_id, cfg.recipients) else '{}' end;
   if cardinality(v_people) = 0 then
    -- Desligada (ou sem ninguém para avisar): as voltas não ficam esperando.
    delete from mavi_private.job_failures
    where company_id = k.company_id and job = k.job and recovered_at is not null;
    update mavi_private.job_status set stale_recovered_at = null, stale_since = null
    where company_id = k.company_id and job = k.job and stale_recovered_at is not null;
    continue;
   end if;

   -- Falhas novas: os itens que chegaram a N falhas seguidas.
   if k.fails and cfg.fail_after is not null then
    with u as (
     update mavi_private.job_failures set alerted_at = now(), reminded_at = now()
     where company_id = k.company_id and job = k.job and alerted_at is null and recovered_at is null
      and streak >= cfg.fail_after
     returning subject, label, streak, since, last_error, last_error_at)
    select jsonb_agg(jsonb_build_object('subject', subject, 'label', label, 'streak', streak, 'since', since,
     'error', last_error) order by last_error_at desc) into v_rows from u;
    if v_rows is not null then
     n := n + mavi_private.job_alert_send(k.company_id, v_people, k.job, 'fail', v_rows);
    end if;
   end if;

   -- Lembretes: os itens avisados que continuam falhando.
   if cfg.remind_hours is not null then
    with u as (
     update mavi_private.job_failures set reminded_at = now()
     where company_id = k.company_id and job = k.job and alerted_at is not null and streak > 0
      and reminded_at <= now() - make_interval(hours => cfg.remind_hours)
     returning subject, label, streak, since, last_error, last_error_at)
    select jsonb_agg(jsonb_build_object('subject', subject, 'label', label, 'streak', streak, 'since', since,
     'error', last_error) order by last_error_at desc) into v_rows from u;
    if v_rows is not null then
     n := n + mavi_private.job_alert_send(k.company_id, v_people, k.job, 'remind', v_rows);
    end if;
   end if;

   -- Voltas: os itens avisados que voltaram a funcionar.
   with d as (
    delete from mavi_private.job_failures
    where company_id = k.company_id and job = k.job and recovered_at is not null
    returning subject, label, alerted_streak, since)
   select jsonb_agg(jsonb_build_object('subject', subject, 'label', label, 'streak', alerted_streak,
    'since', since) order by label) into v_rows from d;
   if v_rows is not null and cfg.notify_recovery then
    n := n + mavi_private.job_alert_send(k.company_id, v_people, k.job, 'recover', v_rows);
   end if;

   -- Parada: nenhum sucesso há X horas (só depois do primeiro sucesso).
   select * into st from mavi_private.job_status where company_id = k.company_id and job = k.job for update;
   if st.company_id is not null then
    if st.stale_recovered_at is not null then
     if cfg.notify_recovery then
      n := n + mavi_private.job_alert_send(k.company_id, v_people, k.job, 'stale_recover', '[]', st.stale_since);
     end if;
     update mavi_private.job_status set stale_recovered_at = null, stale_since = null
     where company_id = k.company_id and job = k.job;
    elsif k.stale_ok and cfg.stale_hours is not null and st.last_ok_at is not null
     and st.last_ok_at < now() - make_interval(hours => cfg.stale_hours) then
     if st.stale_alerted_at is null then
      n := n + mavi_private.job_alert_send(k.company_id, v_people, k.job, 'stale', '[]', st.last_ok_at);
      update mavi_private.job_status set stale_alerted_at = now(), stale_reminded_at = now(), stale_since = st.last_ok_at
      where company_id = k.company_id and job = k.job;
     elsif cfg.remind_hours is not null and st.stale_reminded_at <= now() - make_interval(hours => cfg.remind_hours) then
      n := n + mavi_private.job_alert_send(k.company_id, v_people, k.job, 'stale_remind', '[]', st.last_ok_at);
      update mavi_private.job_status set stale_reminded_at = now() where company_id = k.company_id and job = k.job;
     end if;
    end if;
   end if;
  exception when others then
   raise warning 'job alerts % failed: %', k.job, sqlerrm;
  end;
 end loop;
 return n;
end $$;

revoke all on function mavi_private.job_alert_config(uuid, text), mavi_private.job_alert_people(uuid, uuid[]),
 mavi_private.job_when(uuid, timestamptz), mavi_private.job_span(timestamptz),
 mavi_private.job_alert_send(uuid, uuid[], text, text, jsonb, timestamptz), mavi_private.job_alerts_run()
 from public, anon, authenticated;

-- ------------------------------------------------------------ a tela
-- As rotinas com a escolha do admin, os padrões e como estão agora.
create function public.job_alerts(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os avisos de falhas.' using errcode = '42501';
 end if;
 return (select coalesce(jsonb_agg(jsonb_build_object(
  'job', k.job, 'label', k.label, 'noun', k.noun, 'nouns', k.nouns, 'fails', k.fails, 'stale_ok', k.stale_ok,
  'link', k.link,
  'defaults', jsonb_build_object('fail_after', k.fail_after, 'stale_hours', k.stale_hours),
  'custom', s.job is not null,
  'settings', jsonb_build_object('active', cfg.active, 'fail_after', cfg.fail_after, 'stale_hours', cfg.stale_hours,
   'notify_recovery', cfg.notify_recovery, 'remind_hours', cfg.remind_hours, 'recipients', cfg.recipients),
  'health', jsonb_build_object(
   'seen', st.company_id is not null or exists (select 1 from mavi_private.job_failures f
    where f.company_id = p_company and f.job = k.job),
   'last_ok_at', st.last_ok_at, 'last_fail_at', st.last_fail_at, 'last_error', st.last_error,
   'stale', k.stale_ok and cfg.stale_hours is not null and st.last_ok_at < now() - make_interval(hours => cfg.stale_hours),
   'failing_count', (select count(*) from mavi_private.job_failures f
    where f.company_id = p_company and f.job = k.job and f.streak > 0),
   'failing', coalesce((select jsonb_agg(jsonb_build_object('label', f.label, 'streak', f.streak, 'since', f.since,
     'error', f.last_error, 'alerted', f.alerted_at is not null) order by f.last_error_at desc)
    from (select * from mavi_private.job_failures f where f.company_id = p_company and f.job = k.job and f.streak > 0
     order by f.last_error_at desc limit 5) f), '[]'))
) order by k.sort), '[]')
 from mavi_private.job_catalog() k
 left join public.job_alert_settings s on s.company_id = p_company and s.job = k.job
 left join mavi_private.job_status st on st.company_id = p_company and st.job = k.job
 cross join lateral (select mavi_private.job_alert_config(p_company, k.job) as c) x
 cross join lateral (select (x.c).*) cfg);
end $$;

-- Salva a escolha do admin ({active, fail_after, stale_hours, notify_recovery,
-- remind_hours, recipients}); nulo volta ao padrão.
create function public.save_job_alert(p_company uuid, p_job text, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k record; v_recipients uuid[]; v_fail integer; v_stale integer; v_remind integer; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os avisos de falhas.' using errcode = '42501';
 end if;
 select * into k from mavi_private.job_catalog() x where x.job = p_job;
 if k.job is null then raise exception 'Rotina desconhecida.' using errcode = '22023'; end if;
 if p_settings is null then
  delete from public.job_alert_settings where company_id = p_company and job = p_job;
  return public.job_alerts(p_company);
 end if;
 if jsonb_typeof(p_settings) <> 'object' then raise exception 'Configuração inválida.' using errcode = '22023'; end if;
 v_fail := case when k.fails then (p_settings ->> 'fail_after')::integer end;
 v_stale := case when k.stale_ok then (p_settings ->> 'stale_hours')::integer end;
 v_remind := (p_settings ->> 'remind_hours')::integer;
 if v_fail is not null and v_fail not between 1 and 50 then
  raise exception 'Escolha de 1 a 50 falhas seguidas.' using errcode = '22023';
 end if;
 if v_stale is not null and v_stale not between 1 and 720 then
  raise exception 'Escolha de 1 a 720 horas sem funcionar.' using errcode = '22023';
 end if;
 if v_remind is not null and v_remind not between 1 and 168 then
  raise exception 'Escolha lembrar a cada 1 a 168 horas.' using errcode = '22023';
 end if;
 if jsonb_typeof(p_settings -> 'recipients') = 'array' then
  v_recipients := array(select distinct x::uuid from jsonb_array_elements_text(p_settings -> 'recipients') x);
  if exists (select 1 from unnest(v_recipients) u where not exists (select 1 from public.memberships m
   where m.company_id = p_company and m.user_id = u and m.active)) then
   raise exception 'Escolha pessoas ativas deste espaço.' using errcode = '22023';
  end if;
  if cardinality(v_recipients) = 0 then
   raise exception 'Escolha ao menos uma pessoa (ou todos os administradores).' using errcode = '22023';
  end if;
 end if;
 insert into public.job_alert_settings as s(company_id, job, active, fail_after, stale_hours, notify_recovery,
  remind_hours, recipients, updated_by, updated_at)
 values (p_company, p_job, coalesce((p_settings ->> 'active')::boolean, true), v_fail, v_stale,
  coalesce((p_settings ->> 'notify_recovery')::boolean, true), v_remind, v_recipients, auth.uid(), now())
 on conflict (company_id, job) do update set active = excluded.active, fail_after = excluded.fail_after,
  stale_hours = excluded.stale_hours, notify_recovery = excluded.notify_recovery,
  remind_hours = excluded.remind_hours, recipients = excluded.recipients, updated_by = excluded.updated_by,
  updated_at = now();
 return public.job_alerts(p_company);
end $$;

-- Um aviso de teste para quem recebe os avisos da rotina.
create function public.test_job_alert(p_company uuid, p_job text) returns integer
language plpgsql security definer set search_path = '' as $$
declare cfg public.job_alert_settings; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores configuram os avisos de falhas.' using errcode = '42501';
 end if;
 if not exists (select 1 from mavi_private.job_catalog() x where x.job = p_job) then
  raise exception 'Rotina desconhecida.' using errcode = '22023';
 end if;
 cfg := mavi_private.job_alert_config(p_company, p_job);
 return mavi_private.job_alert_send(p_company, mavi_private.job_alert_people(p_company, cfg.recipients), p_job, 'test');
end $$;

revoke all on function public.job_alerts(uuid), public.save_job_alert(uuid, text, jsonb),
 public.test_job_alert(uuid, text) from public, anon;
grant execute on function public.job_alerts(uuid), public.save_job_alert(uuid, text, jsonb),
 public.test_job_alert(uuid, text) to authenticated;

-- ------------------------------------------------------------ ponto de partida
-- O último sucesso que cada rotina já tem (o aviso de parada só vale depois
-- do primeiro sucesso) e a falha da varredura que estiver valendo agora.
insert into mavi_private.job_status(company_id, job, last_ok_at)
select company_id, 'whatsapp_sweep', last_sweep_at from mavi_private.whatsapp_config where last_sweep_at is not null
union all
select company_id, 'ads_sync', max(created_at) from public.ad_sync_runs
 where status = 'ok' and trigger = 'schedule' group by company_id
union all
select company_id, 'ads_today', max(read_at) from public.ad_today_metrics where read_at is not null group by company_id
union all
select company_id, 'campaign_daily', max(finished_at) from public.campaign_daily_reads
 where status = 'done' and finished_at is not null group by company_id
union all
select company_id, 'agent_sync', max(last_sync_at) from public.agent_instances
 where last_sync_at is not null group by company_id
union all
select y.company_id, 'make_leads', max(s.seen_at) from public.ad_cycles y cross join mavi_private.make_capture_state s
 where y.destination = 'make_landing_page' and s.seen_at is not null group by y.company_id
on conflict do nothing;

insert into mavi_private.job_failures(company_id, job, subject, streak, since, last_error, last_error_at)
select company_id, 'whatsapp_sweep', '', 1, now(), left(last_sweep_error, 1000), now()
from mavi_private.whatsapp_config where last_sweep_error is not null
on conflict do nothing;
update mavi_private.job_status s set last_fail_at = now(), last_error = left(w.last_sweep_error, 1000)
from mavi_private.whatsapp_config w
where s.company_id = w.company_id and s.job = 'whatsapp_sweep' and w.last_sweep_error is not null;

-- ------------------------------------------------------------ agendamento
-- O PostgreSQL dos testes não tem pg_cron.
do $$ begin
 if exists(select 1 from pg_available_extensions where name = 'pg_cron') then
  create extension if not exists pg_cron;
  perform cron.schedule('mavi-job-alerts', '*/2 * * * *', 'select mavi_private.job_alerts_run()');
 else
  raise notice 'pg_cron unavailable: schedule mavi_private.job_alerts_run() on the hosted database';
 end if;
end $$;

commit;
