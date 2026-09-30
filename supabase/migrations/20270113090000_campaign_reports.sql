begin;

-- Campanhas › Relatórios: um relatório é uma foto de um período da campanha,
-- guardada para sempre (até alguém excluir), que pode ter um link público
-- (/relatorio/<token>) para o cliente, com validade e senha opcionais, como
-- o das gravações (migração 20270104090000).
--
-- - Os números da campanha vêm dos registros do Dia a Dia
--   (ad_daily_metrics), copiados no momento em que o relatório é criado: o
--   relatório não muda mais, mesmo que alguém edite um registro depois.
-- - Os anúncios e os conjuntos (com a imagem do criativo) e o alcance do
--   período vêm do Meta, lidos por /api/ads na criação (p_meta).
-- - O que o relatório mostra (métricas, gráficos, anúncios, análise da
--   MAVI, filtro de período, valores com ou sem M) fica em config e pode
--   mudar depois; os números, não.
-- - Com M ou sem M: o banco entrega os valores já calculados. O M e os
--   valores do outro jeito nunca saem no link público.
--
-- Quem vê a campanha cria relatórios; quem criou ou um líder altera,
-- desativa o link e exclui. Desativar o link apaga o endereço: um novo link
-- terá outro endereço. A MAVI escreve a análise pela funcionalidade
-- 'campaign_report' do Painel da MAVI.
create table public.ad_reports (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 campaign_id uuid not null,
 title text not null check (length(btrim(title)) between 2 and 160),
 period_start date not null,
 period_end date not null,
 config jsonb not null default '{}'
  check (jsonb_typeof(config) = 'object' and octet_length(config::text) <= 20000),
 data jsonb not null check (jsonb_typeof(data) = 'object'),
 analysis text not null default '' check (length(analysis) <= 20000),
 token text unique check (token is null or token ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz,
 password_hash text,
 -- Senhas erradas: 10 em 15 minutos bloqueiam o link por um tempo.
 failures integer not null default 0,
 failures_since timestamptz,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_by uuid,
 updated_at timestamptz not null default now(),
 check (period_end >= period_start and period_end - period_start < 400),
 unique (company_id, id),
 foreign key (company_id, campaign_id) references public.ad_campaigns(company_id, id) on delete cascade,
 foreign key (company_id, created_by) references public.memberships(company_id, user_id)
);
create index ad_reports_campaign on public.ad_reports(company_id, campaign_id, created_at desc);
alter table public.ad_reports enable row level security;
revoke all on public.ad_reports from public, anon, authenticated;

create function mavi_private.ad_report_token() returns text
language sql volatile set search_path = '' as $$
 select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

-- A campanha, para quem a vê (líder, ou o módulo ligado com o cliente numa
-- equipe da pessoa).
create function mavi_private.ad_report_campaign(p_campaign uuid) returns public.ad_campaigns
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 select * into a from public.ad_campaigns where id = p_campaign;
 if not found or not mavi_private.module_client(a.company_id, 'campaigns', mavi_private.ad_campaign_client(a.id)) then
  raise exception 'Sem acesso a esta campanha.' using errcode = '42501';
 end if;
 return a;
end $$;

create function mavi_private.ad_report_row(p_id uuid) returns public.ad_reports
language plpgsql stable security definer set search_path = '' as $$
declare r public.ad_reports; begin
 select * into r from public.ad_reports where id = p_id;
 if not found then
  raise exception 'Relatório não encontrado.' using errcode = 'P0002';
 end if;
 perform mavi_private.ad_report_campaign(r.campaign_id);
 return r;
end $$;

create function mavi_private.ad_report_can_manage(r public.ad_reports) returns boolean
language sql stable security definer set search_path = '' as $$
 select r.created_by = auth.uid() or mavi_private.leader(r.company_id)
$$;

-- Os anúncios ou conjuntos com o gasto de cada dia com ou sem M (o M do
-- dia, pesado pelo gasto no dia da troca de ciclo; sem registro no dia, o
-- M do último ciclo).
create function mavi_private.ad_report_items(items jsonb, factors jsonb, fallback numeric, with_m boolean)
returns jsonb
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_agg(i || jsonb_build_object('days', (
   select coalesce(jsonb_agg(d || jsonb_build_object('s', round(coalesce((d->>'s')::numeric, 0)
     * case when with_m then coalesce((factors->>(d->>'d'))::numeric, fallback, 1) else 1 end, 2))
    order by d->>'d'), '[]')
   from jsonb_array_elements(case when jsonb_typeof(i->'days') = 'array' then i->'days' else '[]' end) d))
  order by t.ord), '[]')
 from jsonb_array_elements(case when jsonb_typeof(items) = 'array' then items else '[]' end) with ordinality as t(i, ord)
