begin;

-- Social Leads, fase 2: produção e campanha.
-- 1. Configuração: a equipe de criação (quem recebe as tarefas de arte) e o
--    prazo da arte em dias.
-- 2. Liberar produção: uma tarefa por post aprovado, para a equipe de
--    criação (create_task distribui para quem tem menos tarefas em aberto),
--    com as direções do post. A primeira liberação também abre o ciclo do
--    cliente: acompanhamento quinzenal e reunião mensal, tarefas que se
--    repetem, para o responsável.
-- 3. Artes: os arquivos de cada post ficam no Drive do cliente e aparecem
--    no post, nos PDFs e no link do cliente (por um endereço temporário que
--    o servidor assina depois de conferir o token do link).
-- 4. Campanha: a campanha do Meta é criada a partir do plano (só líderes,
--    como o módulo Campanhas), e a etapa "No ar" vem da campanha ativa.

-- ------------------------------------------------------------ 1. configuração
alter table public.social_leads_settings
 add column design_team_id uuid,
 add column art_days integer not null default 5 check (art_days between 1 and 60),
 add foreign key (company_id, design_team_id) references public.teams(company_id, id);

drop function public.set_social_leads_settings(uuid, uuid, uuid);
create function public.set_social_leads_settings(p_company uuid, p_product uuid, p_team uuid,
 p_design_team uuid default null, p_art_days integer default 5) returns void
language plpgsql security definer set search_path = '' as $$
begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores configuram o Social Leads.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.products where company_id = p_company and id = p_product) then
  raise exception 'Produto não encontrado.' using errcode = 'P0002';
 end if;
 if p_team is not null and not exists (select 1 from public.teams where company_id = p_company and id = p_team) then
  raise exception 'Equipe não encontrada.' using errcode = 'P0002';
 end if;
 if p_design_team is not null and not exists (select 1 from public.teams where company_id = p_company and id = p_design_team) then
  raise exception 'Equipe de criação não encontrada.' using errcode = 'P0002';
 end if;
 if coalesce(p_art_days, 5) not between 1 and 60 then
  raise exception 'O prazo da arte precisa ser de 1 a 60 dias.' using errcode = '22023';
 end if;
 insert into public.social_leads_settings(company_id, product_id, team_id, design_team_id, art_days, updated_by, updated_at)
 values (p_company, p_product, p_team, p_design_team, coalesce(p_art_days, 5), auth.uid(), now())
 on conflict (company_id) do update set product_id = excluded.product_id, team_id = excluded.team_id,
  design_team_id = excluded.design_team_id, art_days = excluded.art_days,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;
