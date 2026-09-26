begin;

-- Social Leads, segunda leva:
-- 1. Mídias do briefing: prova social (imagem, vídeo, áudio), logo e
--    elementos visuais (imagem, vídeo) vão para o Drive do cliente; o
--    briefing guarda só os ids (e o nome, tipo e tamanho lidos do Drive).
-- 2. Quanto a IA custou: cada chamada à API da Claude (geração, ajuste,
--    busca de cores) é registrada com os tokens e o valor em dólar, e o
--    plano mostra o total.
-- 3. Caixa de entrada: o fim de uma geração avisa quem a pediu. Os avisos
--    deixam de ser só de tarefas (task_id passa a ser opcional; título,
--    texto e endereço próprios para os demais).

-- ------------------------------------------------------------ 1. mídias
alter table public.social_leads_briefings add column media jsonb not null default '{}'
 check (jsonb_typeof(media) = 'object');

-- As mídias como o briefing guarda, lidas do Drive (não confia no navegador).
create function mavi_private.social_leads_media(c uuid, p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare k text; out jsonb := '{}'; list jsonb; x jsonb; f public.drive_files; begin
 if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Mídias inválidas.' using errcode = '22023'; end if;
 for k in select jsonb_object_keys(p) loop
  if k not in ('socialProof', 'brandLogo', 'brandVisualElements') then
   raise exception 'Campo de mídia desconhecido: %', k using errcode = '22023';
  end if;
  if jsonb_typeof(p->k) <> 'array' or jsonb_array_length(p->k) > 30 then
   raise exception 'Envie até 30 arquivos por campo.' using errcode = '22023';
  end if;
  list := '[]';
  for x in select value from jsonb_array_elements(p->k) loop
   if jsonb_typeof(x->'id') is distinct from 'string' or (x->>'id') !~ '^[0-9a-f-]{36}$' then
    raise exception 'Arquivo inválido.' using errcode = '22023';
   end if;
   select * into f from public.drive_files where company_id = c and id = (x->>'id')::uuid and status = 'ready';
   if not found then raise exception 'Arquivo não encontrado no Drive.' using errcode = 'P0002'; end if;
   list := list || jsonb_build_object('id', f.id, 'name', f.name, 'type', f.content_type, 'size', f.size_bytes);
  end loop;
  if jsonb_array_length(list) > 0 then out := out || jsonb_build_object(k, list); end if;
 end loop;
 return out;
end $$;
revoke all on function mavi_private.social_leads_media(uuid, jsonb) from public, anon, authenticated;

drop function public.save_social_leads_briefing(uuid, uuid, jsonb, text, uuid, integer);
-- p_media null: as mídias ficam como estão.
create function public.save_social_leads_briefing(p_company uuid, p_contract uuid, p_fields jsonb,
 p_objective text, p_responsible uuid, p_version integer, p_media jsonb default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare b public.social_leads_briefings; k text; v integer; clean jsonb := '{}'; m jsonb; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para editar o briefing deste cliente.' using errcode = '42501';
 end if;
 if p_fields is null or jsonb_typeof(p_fields) <> 'object' then raise exception 'Briefing inválido.' using errcode = '22023'; end if;
 for k in select jsonb_object_keys(p_fields) loop
  if k not in ('clientName','segment','contactName','contactWhats','briefingDate','businessWhat','positioning',
   'marketRegion','competitors','differentiators','swotForcas','swotFraquezas','swotOportunidades','swotAmeacas',
   'targetAudience','socialProof','igHandle','fbHandle','websiteUrl','toneRefs','featuredOffer','averageTicket',
   'mediaBudget','notes','brandColors','brandLogo','brandVisualElements') then
   raise exception 'Campo desconhecido no briefing: %', k using errcode = '22023';
  end if;
  if jsonb_typeof(p_fields->k) = 'null' then continue; end if;
  if jsonb_typeof(p_fields->k) <> 'string' then raise exception 'Campo % inválido.', k using errcode = '22023'; end if;
  if length(p_fields->>k) > 8000 then raise exception 'O campo % passou de 8.000 caracteres.', k using errcode = '22023'; end if;
  if length(trim(p_fields->>k)) > 0 then clean := clean || jsonb_build_object(k, p_fields->>k); end if;
 end loop;
 if p_objective is not null and p_objective not in ('form_nativo', 'ctwa') then
  raise exception 'Objetivo de campanha inválido.' using errcode = '22023';
 end if;
 if p_responsible is not null and not exists (select 1 from public.memberships
  where company_id = p_company and user_id = p_responsible) then
  raise exception 'Responsável não encontrado.' using errcode = 'P0002';
 end if;
 m := case when p_media is null then null else mavi_private.social_leads_media(p_company, p_media) end;
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract for update;
 if not found then
  if p_version is not null then raise exception 'O briefing foi removido. Recarregue a página.' using errcode = '40001'; end if;
  insert into public.social_leads_briefings(company_id, contract_id, fields, campaign_objective, responsible_id, media, updated_by)
  values (p_company, p_contract, clean, p_objective, p_responsible, coalesce(m, '{}'), auth.uid());
  return 1;
 end if;
 if p_version is distinct from b.version then
  raise exception 'Outra pessoa salvou este briefing antes. Recarregue para ver a versão atual.' using errcode = '40001';
 end if;
 update public.social_leads_briefings set fields = clean, campaign_objective = p_objective,
  responsible_id = p_responsible, media = coalesce(m, media), version = version + 1, updated_by = auth.uid(), updated_at = now()
 where company_id = p_company and contract_id = p_contract returning version into v;
 return v;
end $$;
revoke all on function public.save_social_leads_briefing(uuid, uuid, jsonb, text, uuid, integer, jsonb) from public, anon;
grant execute on function public.save_social_leads_briefing(uuid, uuid, jsonb, text, uuid, integer, jsonb) to authenticated;

-- Para o servidor conferir quem pode pedir algo à IA (ex.: buscar as cores).
create function public.social_leads_check_write(p_company uuid, p_contract uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para editar este cliente.' using errcode = '42501';
 end if;
 return true;
end $$;
revoke all on function public.social_leads_check_write(uuid, uuid) from public, anon;
grant execute on function public.social_leads_check_write(uuid, uuid) to authenticated;

-- A geração também recebe as mídias (os nomes dos arquivos, para a IA saber o que existe).
create or replace function public.social_leads_start_job(p_company uuid, p_contract uuid, p_plan uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.social_leads_jobs; b public.social_leads_briefings; cl public.clients; prev uuid; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para gerar o plano deste cliente.' using errcode = '42501';
 end if;
 if p_kind not in ('new', 'current') then raise exception 'Tipo de geração inválido.' using errcode = '22023'; end if;
 if p_kind = 'current' and not exists (select 1 from public.social_leads_plans
  where id = p_plan and company_id = p_company and contract_id = p_contract) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract;
 if not found then raise exception 'Preencha o briefing antes de gerar o plano.' using errcode = '22023'; end if;
 if p_kind = 'current' and (select count(*) from public.social_leads_posts where plan_id = p_plan and decision = 'approved') = 8 then
  raise exception 'Plano aprovado: os 8 posts foram aprovados.' using errcode = '55000';
 end if;
 update public.social_leads_jobs set status = 'failed', error = 'A geração demorou demais e foi interrompida.', finished_at = now()
 where contract_id = p_contract and status = 'running' and created_at < now() - interval '15 minutes';
 if exists (select 1 from public.social_leads_jobs where contract_id = p_contract and status = 'running') then
  raise exception 'Já existe uma geração em andamento para este cliente.' using errcode = '55P03';
 end if;
 insert into public.social_leads_jobs(company_id, contract_id, plan_id, kind)
 values (p_company, p_contract, case when p_kind = 'current' then p_plan end, p_kind) returning * into j;
 select cl2.* into cl from public.contracts k join public.clients cl2 on cl2.company_id = k.company_id and cl2.id = k.client_id
 where k.company_id = p_company and k.id = p_contract;
 if p_kind = 'new' then
  select id into prev from public.social_leads_plans where contract_id = p_contract order by month_number desc limit 1;
 else prev := p_plan; end if;
 return jsonb_build_object('job', j.id, 'client_name', cl.name, 'briefing', b.fields, 'media', b.media,
  'campaign_objective', b.campaign_objective,
  'responsible', (select name from public.memberships where company_id = p_company and user_id = b.responsible_id),
  'next_month', coalesce((select max(month_number) from public.social_leads_plans where contract_id = p_contract), 0) + 1,
  'previous', case when prev is null then null else mavi_private.social_leads_full(prev) end);
end $$;

-- ------------------------------------------------------------ 2. custo da IA
create table public.social_leads_ai_usage (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid,
 job_id uuid references public.social_leads_jobs(id) on delete set null,
 kind text not null check (kind in ('generate', 'adjust', 'colors')),
 model text not null,
 input_tokens integer not null default 0 check (input_tokens >= 0),
 output_tokens integer not null default 0 check (output_tokens >= 0),
 cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
 cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
 cost_usd numeric(12, 6) not null default 0 check (cost_usd >= 0),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 foreign key (company_id, contract_id) references public.contracts(company_id, id),
 foreign key (company_id, plan_id) references public.social_leads_plans(company_id, id) on delete set null
);
create index social_leads_ai_usage_plan on public.social_leads_ai_usage(plan_id) where plan_id is not null;
create index social_leads_ai_usage_contract on public.social_leads_ai_usage(company_id, contract_id, created_at desc);
alter table public.social_leads_ai_usage enable row level security;
revoke all on public.social_leads_ai_usage from anon, authenticated;
grant select on public.social_leads_ai_usage to authenticated;
create policy social_leads_ai_usage_read on public.social_leads_ai_usage for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));

-- O servidor registra cada chamada à IA (como a pessoa que pediu).
create function public.social_leads_log_usage(p_company uuid, p_contract uuid, p_plan uuid, p_job uuid,
 p_kind text, p_model text, p_input integer, p_output integer, p_cache_read integer, p_cache_write integer,
 p_cost numeric) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão.' using errcode = '42501';
 end if;
 if p_plan is not null and not exists (select 1 from public.social_leads_plans
  where id = p_plan and company_id = p_company and contract_id = p_contract) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if p_job is not null and not exists (select 1 from public.social_leads_jobs
  where id = p_job and contract_id = p_contract and created_by = auth.uid()) then
  raise exception 'Geração não encontrada.' using errcode = 'P0002';
 end if;
 if p_cost is null or p_cost < 0 or p_cost > 100 then raise exception 'Custo inválido.' using errcode = '22023'; end if;
 insert into public.social_leads_ai_usage(company_id, contract_id, plan_id, job_id, kind, model, input_tokens,
  output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
 values (p_company, p_contract, p_plan, p_job, p_kind, left(coalesce(p_model, ''), 80), greatest(coalesce(p_input, 0), 0),
  greatest(coalesce(p_output, 0), 0), greatest(coalesce(p_cache_read, 0), 0), greatest(coalesce(p_cache_write, 0), 0), p_cost);
end $$;
revoke all on function public.social_leads_log_usage(uuid, uuid, uuid, uuid, text, text, integer, integer, integer, integer, numeric)
 from public, anon;
grant execute on function public.social_leads_log_usage(uuid, uuid, uuid, uuid, text, text, integer, integer, integer, integer, numeric)
 to authenticated;

-- ------------------------------------------------------------ 3. caixa de entrada
alter table public.notifications alter column task_id drop not null;
alter table public.notifications add column title text, add column body text, add column link text;
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads'));
alter table public.notifications add constraint notifications_target_check
 check ((kind = 'social_leads') = (task_id is null) and (task_id is not null or (title is not null and link is not null)));

drop function public.my_notifications(uuid, integer);
create function public.my_notifications(p_company uuid, p_limit integer default 30)
returns table(id uuid, kind text, task_id uuid, task_title text, actor_id uuid, actor_name text,
 excerpt text, read_at timestamptz, created_at timestamptz, link text)
language sql stable security definer set search_path = '' as $$
 select n.id, n.kind, n.task_id, coalesce(t.title, n.title), n.actor_id, m.name,
  coalesce(nullif(left(regexp_replace(mavi_private.rich_plain(c.body), '\s+', ' ', 'g'), 160), ''), n.body),
  n.read_at, n.created_at, n.link
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

-- O push também leva os avisos que não são de tarefa.
create or replace function mavi_private.push_notification() returns trigger
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; subs jsonb; t public.tasks;
 actor text; excerpt text; title text; body text; url text; begin
 select * into cfg from mavi_private.push_config where id;
 if cfg.url is null then return null; end if;
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

-- O fim de uma geração avisa quem a pediu (pronto ou falhou), com o custo.
create or replace function public.social_leads_finish_job(p_job uuid, p_plan uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.social_leads_jobs; p public.social_leads_plans; client text; cost numeric; begin
 select * into j from public.social_leads_jobs where id = p_job for update;
 if not found or j.created_by <> auth.uid() then raise exception 'Geração não encontrada.' using errcode = 'P0002'; end if;
 if j.status <> 'running' then return; end if;
 update public.social_leads_jobs set status = case when p_error is null then 'done' else 'failed' end,
  error = left(p_error, 1000), plan_id = coalesce(p_plan, plan_id), finished_at = now()
 where id = p_job returning * into j;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = j.company_id and k.id = j.contract_id;
 select * into p from public.social_leads_plans where id = j.plan_id;
 select sum(cost_usd) into cost from public.social_leads_ai_usage where job_id = j.id;
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 values (j.company_id, j.created_by, null, null, 'social_leads',
  case when p_error is null then format('Plano do %s de %s pronto', coalesce(p.label, 'mês'), client)
   else format('A geração do plano de %s falhou', client) end,
  case when p_error is null
   then 'Revise os posts e envie para o cliente aprovar.'
    || coalesce(format(' Custo da IA: US$ %s.', replace(to_char(cost, 'FM9990.00'), '.', ',')), '')
   else left(p_error, 300) end,
  '/onboarding/social-leads?contrato=' || j.contract_id);
end $$;

commit;