$$;

-- O que o relatório mostra: os números já com ou sem M (config.with_m), sem
-- o M de nenhum dia ou ciclo.
create function mavi_private.ad_report_view(r public.ad_reports) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare with_m boolean := coalesce((r.config->>'with_m')::boolean, false); factors jsonb; days jsonb;
 cycles jsonb; fallback numeric; begin
 select coalesce(jsonb_object_agg(t.day, t.f), '{}') into factors from (
  select x->>'day' as day, case when sum((x->>'spend')::numeric) > 0
    then sum((x->>'spend')::numeric * (x->>'m')::numeric) / sum((x->>'spend')::numeric)
    else max((x->>'m')::numeric) end as f
  from jsonb_array_elements(coalesce(r.data->'days', '[]')) x group by 1) t;
 select (c->>'multiplier')::numeric into fallback
  from jsonb_array_elements(coalesce(r.data->'cycles', '[]')) c order by c->>'start_date' desc limit 1;
 select coalesce(jsonb_agg(jsonb_build_object('day', t.day, 'spend', round(t.spend, 2), 'impressions', t.impressions,
   'reach', t.reach, 'clicks', t.clicks, 'conversions', t.conversions, 'view_content', t.view_content,
   'add_to_cart', t.add_to_cart, 'initiate_checkout', t.initiate_checkout) order by t.day), '[]') into days
 from (
  select x->>'day' as day,
   sum((x->>'spend')::numeric * case when with_m then (x->>'m')::numeric else 1 end) as spend,
   sum((x->>'impressions')::numeric) as impressions, sum((x->>'reach')::numeric) as reach,
   sum((x->>'clicks')::numeric) as clicks, sum((x->>'conversions')::numeric) as conversions,
   sum((x->>'view_content')::numeric) as view_content, sum((x->>'add_to_cart')::numeric) as add_to_cart,
   sum((x->>'initiate_checkout')::numeric) as initiate_checkout
  from jsonb_array_elements(coalesce(r.data->'days', '[]')) x group by 1) t;
 select coalesce(jsonb_agg(jsonb_build_object('start_date', c->'start_date', 'end_date', c->'end_date',
   'objective', c->'objective', 'destination', c->'destination', 'goal_results', c->'goal_results',
   'budget', round(case when with_m then (c->>'budget')::numeric
    else (c->>'budget')::numeric / nullif((c->>'multiplier')::numeric, 0) end, 2))
   order by c->>'start_date'), '[]') into cycles
 from jsonb_array_elements(coalesce(r.data->'cycles', '[]')) c;
 return jsonb_build_object(
  'platform', r.data->'platform',
  'campaign_name', r.data->'campaign_name',
  'client_name', r.data->'client_name',
  'product_name', r.data->'product_name',
  'captured_at', r.data->'captured_at',
  'currency', coalesce(r.data->'meta'->'currency', '"BRL"'),
  'days', days,
  'cycles', cycles,
  'reach', r.data->'meta'->'reach',
  'ad_results', coalesce(r.data->'meta'->'ad_results', 'true'),
  'ads', mavi_private.ad_report_items(r.data->'meta'->'ads', factors, fallback, with_m),
  'adsets', mavi_private.ad_report_items(r.data->'meta'->'adsets', factors, fallback, with_m),
  'meta_error', r.data->'meta'->'error');
end $$;