revoke all on function public.set_social_leads_settings(uuid, uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.set_social_leads_settings(uuid, uuid, uuid, uuid, integer) to authenticated;

-- ------------------------------------------------------------ 2. produção
alter table public.social_leads_posts
 add column task_id uuid references public.tasks(id) on delete set null,
 -- [{id, name, type, size}] no Drive do cliente.
 add column arts jsonb not null default '[]' check (jsonb_typeof(arts) = 'array');
-- O ciclo do cliente: {followup: task_id, meeting: task_id}.
alter table public.social_leads_briefings add column cycle jsonb not null default '{}'
 check (jsonb_typeof(cycle) = 'object');

-- Texto das tarefas (a descrição aceita texto simples).
create function mavi_private.social_leads_task_text(x public.social_leads_posts, p_label text) returns text
language sql immutable set search_path = '' as $$
 select concat_ws(E'\n',
  'Gancho: ' || x.hook,
  'Direção de copy: ' || x.copy_direction,
  'Direção visual: ' || x.visual_direction,
  'Formato: ' || x.format,
  'CTA: ' || x.cta,
  case when x.is_ad then 'Este post também vira o anúncio do mês.' end,
  case when nullif(x.note, '') is not null then 'Observação do cliente: ' || x.note end,
  '',
  'Suba as artes no próprio post: Onboarding › Social Leads › ' || p_label || ' › Post ' || x.number || '.')
$$;

-- Acompanhamento quinzenal e reunião mensal (uma vez por cliente).
create function mavi_private.social_leads_start_cycle(p_company uuid, p_contract uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare b public.social_leads_briefings; who uuid; client text; today date; f uuid; m uuid; begin
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract for update;
 if not found or b.cycle ? 'followup' then return false; end if;
 who := case when exists (select 1 from public.memberships where company_id = p_company and user_id = b.responsible_id and active)
  then b.responsible_id else auth.uid() end;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p_company and k.id = p_contract;
 today := mavi_private.company_today(p_company);
 f := public.create_task(p_company, p_contract, left('Acompanhamento quinzenal · ' || client, 240), who, today + 14,
  null, null, 'Revise os resultados das últimas duas semanas (alcance, seguidores, leads) e alinhe com o cliente o que ajustar.',
  'normal', 30, false, null, null, '{}', 'biweekly');
 m := public.create_task(p_company, p_contract, left('Reunião de resultados e novo plano · ' || client, 240), who, today + 28,
  null, null, 'Apresente os resultados do mês ao cliente e gere o plano do próximo mês em Onboarding › Social Leads.',
  'high', 60, false, null, null, '{}', 'monthly');
 update public.social_leads_briefings set cycle = jsonb_build_object('followup', f, 'meeting', m, 'started_at', now())
 where company_id = p_company and contract_id = p_contract;
 return true;
end $$;
revoke all on function mavi_private.social_leads_start_cycle(uuid, uuid) from public, anon, authenticated;

-- Uma tarefa de arte para cada post aprovado que ainda não tem. Quem
-- recebe vem de p_assign, por post: {"3": {"team": uuid}} (a equipe
-- distribui para quem tem menos tarefas em aberto) ou {"3": {"user": uuid}}
-- (uma pessoa); sem escolha, a equipe de criação (ou o squad). Toda equipe
-- escolhida passa a atender o cliente (é assim que ela vê o post e sobe as
-- artes). Devolve {created, cycle}.
create function public.social_leads_release(p_plan uuid, p_assign jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_leads_settings; fallback uuid; client uuid; name text;
 x public.social_leads_posts; a jsonb; team uuid; who uuid; t uuid; n integer := 0; due date; cyc boolean; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if p_assign is not null and jsonb_typeof(p_assign) <> 'object' then
  raise exception 'Escolha de responsáveis inválida.' using errcode = '22023';
 end if;
 select * into s from public.social_leads_settings where company_id = p.company_id;
 fallback := coalesce(s.design_team_id, s.team_id);
 if not exists (select 1 from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null) then
  raise exception 'Nenhum post aprovado sem tarefa.' using errcode = '22023';
 end if;
 select k.client_id, coalesce(nullif(b.fields->>'clientName', ''), c.name) into client, name
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = p.company_id and k.id = p.contract_id;
 due := mavi_private.company_today(p.company_id) + coalesce(s.art_days, 5);
 for x in select * from public.social_leads_posts where plan_id = p.id and decision = 'approved' and task_id is null
  order by number for update loop
  a := coalesce(p_assign, '{}')->(x.number::text);
  team := null;
  who := null;
  if a is not null and jsonb_typeof(a->'user') = 'string' then
   who := (a->>'user')::uuid;
   if not exists (select 1 from public.memberships where company_id = p.company_id and user_id = who and active) then
    raise exception 'Post %: responsável inválido.', x.number using errcode = '22023';
   end if;
  elsif a is not null and jsonb_typeof(a->'team') = 'string' then
   team := (a->>'team')::uuid;
   if not exists (select 1 from public.teams where company_id = p.company_id and id = team) then
    raise exception 'Post %: equipe não encontrada.', x.number using errcode = '22023';
   end if;
  else
   team := fallback;
   if team is null then
    raise exception 'Post %: escolha uma equipe ou um responsável (ou a equipe de criação em Configurar).', x.number
     using errcode = '22023';
   end if;
  end if;
  if team is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (p.company_id, client, team) on conflict do nothing;
  end if;
  t := public.create_task(p.company_id, p.contract_id,
   left(format('Arte do post %s · %s · %s', x.number, p.label, name), 240), who, due, null, team,
   mavi_private.social_leads_task_text(x, p.label), case when x.is_ad then 'high' else 'normal' end,
   0, false, null, null, '{}', null);
  update public.social_leads_posts set task_id = t where plan_id = p.id and number = x.number;
  n := n + 1;
 end loop;
 cyc := mavi_private.social_leads_start_cycle(p.company_id, p.contract_id);
 return jsonb_build_object('created', n, 'cycle', cyc);
end $$;
revoke all on function public.social_leads_release(uuid, jsonb) from public, anon;
grant execute on function public.social_leads_release(uuid, jsonb) to authenticated;

-- ------------------------------------------------------------ 3. artes
create function public.social_leads_set_arts(p_plan uuid, p_number integer, p_arts jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; x jsonb; list jsonb := '[]'; f public.drive_files; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if jsonb_typeof(p_arts) is distinct from 'array' or jsonb_array_length(p_arts) > 20 then
  raise exception 'Envie até 20 artes por post.' using errcode = '22023';
 end if;
 for x in select value from jsonb_array_elements(p_arts) loop
  if jsonb_typeof(x->'id') is distinct from 'string' or (x->>'id') !~ '^[0-9a-f-]{36}$' then
   raise exception 'Arquivo inválido.' using errcode = '22023';
  end if;
  select * into f from public.drive_files where company_id = p.company_id and id = (x->>'id')::uuid and status = 'ready';
  if not found then raise exception 'Arquivo não encontrado no Drive.' using errcode = 'P0002'; end if;
  if split_part(f.content_type, '/', 1) not in ('image', 'video') and f.content_type <> 'application/pdf' then
   raise exception 'A arte precisa ser imagem, vídeo ou PDF: %', f.name using errcode = '22023';
  end if;
  list := list || jsonb_build_object('id', f.id, 'name', f.name, 'type', f.content_type, 'size', f.size_bytes);
 end loop;
 update public.social_leads_posts set arts = list, updated_at = now() where plan_id = p.id and number = p_number;
 if not found then raise exception 'Post não encontrado.' using errcode = 'P0002'; end if;
 return list;
end $$;
revoke all on function public.social_leads_set_arts(uuid, integer, jsonb) from public, anon;
grant execute on function public.social_leads_set_arts(uuid, integer, jsonb) to authenticated;

-- O arquivo de uma arte, para o link do cliente (o servidor assina o endereço).
create function public.social_leads_public_art(p_token text, p_file uuid)
returns table(path text, name text, content_type text)
language sql stable security definer set search_path = '' as $$
 select f.path, f.name, f.content_type
 from public.social_leads_plans p
 join public.social_leads_posts x on x.plan_id = p.id
 join public.drive_files f on f.company_id = p.company_id and f.id = p_file and f.status = 'ready'
 where p.share_token = p_token and p.share_enabled
  and x.arts @> jsonb_build_array(jsonb_build_object('id', p_file::text))
 limit 1
$$;
revoke all on function public.social_leads_public_art(text, uuid) from public;
grant execute on function public.social_leads_public_art(text, uuid) to anon, authenticated;

-- O link do cliente passa a mostrar as artes (só id, nome e tipo).
create or replace function public.social_leads_shared_plan(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p public.social_leads_plans; b public.social_leads_briefings; cl text; co public.companies; begin
 select * into p from public.social_leads_plans where share_token = p_token and share_enabled;
 if not found then raise exception 'Link inválido ou desativado.' using errcode = 'P0002'; end if;
 select * into b from public.social_leads_briefings where company_id = p.company_id and contract_id = p.contract_id;
 select c.name into cl from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p.company_id and k.id = p.contract_id;
 select * into co from public.companies where id = p.company_id;
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
    'ehAnuncio', x.is_ad, 'decision', x.decision, 'note', x.note, 'decided_at', x.decided_at,
    'decided_via', x.decided_via,
    'arts', coalesce((select jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type'))
      from jsonb_array_elements(x.arts) a), '[]')) order by x.number)
   from public.social_leads_posts x where x.plan_id = p.id), '[]'));
end $$;

-- ------------------------------------------------------------ 4. campanha
-- A campanha do Meta criada a partir do plano (fica inativa: o ciclo, a
-- verba e os vínculos com a conta de anúncio são feitos em Campanhas).
create function public.social_leads_create_campaign(p_plan uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; client text; ad text; notes text; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.contract_read(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if not mavi_private.leader(p.company_id) then
  raise exception 'Somente administradores e gestores criam campanhas.' using errcode = '42501';
 end if;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = p.company_id and k.id = p.contract_id;
 select format('Post %s: %s (%s · %s)', x.number, x.hook, x.format, x.cta) into ad
 from public.social_leads_posts x where x.plan_id = p.id and x.is_ad;
 notes := left(concat_ws(E'\n',
  'Criada a partir do Social Leads · ' || p.label || '.',
  'Objetivo: ' || nullif(p.content->'campanha'->>'objetivo', ''),
  'Região: ' || nullif(p.content->'campanha'->>'regiao', ''),
  'Idade e gênero: ' || nullif(p.content->'campanha'->>'idadeGenero', ''),
  'Segmentação: ' || nullif(p.content->'campanha'->>'segmentacao', ''),
  'Posicionamentos: ' || nullif(p.content->'campanha'->>'posicionamentos', ''),
  'Orçamento: ' || nullif(p.content->'campanha'->>'orcamento', ''),
  'Como o lead chega: ' || nullif(p.content->'campanha'->>'roteamentoLead', ''),
  'Anúncio: ' || ad), 4000);
 return public.create_ad_campaign(p.company_id, p.contract_id, left('Social Leads · ' || client, 160), 'meta', '', '', notes);
end $$;
revoke all on function public.social_leads_create_campaign(uuid) from public, anon;
grant execute on function public.social_leads_create_campaign(uuid) to authenticated;

-- A carteira ganha a produção (artes e tarefas) e a campanha do cliente.
create or replace function public.social_leads_portfolio(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.social_leads_settings; leader boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 select * into s from public.social_leads_settings where company_id = p_company;
 if not found then return jsonb_build_object('configured', false, 'items', '[]'::jsonb); end if;
 leader := mavi_private.leader(p_company);
 return jsonb_build_object('configured', true, 'product_id', s.product_id, 'team_id', s.team_id,
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
     'first_alert', p.content->'alertas'->>0,
     'approved', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and x.decision = 'approved'),
     'rejected', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and x.decision = 'rejected'),
     'last_decision_at', (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id),
     'tasks', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and x.task_id is not null),
     'arts', (select count(*) from public.social_leads_posts x where x.plan_id = p.id and jsonb_array_length(x.arts) > 0))
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

commit;