-- O relatório para a aba (view: os números, só quando pedido).
create function mavi_private.ad_report_json(r public.ad_reports, p_view boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('id', r.id, 'campaign_id', r.campaign_id, 'title', r.title,
  'period_start', r.period_start, 'period_end', r.period_end, 'config', r.config, 'analysis', r.analysis,
  'created_by', r.created_by, 'created_at', r.created_at, 'updated_by', r.updated_by, 'updated_at', r.updated_at,
  'link', case when r.token is null then null else jsonb_build_object('token', r.token, 'expires_at', r.expires_at,
   'expired', r.expires_at is not null and r.expires_at <= now(), 'has_password', r.password_hash is not null) end,
  'can_manage', mavi_private.ad_report_can_manage(r),
  'view', case when p_view then mavi_private.ad_report_view(r) end)
$$;

revoke all on function mavi_private.ad_report_token(), mavi_private.ad_report_campaign(uuid),
 mavi_private.ad_report_row(uuid), mavi_private.ad_report_can_manage(public.ad_reports),
 mavi_private.ad_report_items(jsonb, jsonb, numeric, boolean), mavi_private.ad_report_view(public.ad_reports),
 mavi_private.ad_report_json(public.ad_reports, boolean) from public, anon, authenticated;

-- A senha nova (vazia: sem senha).
create function mavi_private.ad_report_password(p_password text) returns text
language plpgsql volatile set search_path = '' as $$ begin
 if nullif(p_password, '') is null then return null; end if;
 if length(p_password) < 4 or octet_length(p_password) > 72 then
  raise exception 'A senha precisa ter de 4 a 72 caracteres.' using errcode = '22023';
 end if;
 return extensions.crypt(p_password, extensions.gen_salt('bf', 8));
end $$;
revoke all on function mavi_private.ad_report_password(text) from public, anon, authenticated;

-- ------------------------------------------------------------ para /api/ads
-- Os ciclos do período e as contas e campanhas do Meta vinculadas a eles:
-- de onde /api/ads lê os anúncios na criação.
create function public.ad_report_sources(p_campaign uuid, p_start date, p_end date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 a := mavi_private.ad_report_campaign(p_campaign);
 return jsonb_build_object('platform', a.platform,
  'cycles', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'start_date', y.start_date,
    'end_date', y.end_date, 'objective', y.objective, 'destination', y.destination) order by y.start_date), '[]')
   from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
    and y.start_date <= p_end and y.end_date >= p_start),
  'links', (select coalesce(jsonb_agg(distinct jsonb_build_object('account_id', l.account_id,
    'campaign_id', l.external_campaign_id)), '[]')
   from public.ad_cycle_links l join public.ad_cycles y on y.company_id = l.company_id and y.id = l.cycle_id
   where y.company_id = a.company_id and y.campaign_id = a.id and y.start_date <= p_end and y.end_date >= p_start));
end $$;

-- ------------------------------------------------------------ gerenciar
create function public.ad_reports(p_campaign uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare a public.ad_campaigns; begin
 a := mavi_private.ad_report_campaign(p_campaign);
 return (select coalesce(jsonb_agg(mavi_private.ad_report_json(r, false) order by r.created_at desc), '[]')
  from public.ad_reports r where r.company_id = a.company_id and r.campaign_id = a.id);
end $$;

create function public.ad_report(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 return mavi_private.ad_report_json(mavi_private.ad_report_row(p_id), true);
end $$;

-- Cria o relatório: copia os registros do período (os do Dia a Dia) e
-- guarda o que /api/ads leu do Meta (p_meta). p_link: já com link público.
create function public.create_ad_report(p_campaign uuid, p_title text, p_start date, p_end date, p_config jsonb,
 p_meta jsonb default '{}', p_analysis text default '', p_link boolean default true,
 p_expires_at timestamptz default null, p_password text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.ad_campaigns; r public.ad_reports; v_client text; v_product text; begin
 a := mavi_private.ad_report_campaign(p_campaign);
 if length(btrim(coalesce(p_title, ''))) < 2 then
  raise exception 'Dê um nome ao relatório.' using errcode = '22023';
 end if;
 if p_start is null or p_end is null or p_end < p_start then
  raise exception 'Escolha o período do relatório.' using errcode = '22023';
 end if;
 if p_end - p_start >= 400 then
  raise exception 'O período do relatório pode ter até 400 dias.' using errcode = '22023';
 end if;
 if p_config is null or jsonb_typeof(p_config) <> 'object' then
  raise exception 'Escolha o que o relatório mostra.' using errcode = '22023';
 end if;
 if p_meta is not null and (jsonb_typeof(p_meta) <> 'object' or octet_length(p_meta::text) > 4000000) then
  raise exception 'Os anúncios do relatório passaram do tamanho aceito.' using errcode = '22023';
 end if;
 if p_link and p_expires_at is not null and p_expires_at <= now() then
  raise exception 'Escolha uma validade no futuro.' using errcode = '22023';
 end if;
 select c.name, p.name into v_client, v_product from public.contracts k
  join public.clients c on c.company_id = k.company_id and c.id = k.client_id
  join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where k.company_id = a.company_id and k.id = a.contract_id;
 insert into public.ad_reports(company_id, campaign_id, title, period_start, period_end, config, analysis, data,
  token, expires_at, password_hash)
 values (a.company_id, a.id, btrim(p_title), p_start, p_end, p_config, left(coalesce(p_analysis, ''), 20000),
  jsonb_build_object(
   'platform', a.platform, 'campaign_name', a.name, 'client_name', v_client, 'product_name', v_product,
   'captured_at', now(),
   'days', (select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'cycle', d.cycle_id, 'm', d.multiplier,
     'spend', d.spend, 'impressions', d.impressions, 'reach', d.reach, 'clicks', d.clicks,
     'conversions', d.conversions, 'view_content', d.view_content, 'add_to_cart', d.add_to_cart,
     'initiate_checkout', d.initiate_checkout) order by d.day), '[]')
    from public.ad_daily_metrics d
    where d.company_id = a.company_id and d.campaign_id = a.id and d.day between p_start and p_end),
   'cycles', (select coalesce(jsonb_agg(jsonb_build_object('id', y.id, 'start_date', y.start_date,
     'end_date', y.end_date, 'objective', y.objective, 'destination', y.destination,
     'goal_results', y.goal_results, 'budget', y.budget, 'multiplier', y.multiplier) order by y.start_date), '[]')
    from public.ad_cycles y where y.company_id = a.company_id and y.campaign_id = a.id
     and y.start_date <= p_end and y.end_date >= p_start),
   'meta', coalesce(p_meta, '{}')),
  case when coalesce(p_link, false) then mavi_private.ad_report_token() end,
  case when coalesce(p_link, false) then p_expires_at end,
  case when coalesce(p_link, false) then mavi_private.ad_report_password(p_password) end)
 returning * into r;
 perform mavi_private.ad_log(a.company_id, a.id, null, 'report_created', jsonb_build_object('report', r.id,
  'title', r.title, 'start', r.period_start, 'end', r.period_end, 'link', r.token is not null));
 return mavi_private.ad_report_json(r, true);
end $$;

-- Muda o nome, o que o relatório mostra e a análise (os números ficam).
create function public.update_ad_report(p_id uuid, p_title text, p_config jsonb, p_analysis text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.ad_reports; begin
 r := mavi_private.ad_report_row(p_id);
 if not mavi_private.ad_report_can_manage(r) then
  raise exception 'Só quem criou o relatório ou um líder altera o relatório.' using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_title, ''))) < 2 then
  raise exception 'Dê um nome ao relatório.' using errcode = '22023';
 end if;
 if p_config is null or jsonb_typeof(p_config) <> 'object' then
  raise exception 'Escolha o que o relatório mostra.' using errcode = '22023';
 end if;
 update public.ad_reports set title = btrim(p_title), config = p_config,
  analysis = left(coalesce(p_analysis, ''), 20000), updated_by = auth.uid(), updated_at = now()
 where id = r.id returning * into r;
 return mavi_private.ad_report_json(r, true);
end $$;

-- Liga, muda ou desativa o link. Desativar apaga o endereço; ligar de novo
-- cria outro. p_keep_password: mantém a senha que o link já tem.
create function public.set_ad_report_link(p_id uuid, p_enabled boolean, p_expires_at timestamptz default null,
 p_password text default null, p_keep_password boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.ad_reports; hash text; begin
 r := mavi_private.ad_report_row(p_id);
 if not mavi_private.ad_report_can_manage(r) then
  raise exception 'Só quem criou o relatório ou um líder altera o link.' using errcode = '42501';
 end if;
 if not coalesce(p_enabled, false) then
  update public.ad_reports set token = null, expires_at = null, password_hash = null, failures = 0,
   failures_since = null, updated_by = auth.uid(), updated_at = now()
  where id = r.id returning * into r;
  perform mavi_private.ad_log(r.company_id, r.campaign_id, null, 'report_unshared',
   jsonb_build_object('report', r.id, 'title', r.title));
  return mavi_private.ad_report_json(r, false);
 end if;
 if p_expires_at is not null and p_expires_at <= now() then
  raise exception 'Escolha uma validade no futuro.' using errcode = '22023';
 end if;
 hash := case when r.token is not null and coalesce(p_keep_password, true) then r.password_hash
  else mavi_private.ad_report_password(p_password) end;
 update public.ad_reports set token = coalesce(r.token, mavi_private.ad_report_token()), expires_at = p_expires_at,
  password_hash = hash, updated_by = auth.uid(), updated_at = now(),
  failures = case when hash is distinct from r.password_hash then 0 else failures end,
  failures_since = case when hash is distinct from r.password_hash then null else failures_since end
 where id = r.id returning * into r;
 perform mavi_private.ad_log(r.company_id, r.campaign_id, null, 'report_shared', jsonb_build_object('report', r.id,
  'title', r.title, 'expires_at', r.expires_at, 'password', r.password_hash is not null));
 return mavi_private.ad_report_json(r, false);
end $$;

create function public.delete_ad_report(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.ad_reports; begin
 r := mavi_private.ad_report_row(p_id);
 if not mavi_private.ad_report_can_manage(r) then
  raise exception 'Só quem criou o relatório ou um líder exclui o relatório.' using errcode = '42501';
 end if;
 delete from public.ad_reports where id = r.id;
 perform mavi_private.ad_log(r.company_id, r.campaign_id, null, 'report_deleted',
  jsonb_build_object('report', r.id, 'title', r.title, 'start', r.period_start, 'end', r.period_end));
end $$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any(array['ad_report_sources', 'ad_reports', 'ad_report',
   'create_ad_report', 'update_ad_report', 'set_ad_report_link', 'delete_ad_report']) loop
  execute format('revoke all on function %s from public, anon', f.signature);
  execute format('grant execute on function %s to authenticated', f.signature);
 end loop;
end $$;

-- ------------------------------------------------------------ link público
-- 'ok' | 'expired' | 'password' (pede a senha) | 'wrong' | 'locked'.
create function mavi_private.ad_report_access(r public.ad_reports, p_password text) returns text
language plpgsql volatile security definer set search_path = '' as $$ begin
 if r.expires_at is not null and r.expires_at <= now() then return 'expired'; end if;
 if r.password_hash is null then return 'ok'; end if;
 if r.failures >= 10 and r.failures_since > now() - interval '15 minutes' then return 'locked'; end if;
 if nullif(p_password, '') is null then return 'password'; end if;
 if r.password_hash = extensions.crypt(p_password, r.password_hash) then return 'ok'; end if;
 update public.ad_reports set
  failures = case when failures_since is null or failures_since < now() - interval '15 minutes' then 1 else failures + 1 end,
  failures_since = case when failures_since is null or failures_since < now() - interval '15 minutes'
   then now() else failures_since end
 where id = r.id;
 return 'wrong';
end $$;
revoke all on function mavi_private.ad_report_access(public.ad_reports, text) from public, anon, authenticated;

-- Só as seções ligadas saem no link (anúncios, conjuntos, meta e verba).
create function mavi_private.ad_report_public_view(r public.ad_reports) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v jsonb := mavi_private.ad_report_view(r); s jsonb := coalesce(r.config->'sections', '{}'); begin
 if not coalesce((s->>'ads')::boolean, false) then v := v - 'ads'; end if;
 if not coalesce((s->>'adsets')::boolean, false) then v := v - 'adsets'; end if;
 if not coalesce((s->>'goal')::boolean, false) then
  v := jsonb_set(v, '{cycles}', (select coalesce(jsonb_agg(c - 'budget' - 'goal_results'), '[]')
   from jsonb_array_elements(v->'cycles') c));
 end if;
 return v - 'meta_error';
end $$;
revoke all on function mavi_private.ad_report_public_view(public.ad_reports) from public, anon, authenticated;

-- A página pública: o que o relatório mostra, sem o M, sem quem criou e sem
-- as opções internas.
create function public.ad_report_public(p_token text, p_password text default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r public.ad_reports; access text; begin
 if p_token is null or p_token !~ '^[0-9a-f]{64}$' then return null; end if;
 select * into r from public.ad_reports where token = p_token;
 if not found then return null; end if;
 access := mavi_private.ad_report_access(r, p_password);
 if access <> 'ok' then return jsonb_build_object('status', access); end if;
 return jsonb_build_object('status', 'ok',
  'company', (select c.name from public.companies c where c.id = r.company_id),
  'title', r.title, 'period_start', r.period_start, 'period_end', r.period_end,
  'expires_at', r.expires_at,
  'config', r.config - 'with_m',
  'analysis', case when coalesce((r.config->'sections'->>'analysis')::boolean, false) then r.analysis else '' end,
  'view', mavi_private.ad_report_public_view(r));
end $$;
revoke all on function public.ad_report_public(text, text) from public;
grant execute on function public.ad_report_public(text, text) to anon, authenticated;

-- ------------------------------------------------------------ a MAVI
-- A análise do relatório (funcionalidade 'campaign_report' do Painel da MAVI).
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report')));

-- A da migração 20270112090000, com a análise dos relatórios de campanha.
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
  'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report') then
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
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro ou na conferência do Radar.'
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


commit;
