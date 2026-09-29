begin;

-- Social Leads, nova leva do Onboarding:
-- 1. Quem pode: qualquer pessoa ativa adiciona clientes à carteira
--    (social_leads_add_client), não só administradores e gestores. A equipe
--    dela passa a atender o cliente, então ela grava o briefing e gera os
--    planos (a regra de quem grava continua a mesma).
-- 2. Plano com 8 a 16 posts (a equipe escolhe ao gerar). O "plano aprovado"
--    passa a ser "todos os posts aprovados", seja qual for a quantidade.
-- 3. Textos exatos de cada post: o que vai na(s) imagem(ns), no vídeo e a
--    legenda (image_text, video_text, caption). A MAVI escreve em texto; a
--    equipe edita no editor de texto (mavi:richtext:v1:). Entram no
--    histórico, no link do cliente e na descrição da tarefa de arte.
-- 4. Alertas lidos: cada alerta (e cada item da checagem de promessas) pode
--    ser marcado como lido; fica guardado quem marcou e quando.
-- 5. Prova social pelo cliente: uma pasta do Drive do produto contratado com
--    link público que aceita envio de arquivos (drive_folders.public_upload),
--    ligada ao briefing (proof_folder). O cliente envia sem entrar no app.

-- ------------------------------------------------------------ 1. quem pode
-- Coloca um cliente na carteira: dá o produto Social Leads a um cliente já
-- cadastrado (p_client) ou cadastra um novo (p_name, com as equipes
-- p_teams). A equipe do squad passa a atender o cliente. Quem não é
-- administrador nem gestor precisa continuar vendo o cliente: o cliente
-- existente tem de ser atendido por uma equipe sua, e o novo tem de ter uma
-- equipe sua entre as escolhidas. Devolve o produto contratado.
create or replace function public.social_leads_add_client(p_company uuid, p_client uuid, p_name text,
 p_teams uuid[] default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare s public.social_leads_settings; pr public.products; cl public.clients; teams uuid[]; lead boolean;
 k uuid; begin
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and active) then
  raise exception 'Sem acesso.' using errcode = '42501';
 end if;
 select * into s from public.social_leads_settings where company_id = p_company;
 if not found then raise exception 'Configure o Social Leads antes.' using errcode = '22023'; end if;
 select * into pr from public.products where company_id = p_company and id = s.product_id;
 lead := mavi_private.leader(p_company);
 if p_client is null then
  if length(trim(coalesce(p_name, ''))) not between 2 and 160 then
   raise exception 'Informe o nome do cliente (2 a 160 caracteres).' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct t.id), '{}') into teams from public.teams t
  where t.company_id = p_company and t.id = any(coalesce(p_teams, '{}'::uuid[]) || s.team_id);
  if not lead and not exists (select 1 from public.team_members tm where tm.company_id = p_company
   and tm.user_id = auth.uid() and tm.team_id = any(teams)) then
   raise exception 'Escolha uma equipe da qual você faz parte, para continuar vendo o cliente.' using errcode = '22023';
  end if;
  insert into public.clients(company_id, name, email) values (p_company, trim(p_name), '') returning * into cl;
  perform mavi_private.set_client_teams(p_company, cl.id, teams);
 else
  select * into cl from public.clients where company_id = p_company and id = p_client and not archived;
  if not found then raise exception 'Cliente não encontrado.' using errcode = 'P0002'; end if;
  if not lead and not exists (select 1 from public.client_teams ct
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where ct.company_id = p_company and ct.client_id = cl.id and tm.user_id = auth.uid()) then
   raise exception 'Você só adiciona clientes atendidos por uma equipe sua.' using errcode = '42501';
  end if;
  if exists (select 1 from public.contracts where company_id = p_company and client_id = cl.id
   and product_id = s.product_id and not archived) then
   raise exception 'Este cliente já está no Social Leads.' using errcode = '23505';
  end if;
  if s.team_id is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (p_company, cl.id, s.team_id)
   on conflict do nothing;
  end if;
 end if;
 insert into public.contracts(company_id, client_id, product_id, name)
 values (p_company, cl.id, s.product_id, left(coalesce(pr.name, 'Social Leads') || ' · ' || cl.name, 160))
 returning id into k;
 return k;
end $$;
revoke all on function public.social_leads_add_client(uuid, uuid, text, uuid[]) from public, anon;
grant execute on function public.social_leads_add_client(uuid, uuid, text, uuid[]) to authenticated;

-- ------------------------------------------------------------ 2 e 3. posts
alter table public.social_leads_posts drop constraint if exists social_leads_posts_number_check;
alter table public.social_leads_posts add constraint social_leads_posts_number_check check (number between 1 and 16);
alter table public.social_leads_post_events drop constraint if exists social_leads_post_events_number_check;
alter table public.social_leads_post_events add constraint social_leads_post_events_number_check
 check (number between 1 and 16);
alter table public.social_leads_posts
 add column if not exists image_text text not null default '' check (length(image_text) <= 40000),
 add column if not exists video_text text not null default '' check (length(video_text) <= 40000),
 add column if not exists caption text not null default '' check (length(caption) <= 40000);

-- O plano conferido: 4 pilares, de 8 a 16 posts numerados de 1 a N, um só
-- anúncio. Os textos exatos são opcionais (planos antigos não têm).
create or replace function mavi_private.social_leads_normalize(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
 d jsonb; s jsonb; c jsonb; x jsonb; posts jsonb := '[]'; pilares jsonb := '[]'; alertas jsonb := '[]';
 perguntas jsonb := '[]'; n integer; seen integer[] := '{}'; ads integer := 0; badge text; total integer;
begin
 if p is null or jsonb_typeof(p) <> 'object' then raise exception 'Plano inválido.' using errcode = '22023'; end if;
 d := p->'diagnostico'; s := p->'swot'; c := p->'campanha';
 if jsonb_typeof(d) is distinct from 'object' then raise exception 'Diagnóstico ausente.' using errcode = '22023'; end if;
 if jsonb_typeof(s) is distinct from 'object' then raise exception 'SWOT ausente.' using errcode = '22023'; end if;
 if jsonb_typeof(c) is distinct from 'object' then raise exception 'Campanha ausente.' using errcode = '22023'; end if;
 if jsonb_typeof(p->'pilares') is distinct from 'array' or jsonb_array_length(p->'pilares') <> 4 then
  raise exception 'O plano precisa de exatamente 4 pilares.' using errcode = '22023';
 end if;
 for x in select value from jsonb_array_elements(p->'pilares') loop
  pilares := pilares || jsonb_build_object('titulo', mavi_private.sl_text(x, 'titulo', 'Título do pilar', 200),
   'descricao', mavi_private.sl_text(x, 'descricao', 'Descrição do pilar', 1000));
 end loop;
 if p->'alertas' is not null and jsonb_typeof(p->'alertas') <> 'null' then
  if jsonb_typeof(p->'alertas') <> 'array' or jsonb_array_length(p->'alertas') > 30 then
   raise exception 'Alertas inválidos.' using errcode = '22023';
  end if;
  for x in select value from jsonb_array_elements(p->'alertas') loop
   if jsonb_typeof(x) <> 'string' or length(trim(x #>> '{}')) = 0 then raise exception 'Alerta vazio.' using errcode = '22023'; end if;
   alertas := alertas || to_jsonb(left(trim(x #>> '{}'), 1000));
  end loop;
 end if;
 if c->'perguntasFormulario' is not null and jsonb_typeof(c->'perguntasFormulario') <> 'null' then
  if jsonb_typeof(c->'perguntasFormulario') <> 'array' or jsonb_array_length(c->'perguntasFormulario') > 15 then
   raise exception 'Perguntas do formulário inválidas.' using errcode = '22023';
  end if;
  for x in select value from jsonb_array_elements(c->'perguntasFormulario') loop
   if jsonb_typeof(x) = 'string' and length(trim(x #>> '{}')) > 0 then perguntas := perguntas || to_jsonb(left(trim(x #>> '{}'), 300)); end if;
  end loop;
 end if;
 if jsonb_typeof(p->'posts') is distinct from 'array' then
  raise exception 'O plano precisa de 8 a 16 posts.' using errcode = '22023';
 end if;
 total := jsonb_array_length(p->'posts');
 if total not between 8 and 16 then
  raise exception 'O plano precisa de 8 a 16 posts (tem %).', total using errcode = '22023';
 end if;
 for x in select value from jsonb_array_elements(p->'posts') loop
  if jsonb_typeof(x) <> 'object' or jsonb_typeof(x->'numero') <> 'number' then
   raise exception 'Post sem número.' using errcode = '22023';
  end if;
  n := (x->>'numero')::numeric::integer;
  if n not between 1 and total or (x->>'numero')::numeric <> n then
   raise exception 'Número de post fora de 1 a %: %.', total, x->>'numero' using errcode = '22023';
  end if;
  if n = any(seen) then raise exception 'Post % repetido.', n using errcode = '22023'; end if;
  seen := seen || n;
  badge := x->>'badge';
  if badge is null or badge not in ('posicionar', 'autoridade', 'oferta') then
   raise exception 'Pilar do post % inválido: use posicionar, autoridade ou oferta.', n using errcode = '22023';
  end if;
  if coalesce(x->>'ehAnuncio', 'false') = 'true' then ads := ads + 1; end if;
  posts := posts || jsonb_build_object(
   'numero', n, 'badge', badge,
   'gancho', mavi_private.sl_text(x, 'gancho', format('Gancho do post %s', n), 500),
   'direcaoCopy', mavi_private.sl_text(x, 'direcaoCopy', format('Direção de copy do post %s', n)),
   'direcaoVisual', mavi_private.sl_text(x, 'direcaoVisual', format('Direção visual do post %s', n)),
   'formato', mavi_private.sl_text(x, 'formato', format('Formato do post %s', n), 200),
   'cta', mavi_private.sl_text(x, 'cta', format('CTA do post %s', n), 300),
   'textoImagem', mavi_private.sl_opt(x, 'textoImagem', 40000),
   'textoVideo', mavi_private.sl_opt(x, 'textoVideo', 40000),
   'legenda', mavi_private.sl_opt(x, 'legenda', 40000),
   'ehAnuncio', coalesce(x->>'ehAnuncio', 'false') = 'true',
   'status', case x->>'status' when 'aprovado' then 'aprovado' when 'reprovado' then 'reprovado' else 'pendente' end,
   'observacao', mavi_private.sl_opt(x, 'observacao', 2000));
 end loop;
 if ads <> 1 then raise exception 'O plano precisa de exatamente um post que vira anúncio (tem %).', ads using errcode = '22023'; end if;
 select jsonb_agg(v order by (v->>'numero')::integer) into posts from jsonb_array_elements(posts) v;
 return jsonb_build_object(
  'content', jsonb_build_object(
   'diagnostico', jsonb_build_object(
    'negocio', mavi_private.sl_text(d, 'negocio', 'Diagnóstico do negócio'),
    'comoQuerSerVista', mavi_private.sl_text(d, 'comoQuerSerVista', 'Como a marca quer ser vista')),
   'swot', jsonb_build_object(
    'forcas', mavi_private.sl_opt(s, 'forcas'), 'fraquezas', mavi_private.sl_opt(s, 'fraquezas'),
    'oportunidades', mavi_private.sl_opt(s, 'oportunidades'), 'ameacas', mavi_private.sl_opt(s, 'ameacas')),
   'pilares', pilares,
   'publico', mavi_private.sl_text(p, 'publico', 'Público'),
   'campanha', jsonb_build_object(
    'objetivo', mavi_private.sl_opt(c, 'objetivo', 1000), 'regiao', mavi_private.sl_opt(c, 'regiao', 1000),
    'idadeGenero', mavi_private.sl_opt(c, 'idadeGenero', 1000), 'segmentacao', mavi_private.sl_opt(c, 'segmentacao', 2000),
    'posicionamentos', mavi_private.sl_opt(c, 'posicionamentos', 1000), 'orcamento', mavi_private.sl_opt(c, 'orcamento', 1000),
    'perguntasFormulario', perguntas, 'roteamentoLead', mavi_private.sl_opt(c, 'roteamentoLead', 1000)),
   'alertas', alertas),
  'posts', posts);
end $$;

create or replace function mavi_private.social_leads_full(p_plan uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select p.content || jsonb_build_object('label', p.label, 'createdAt', p.created_at, 'posts', coalesce((
  select jsonb_agg(jsonb_build_object('numero', x.number, 'badge', x.pillar, 'gancho', x.hook,
   'direcaoCopy', x.copy_direction, 'direcaoVisual', x.visual_direction, 'formato', x.format, 'cta', x.cta,
   'textoImagem', x.image_text, 'textoVideo', x.video_text, 'legenda', x.caption,
   'ehAnuncio', x.is_ad,
   'status', case x.decision when 'approved' then 'aprovado' when 'rejected' then 'reprovado' else 'pendente' end,
   'observacao', x.note) order by x.number)
  from public.social_leads_posts x where x.plan_id = p.id), '[]'))
 from public.social_leads_plans p where p.id = p_plan
$$;

-- Grava os posts (os modos de antes). Posts que não vêm mais (um plano
-- regenerado com menos posts) saem; o histórico deles fica.
create or replace function mavi_private.social_leads_put_posts(p_plan uuid, p_posts jsonb, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; x jsonb; o public.social_leads_posts; dec text; same boolean; begin
 select * into p from public.social_leads_plans where id = p_plan;
 delete from public.social_leads_posts where plan_id = p.id
  and not number in (select (v->>'numero')::integer from jsonb_array_elements(p_posts) v);
 -- Tira o anúncio de todos antes, para o índice de um anúncio por plano.
 update public.social_leads_posts set is_ad = false where plan_id = p.id and is_ad;
 for x in select value from jsonb_array_elements(p_posts) loop
  select * into o from public.social_leads_posts where plan_id = p.id and number = (x->>'numero')::integer;
  same := found and o.pillar = x->>'badge' and o.hook = x->>'gancho' and o.copy_direction = x->>'direcaoCopy'
   and o.visual_direction = x->>'direcaoVisual' and o.format = x->>'formato' and o.cta = x->>'cta'
   and o.image_text = coalesce(x->>'textoImagem', '') and o.video_text = coalesce(x->>'textoVideo', '')
   and o.caption = coalesce(x->>'legenda', '')
   and o.is_ad is not distinct from ((x->>'ehAnuncio')::boolean);
  dec := case
   when p_mode = 'keep' then case x->>'status' when 'aprovado' then 'approved' when 'reprovado' then 'rejected' else 'pending' end
   when p_mode = 'changed' and same then o.decision
   else 'pending' end;
  insert into public.social_leads_posts as t(company_id, contract_id, plan_id, number, pillar, hook, copy_direction,
   visual_direction, format, cta, image_text, video_text, caption, is_ad, decision, note, decided_via, decided_by,
   decided_at, updated_at)
  values (p.company_id, p.contract_id, p.id, (x->>'numero')::integer, x->>'badge', x->>'gancho', x->>'direcaoCopy',
   x->>'direcaoVisual', x->>'formato', x->>'cta', coalesce(x->>'textoImagem', ''), coalesce(x->>'textoVideo', ''),
   coalesce(x->>'legenda', ''), (x->>'ehAnuncio')::boolean, dec,
   case when p_mode = 'keep' then coalesce(x->>'observacao', '') when p_mode = 'changed' and same then o.note else '' end,
   case when dec = 'pending' then null when p_mode = 'changed' and same then o.decided_via else 'team' end,
   case when dec = 'pending' then null when p_mode = 'changed' and same then o.decided_by else auth.uid() end,
   case when dec = 'pending' then null when p_mode = 'changed' and same then o.decided_at else now() end,
   now())
  on conflict (plan_id, number) do update set pillar = excluded.pillar, hook = excluded.hook,
   copy_direction = excluded.copy_direction, visual_direction = excluded.visual_direction, format = excluded.format,
   cta = excluded.cta, image_text = excluded.image_text, video_text = excluded.video_text, caption = excluded.caption,
   is_ad = excluded.is_ad, decision = excluded.decision, note = excluded.note,
   decided_via = excluded.decided_via, decided_by = excluded.decided_by, decided_at = excluded.decided_at,
   updated_at = case when t.decision is distinct from excluded.decision or not same then now() else t.updated_at end;
 end loop;
end $$;

-- Todos os posts do plano aprovados (8 ou quantos o plano tiver).
create or replace function mavi_private.social_leads_all_approved(p_plan uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select count(*) > 0 and count(*) = count(*) filter (where decision = 'approved')
 from public.social_leads_posts where plan_id = p_plan
$$;
revoke all on function mavi_private.social_leads_all_approved(uuid) from public, anon, authenticated;

create or replace function public.social_leads_write_plan(p_company uuid, p_contract uuid, p_plan uuid, p_content jsonb,
 p_reason text, p_version integer, p_source text default 'ai', p_summary text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare norm jsonb; p public.social_leads_plans; n integer; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para editar o plano deste cliente.' using errcode = '42501';
 end if;
 if p_source not in ('ai', 'import', 'manual') then raise exception 'Origem inválida.' using errcode = '22023'; end if;
 norm := mavi_private.social_leads_normalize(p_content);
 if p_plan is null then
  if not exists (select 1 from public.contracts where company_id = p_company and id = p_contract and not archived) then
   raise exception 'Produto contratado não encontrado.' using errcode = 'P0002';
  end if;
  -- Um mês por vez, mesmo com duas gerações ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtextextended('social_leads:' || p_contract::text, 0));
  n := coalesce((select max(month_number) from public.social_leads_plans where contract_id = p_contract), 0) + 1;
  insert into public.social_leads_plans(company_id, contract_id, month_number, label, content, summary, source,
   created_by, updated_by)
  values (p_company, p_contract, n, 'Mês ' || n, norm->'content', coalesce(p_summary, ''), p_source, auth.uid(), auth.uid())
  returning * into p;
  perform mavi_private.social_leads_put_posts(p.id, norm->'posts', 'reset');
  return jsonb_build_object('id', p.id, 'version', p.version);
 end if;
 select * into p from public.social_leads_plans where id = p_plan and company_id = p_company and contract_id = p_contract for update;
 if not found then raise exception 'Plano não encontrado.' using errcode = 'P0002'; end if;
 if p_version is not null and p_version <> p.version then
  raise exception 'O plano mudou desde que você o abriu. Recarregue para ver a versão atual.' using errcode = '40001';
 end if;
 if p_reason = 'regeneração do mês' and mavi_private.social_leads_all_approved(p.id) then
  raise exception 'Plano aprovado: todos os posts foram aprovados. Para mudar um post, use "alterar" nele ou a atualização pelo chat.'
   using errcode = '55000';
 end if;
 -- Fora da regeneração, a quantidade de posts não muda.
 if p_reason <> 'regeneração do mês' and jsonb_array_length(norm->'posts')
  <> (select count(*) from public.social_leads_posts where plan_id = p.id) then
  raise exception 'A quantidade de posts só muda ao regenerar o mês.' using errcode = '22023';
 end if;
 perform mavi_private.social_leads_snapshot(p.id, coalesce(nullif(trim(p_reason), ''), 'edição'));
 update public.social_leads_plans set content = norm->'content', source = p_source,
  summary = coalesce(p_summary, summary), version = version + 1, updated_by = auth.uid(), updated_at = now()
 where id = p.id returning * into p;
 perform mavi_private.social_leads_put_posts(p.id, norm->'posts',
  case when p_reason = 'regeneração do mês' then 'reset' else 'changed' end);
 return jsonb_build_object('id', p.id, 'version', p.version);
end $$;

-- A geração recebe a quantidade de posts (p_posts, de 8 a 16; sem ela, a do
-- plano atual ou do anterior, ou 8) e os arquivos da pasta da prova social.
drop function if exists public.social_leads_start_job(uuid, uuid, uuid, text);
create or replace function public.social_leads_start_job(p_company uuid, p_contract uuid, p_plan uuid, p_kind text,
 p_posts integer default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.social_leads_jobs; b public.social_leads_briefings; cl public.clients; prev uuid; total integer;
 folder jsonb; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para gerar o plano deste cliente.' using errcode = '42501';
 end if;
 if p_kind not in ('new', 'current') then raise exception 'Tipo de geração inválido.' using errcode = '22023'; end if;
 if p_posts is not null and p_posts not between 8 and 16 then
  raise exception 'Escolha de 8 a 16 posts.' using errcode = '22023';
 end if;
 if p_kind = 'current' and not exists (select 1 from public.social_leads_plans
  where id = p_plan and company_id = p_company and contract_id = p_contract) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract;
 if not found then raise exception 'Preencha o briefing antes de gerar o plano.' using errcode = '22023'; end if;
 if p_kind = 'current' and mavi_private.social_leads_all_approved(p_plan) then
  raise exception 'Plano aprovado: todos os posts foram aprovados.' using errcode = '55000';
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
 total := coalesce(p_posts, nullif((select count(*) from public.social_leads_posts where plan_id = prev), 0)::integer, 8);
 total := least(greatest(total, 8), 16);
 if b.proof_folder is not null then
  select jsonb_agg(jsonb_build_object('name', f.name, 'type', f.content_type)) into folder
  from (select name, content_type from public.drive_files where company_id = p_company and folder_id = b.proof_folder
   and status = 'ready' order by created_at desc limit 60) f;
 end if;
 return jsonb_build_object('job', j.id, 'client_name', cl.name, 'briefing', b.fields,
  'media', b.media || case when folder is null then '{}'::jsonb else jsonb_build_object('socialProofFolder', folder) end,
  'campaign_objective', b.campaign_objective,
  'responsible', (select name from public.memberships where company_id = p_company and user_id = b.responsible_id),
  'next_month', coalesce((select max(month_number) from public.social_leads_plans where contract_id = p_contract), 0) + 1,
  'post_count', total,
  'previous', case when prev is null then null else mavi_private.social_leads_full(prev) end);
end $$;
revoke all on function public.social_leads_start_job(uuid, uuid, uuid, text, integer) from public, anon;
grant execute on function public.social_leads_start_job(uuid, uuid, uuid, text, integer) to authenticated;

-- A etapa do cliente (dashboards), com "todos aprovados" no lugar de 8.
create or replace function mavi_private.social_leads_stage(c uuid, k uuid) returns text
language sql stable security definer set search_path = '' as $$
 select case
  when p.id is null then 'briefing'
  when p.total > 0 and p.approved = p.total then case when exists (
    select 1 from public.ad_campaigns ac join public.contracts ck on ck.company_id = ac.company_id and ck.id = ac.contract_id
    where ac.company_id = c and ck.client_id = (select kk.client_id from public.contracts kk where kk.company_id = c and kk.id = k)
     and ac.platform = 'meta' and not ac.archived and ac.status = 'active') then 'campaign' else 'production' end
  when not p.share_enabled and p.decided = 0 then 'plan'
  else 'approval' end
 from (select 1) one
 left join lateral (
  select pl.id, pl.share_enabled,
   count(x.number) as total,
   count(x.number) filter (where x.decision = 'approved') as approved,
   count(x.number) filter (where x.decision <> 'pending') as decided
  from public.social_leads_plans pl left join public.social_leads_posts x on x.plan_id = pl.id
  where pl.company_id = c and pl.contract_id = k
  group by pl.id order by max(pl.month_number) desc limit 1) p on true
$$;

-- O link do cliente mostra também os textos exatos de cada post.
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
    'textoImagem', x.image_text, 'textoVideo', x.video_text, 'legenda', x.caption,
    'ehAnuncio', x.is_ad, 'decision', x.decision, 'note', x.note, 'decided_at', x.decided_at,
    'decided_via', x.decided_via,
    'arts', coalesce((select jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type'))
      from jsonb_array_elements(x.arts) a), '[]')) order by x.number)
   from public.social_leads_posts x where x.plan_id = p.id), '[]'));
end $$;

-- O histórico compara também os textos exatos.
create or replace function mavi_private.social_leads_log_post() returns trigger
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; me uuid := auth.uid(); me_name text; reason text; before jsonb := '{}';
 after jsonb := '{}'; col text; via text; t public.tasks; added jsonb; removed jsonb; was_ad boolean; prev jsonb; begin
 -- A gravação dos posts tira o anúncio de todos antes e põe de volta: essa
 -- primeira troca não conta; o post lembra que era o anúncio (nesta transação).
 if tg_op = 'UPDATE' and old.is_ad and not new.is_ad
  and to_jsonb(old) - 'is_ad' - 'updated_at' = to_jsonb(new) - 'is_ad' - 'updated_at' then
  perform set_config('mavi.sl_ad', new.plan_id::text || ':' || new.number, true);
  return null;
 end if;
 select * into p from public.social_leads_plans where id = new.plan_id;
 me_name := mavi_private.social_leads_person(new.company_id, me);
 -- O motivo da gravação do plano nesta mesma transação (a versão guardada antes).
 select r.reason into reason from public.social_leads_revisions r
 where r.plan_id = new.plan_id and r.created_at = now() order by r.number desc limit 1;
 via := case when p.source = 'ai' then 'ai' else 'team' end;

 if tg_op = 'INSERT' then
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
  values (new.company_id, new.contract_id, new.plan_id, new.number, 'created', via, me, me_name,
   jsonb_build_object('source', p.source));
  if new.decision <> 'pending' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, note)
   values (new.company_id, new.contract_id, new.plan_id, new.number, new.decision, 'team', new.decided_by,
    mavi_private.social_leads_person(new.company_id, new.decided_by), new.note);
  end if;
  return null;
 end if;

 -- Conteúdo: o que era e o que ficou, só dos campos que mudaram.
 was_ad := current_setting('mavi.sl_ad', true) = new.plan_id::text || ':' || new.number;
 prev := to_jsonb(old) || case when was_ad then '{"is_ad": true}'::jsonb else '{}'::jsonb end;
 if was_ad then perform set_config('mavi.sl_ad', '', true); end if;
 foreach col in array array['pillar', 'hook', 'copy_direction', 'visual_direction', 'format', 'cta',
  'image_text', 'video_text', 'caption', 'is_ad'] loop
  if prev->col is distinct from to_jsonb(new)->col then
   before := before || jsonb_build_object(col, prev->col);
   after := after || jsonb_build_object(col, to_jsonb(new)->col);
  end if;
 end loop;
 if before <> '{}' then
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
  values (new.company_id, new.contract_id, new.plan_id, new.number, 'edited',
   case when reason = 'ajuste pedido à IA' or reason = 'regeneração do mês' then 'ai' else 'team' end, me, me_name,
   jsonb_strip_nulls(jsonb_build_object('before', before, 'after', after, 'reason', reason,
    'summary', case when reason = 'ajuste pedido à IA' then nullif(p.summary, '') end,
    -- A aprovação valia para o texto anterior: o post voltou a pendente.
    'reset', case when old.decision <> 'pending' and new.decision = 'pending' then true end)));
 end if;

 -- Decisão (uma nova, ou a mesma de novo com outra observação).
 if (new.decision is distinct from old.decision or new.decided_at is distinct from old.decided_at)
  and not (before <> '{}' and new.decision = 'pending') then
  if new.decision = 'pending' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
   values (new.company_id, new.contract_id, new.plan_id, new.number, 'reopened', 'team', me, me_name,
    jsonb_strip_nulls(jsonb_build_object('reason', reason)));
  elsif new.decided_via = 'link' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_name, note)
   values (new.company_id, new.contract_id, new.plan_id, new.number, new.decision, 'link',
    mavi_private.social_leads_client_name(new.company_id, new.contract_id), new.note);
  else
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, note, detail)
   values (new.company_id, new.contract_id, new.plan_id, new.number, new.decision, 'team', coalesce(new.decided_by, me),
    mavi_private.social_leads_person(new.company_id, coalesce(new.decided_by, me)), new.note,
    jsonb_strip_nulls(jsonb_build_object('reason', reason)));
  end if;
 end if;

 -- Artes: as que entraram e as que saíram.
 if new.arts is distinct from old.arts then
  select coalesce(jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type')), '[]') into added
  from jsonb_array_elements(coalesce(new.arts, '[]')) a
  where not exists (select 1 from jsonb_array_elements(coalesce(old.arts, '[]')) o where o->>'id' = a->>'id');
  select coalesce(jsonb_agg(a->>'name'), '[]') into removed
  from jsonb_array_elements(coalesce(old.arts, '[]')) a
  where not exists (select 1 from jsonb_array_elements(coalesce(new.arts, '[]')) o where o->>'id' = a->>'id');
  if added <> '[]' or removed <> '[]' then
   insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
   values (new.company_id, new.contract_id, new.plan_id, new.number, 'arts', 'team', me, me_name,
    jsonb_build_object('added', added, 'removed', removed));
  end if;
 end if;

 -- Tarefa de arte criada ("Liberar produção").
 if new.task_id is not null and old.task_id is distinct from new.task_id then
  select * into t from public.tasks where id = new.task_id;
  insert into public.social_leads_post_events(company_id, contract_id, plan_id, number, kind, via, actor_id, actor_name, detail)
  values (new.company_id, new.contract_id, new.plan_id, new.number, 'task', 'team', me, me_name,
   jsonb_strip_nulls(jsonb_build_object('task', new.task_id,
    'assignee', nullif(mavi_private.social_leads_person(new.company_id, t.assignee_id), ''),
    'team', (select name from public.teams where company_id = new.company_id and id = t.team_id),
    'due', t.due_date)));
 end if;
 return null;
end $$;

-- Um texto do post na descrição da tarefa: o rótulo em negrito e, embaixo,
-- o texto (o formatado entra como está; o simples, com as quebras de linha).
create or replace function mavi_private.social_leads_rich_section(p_label text, p_value text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare doc jsonb; begin
 if nullif(trim(coalesce(p_value, '')), '') is null then return '[]'; end if;
 if p_value like 'mavi:richtext:v1:%' then
  begin
   doc := substr(p_value, 18)::jsonb;
  exception when others then doc := null;
  end;
  if jsonb_typeof(doc->'content') = 'array' then
   return jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
    jsonb_build_object('type', 'text', 'text', p_label, 'marks', '[{"type":"bold"}]'::jsonb)))) || (doc->'content');
  end if;
 end if;
 return jsonb_build_array(mavi_private.social_leads_rich_topic(p_label, p_value));
end $$;
revoke all on function mavi_private.social_leads_rich_section(text, text) from public, anon, authenticated;

-- A descrição de antes (para trocar a das tarefas que ninguém editou).
create or replace function mavi_private.social_leads_task_text_v2(x public.social_leads_posts, p_label text) returns text
language sql immutable set search_path = '' as $$
 select 'mavi:richtext:v1:' || jsonb_build_object('type', 'doc', 'content', (
  select jsonb_agg(b order by n) from unnest(array[
   case when x.is_ad then mavi_private.social_leads_rich_paragraph(
    'Este post também vira o anúncio do mês.', '[{"type":"bold"},{"type":"highlight"}]') end,
   mavi_private.social_leads_rich_topic('Gancho', x.hook),
   mavi_private.social_leads_rich_topic('Direção de copy', x.copy_direction),
   mavi_private.social_leads_rich_topic('Direção visual', x.visual_direction),
   mavi_private.social_leads_rich_list('bulletList', array[
    mavi_private.social_leads_rich_item('Formato', x.format),
    mavi_private.social_leads_rich_item('Chamada (CTA)', x.cta)]),
   mavi_private.social_leads_rich_topic('Observação do cliente', x.note),
   mavi_private.social_leads_rich_paragraph('Como entregar', '[{"type":"bold"}]'),
   mavi_private.social_leads_rich_list('orderedList', array[
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'Clique em “Abrir o post no plano”, logo abaixo desta descrição.'))),
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'No post, use “Enviar as artes” (imagem, vídeo ou PDF). Elas vão para o Drive do cliente e aparecem no link de aprovação.'))),
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'Só conclua esta tarefa depois que as artes estiverem no post.')))]),
   mavi_private.social_leads_rich_paragraph(
    'Onde fica: Onboarding › Social Leads › ' || p_label || ' › Post ' || x.number, '[{"type":"italic"}]')
  ]) with ordinality as u(b, n) where b is not null))::text
$$;

create or replace function mavi_private.social_leads_task_text(x public.social_leads_posts, p_label text) returns text
language sql immutable set search_path = '' as $$
 select 'mavi:richtext:v1:' || jsonb_build_object('type', 'doc', 'content',
  coalesce((select jsonb_agg(b order by n) from unnest(array[
   case when x.is_ad then mavi_private.social_leads_rich_paragraph(
    'Este post também vira o anúncio do mês.', '[{"type":"bold"},{"type":"highlight"}]') end,
   mavi_private.social_leads_rich_topic('Gancho', x.hook),
   mavi_private.social_leads_rich_topic('Direção de copy', x.copy_direction),
   mavi_private.social_leads_rich_topic('Direção visual', x.visual_direction),
   mavi_private.social_leads_rich_list('bulletList', array[
    mavi_private.social_leads_rich_item('Formato', x.format),
    mavi_private.social_leads_rich_item('Chamada (CTA)', x.cta)])
  ]) with ordinality as u(b, n) where b is not null), '[]'::jsonb)
  || mavi_private.social_leads_rich_section('Texto exato da(s) imagem(ns)', x.image_text)
  || mavi_private.social_leads_rich_section('Texto exato do vídeo', x.video_text)
  || mavi_private.social_leads_rich_section('Legenda (copy)', x.caption)
  || coalesce((select jsonb_agg(b order by n) from unnest(array[
   mavi_private.social_leads_rich_topic('Observação do cliente', x.note),
   mavi_private.social_leads_rich_paragraph('Como entregar', '[{"type":"bold"}]'),
   mavi_private.social_leads_rich_list('orderedList', array[
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'Clique em “Abrir o post no plano”, logo abaixo desta descrição.'))),
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'No post, use “Enviar as artes” (imagem, vídeo ou PDF). Elas vão para o Drive do cliente e aparecem no link de aprovação.'))),
    jsonb_build_object('type', 'listItem', 'content', jsonb_build_array(mavi_private.social_leads_rich_paragraph(
     'Só conclua esta tarefa depois que as artes estiverem no post.')))]),
   mavi_private.social_leads_rich_paragraph(
    'Onde fica: Onboarding › Social Leads › ' || p_label || ' › Post ' || x.number, '[{"type":"italic"}]')
  ]) with ordinality as u(b, n) where b is not null), '[]'::jsonb))::text
$$;
revoke all on function mavi_private.social_leads_task_text(public.social_leads_posts, text) from public, anon, authenticated;

-- Texto de post editado depois da liberação: a tarefa que ninguém mexeu
-- acompanha (o designer lê a descrição atual).
create or replace function mavi_private.social_leads_sync_task() returns trigger
language plpgsql security definer set search_path = '' as $$
declare label text; begin
 if new.task_id is null then return null; end if;
 select p.label into label from public.social_leads_plans p where p.id = new.plan_id;
 update public.tasks t set description = mavi_private.social_leads_task_text(new, label)
 where t.id = new.task_id and t.description = mavi_private.social_leads_task_text(old, label)
  and t.description is distinct from mavi_private.social_leads_task_text(new, label);
 return null;
end $$;
revoke all on function mavi_private.social_leads_sync_task() from public, anon, authenticated;
drop trigger if exists social_leads_sync_task on public.social_leads_posts;
create trigger social_leads_sync_task after update of hook, copy_direction, visual_direction, format, cta,
 image_text, video_text, caption, is_ad, note on public.social_leads_posts
 for each row when (old.task_id is not distinct from new.task_id)
 execute function mavi_private.social_leads_sync_task();

-- ------------------------------------------------------------ 4. alertas lidos
create table if not exists public.social_leads_alert_reads (
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid not null,
 -- O texto do alerta (ou do item da checagem) como estava: se a MAVI ou uma
 -- importação trocar o texto, ele volta a aparecer como não lido.
 alert_text text not null check (length(trim(alert_text)) between 1 and 2000),
 alert_hash text generated always as (md5(alert_text)) stored,
 kind text not null default 'alerta' check (kind in ('alerta', 'checagem')),
 read_by uuid not null default auth.uid(),
 read_at timestamptz not null default now(),
 primary key (plan_id, alert_hash),
 foreign key (company_id, plan_id) references public.social_leads_plans(company_id, id) on delete cascade
);
alter table public.social_leads_alert_reads enable row level security;
revoke all on public.social_leads_alert_reads from public, anon, authenticated;
grant select on public.social_leads_alert_reads to authenticated;
drop policy if exists social_leads_alert_reads_read on public.social_leads_alert_reads;
create policy social_leads_alert_reads_read on public.social_leads_alert_reads for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));

-- Marca (ou desmarca) um alerta como lido. Quem vê o cliente pode marcar.
create or replace function public.social_leads_mark_alert(p_plan uuid, p_text text, p_kind text, p_read boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.member(p.company_id) or not mavi_private.contract_read(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if length(trim(coalesce(p_text, ''))) not between 1 and 2000 then
  raise exception 'Alerta inválido.' using errcode = '22023';
 end if;
 if coalesce(p_kind, 'alerta') not in ('alerta', 'checagem') then
  raise exception 'Tipo de alerta inválido.' using errcode = '22023';
 end if;
 if p_read then
  insert into public.social_leads_alert_reads(company_id, contract_id, plan_id, alert_text, kind)
  values (p.company_id, p.contract_id, p.id, p_text, coalesce(p_kind, 'alerta'))
  on conflict (plan_id, alert_hash) do nothing;
 else
  delete from public.social_leads_alert_reads where plan_id = p.id and alert_hash = md5(p_text);
 end if;
 perform mavi_private.broadcast(p.company_id, jsonb_build_object(
  'kind', 'social_leads', 'contract', p.contract_id, 'table', 'social_leads_alert_reads'));
end $$;
revoke all on function public.social_leads_mark_alert(uuid, text, text, boolean) from public, anon;
grant execute on function public.social_leads_mark_alert(uuid, text, text, boolean) to authenticated;

-- A carteira: quantos posts o plano tem e quantos alertas ninguém leu.
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
     'alerts_unread', (select count(*) from jsonb_array_elements_text(coalesce(p.content->'alertas', '[]')) a
      where not exists (select 1 from public.social_leads_alert_reads r where r.plan_id = p.id and r.alert_hash = md5(a))),
     'first_alert', p.content->'alertas'->>0,
     'posts', (select count(*) from public.social_leads_posts x where x.plan_id = p.id),
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

-- ------------------------------------------------------------ 5. prova social pelo cliente
alter table public.drive_folders add column if not exists public_upload boolean not null default false;
alter table public.social_leads_briefings add column if not exists proof_folder uuid
 references public.drive_folders(id) on delete set null;

-- Desligar o link público desliga também o envio por ele.
create or replace function public.set_drive_folder_sharing(p_folder uuid, p_public boolean, p_members uuid[])
 returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.drive_folders; wanted uuid[]; before uuid[]; next_visibility text; begin
  select * into f from public.drive_folders where id = p_folder for update;
  if not found or not mavi_private.drive_folder_manager(f) then
    raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
  end if;
  if f.contract_id is null then
    raise exception 'Só pastas dentro de um produto podem ser compartilhadas.';
  end if;
  select coalesce(array_agg(distinct u), '{}') into wanted from unnest(coalesce(p_members, '{}')) u;
  if exists (select 1 from unnest(wanted) u where not exists (select 1 from public.memberships m
   where m.company_id = f.company_id and m.user_id = u and m.active)) then
    raise exception 'Escolha pessoas ativas do espaço.';
  end if;
  select coalesce(array_agg(user_id), '{}') into before from public.drive_folder_members where folder_id = f.id;
  delete from public.drive_folder_members where folder_id = f.id and not user_id = any(wanted);
  insert into public.drive_folder_members(company_id, folder_id, user_id)
   select f.company_id, f.id, u from unnest(wanted) u on conflict do nothing;
  next_visibility := case when p_public then 'public' else 'private' end;
  update public.drive_folders set visibility = next_visibility,
   public_upload = case when p_public then public_upload else false end,
   -- A link turned off is gone for good: a new one is issued next time.
   share_token = case when f.visibility = 'public' and next_visibility = 'private'
    then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
    else share_token end
  where id = f.id returning * into f;
  perform mavi_private.drive_log(f.company_id, 'folder_shared', null, f.id, f.name, f.client_id, f.contract_id,
   jsonb_build_object('visibility', next_visibility,
    'added', (select coalesce(jsonb_agg(u), '[]') from unnest(wanted) u where not u = any(before)),
    'removed', (select coalesce(jsonb_agg(u), '[]') from unnest(before) u where not u = any(wanted))));
  return jsonb_build_object('visibility', f.visibility, 'share_token', f.share_token, 'members', to_jsonb(wanted));
end $$;

-- Liga ou desliga o envio pelo link público (a pasta precisa estar pública).
create or replace function public.set_drive_folder_upload(p_folder uuid, p_enabled boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare f public.drive_folders; begin
 select * into f from public.drive_folders where id = p_folder for update;
 if not found or not mavi_private.drive_folder_manager(f) then
  raise exception 'Sem permissão para compartilhar esta pasta' using errcode = '42501';
 end if;
 if p_enabled and f.visibility <> 'public' then
  raise exception 'Ligue o link público da pasta antes.' using errcode = '22023';
 end if;
 update public.drive_folders set public_upload = coalesce(p_enabled, false) where id = f.id;
 perform mavi_private.drive_log(f.company_id, 'folder_shared', null, f.id, f.name, f.client_id, f.contract_id,
  jsonb_build_object('public_upload', coalesce(p_enabled, false)));
end $$;
revoke all on function public.set_drive_folder_upload(uuid, boolean) from public, anon;
grant execute on function public.set_drive_folder_upload(uuid, boolean) to authenticated;

-- A pasta pública diz também se aceita envio.
create or replace function public.drive_public_folder(p_token text, p_folder uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r public.drive_folders; target uuid; begin
  r := mavi_private.drive_public_root(p_token);
  if r.id is null then return null; end if;
  target := coalesce(p_folder, r.id);
  if not r.id in (select mavi_private.drive_folder_chain(r.company_id, target)) then return null; end if;
  return jsonb_build_object(
   'root', jsonb_build_object('id', r.id, 'name', r.name),
   'folder', target,
   'upload', r.public_upload,
   'company', (select name from public.companies where id = r.company_id),
   -- From the shared folder down to the one being shown.
   'path', (with recursive up(id, name, parent_id, depth) as (
     select f.id, f.name, f.parent_id, 0 from public.drive_folders f
      where f.company_id = r.company_id and f.id = target
     union all
     select f.id, f.name, f.parent_id, up.depth + 1 from public.drive_folders f
      join up on f.company_id = r.company_id and f.id = up.parent_id
     where up.id <> r.id and up.depth < 50)
    select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by depth desc) from up),
   'folders', (select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by f.name), '[]')
    from public.drive_folders f where f.company_id = r.company_id and f.parent_id = target),
   'files', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name,
     'content_type', d.content_type, 'size_bytes', d.size_bytes, 'created_at', d.created_at) order by d.name), '[]')
    from public.drive_files d where d.company_id = r.company_id and d.folder_id = target and d.status = 'ready'));
end $$;

-- Um envio pelo link público (só /api/drive chama, sem login): o arquivo
-- entra na pasta compartilhada, em nome de quem criou a pasta, e o envio
-- fica no histórico do Drive como anônimo. Imagem, vídeo, áudio ou PDF, até
-- 500 MB, e até 60 envios por hora por pasta.
create or replace function public.drive_public_upload(p_token text, p_name text, p_size bigint, p_content_type text,
 p_origin jsonb default '{}') returns table(id uuid, path text, content_type text)
language plpgsql security definer set search_path = '' as $$
declare r public.drive_folders; f uuid := gen_random_uuid(); kind text; name text; begin
 r := mavi_private.drive_public_root(p_token);
 if r.id is null or not r.public_upload then
  raise exception 'Esta pasta não recebe arquivos.' using errcode = '42501';
 end if;
 kind := coalesce(nullif(trim(p_content_type), ''), 'application/octet-stream');
 if split_part(kind, '/', 1) not in ('image', 'video', 'audio') and kind <> 'application/pdf' then
  raise exception 'Envie imagem, vídeo, áudio ou PDF.' using errcode = '22023';
 end if;
 if p_size is null or p_size < 1 or p_size > 524288000 then
  raise exception 'Envie arquivos de até 500 MB.' using errcode = '22023';
 end if;
 name := left(trim(regexp_replace(coalesce(p_name, ''), '[\\/\x00-\x1f]', '_', 'g')), 255);
 if name = '' then name := 'arquivo'; end if;
 if (select count(*) from public.drive_audit a where a.company_id = r.company_id and a.folder_id = r.id
  and a.action = 'public_upload_started' and a.created_at > now() - interval '1 hour') >= 60 then
  raise exception 'Muitos envios nesta pasta agora. Tente de novo em alguns minutos.' using errcode = '53400';
 end if;
 insert into public.drive_files(id, company_id, name, content_type, size_bytes, path, visibility, uploaded_by,
  client_id, contract_id, folder_id)
 values (f, r.company_id, name, kind, p_size, 'drive/' || r.company_id || '/' || f, 'private', r.created_by,
  r.client_id, r.contract_id, r.id);
 perform mavi_private.drive_log(r.company_id, 'public_upload_started', f, r.id, name, r.client_id, r.contract_id,
  jsonb_build_object('size_bytes', p_size, 'content_type', kind), mavi_private.clean_origin(p_origin));
 return query select f, 'drive/' || r.company_id || '/' || f, kind;
end $$;
revoke all on function public.drive_public_upload(text, text, bigint, text, jsonb) from public;
grant execute on function public.drive_public_upload(text, text, bigint, text, jsonb) to anon, authenticated;

-- O fim do envio pelo link. Avisa a tela do Social Leads quando a pasta é
-- a da prova social de um cliente.
create or replace function public.drive_public_upload_done(p_token text, p_file uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r public.drive_folders; f public.drive_files; b record; begin
 r := mavi_private.drive_public_root(p_token);
 if r.id is null or not r.public_upload then
  raise exception 'Esta pasta não recebe arquivos.' using errcode = '42501';
 end if;
 update public.drive_files d set status = 'ready'
 where d.id = p_file and d.company_id = r.company_id and d.folder_id = r.id and d.status = 'pending'
  and d.created_at > now() - interval '6 hours'
 returning * into f;
 if not found then raise exception 'Envio não encontrado.' using errcode = 'P0002'; end if;
 perform mavi_private.drive_log(f.company_id, 'public_upload_completed', f.id, f.folder_id, f.name, f.client_id,
  f.contract_id, jsonb_build_object('size_bytes', f.size_bytes, 'content_type', f.content_type));
 for b in select company_id, contract_id from public.social_leads_briefings where proof_folder = r.id loop
  perform mavi_private.broadcast(b.company_id, jsonb_build_object(
   'kind', 'social_leads', 'contract', b.contract_id, 'table', 'drive_files'));
 end loop;
end $$;
revoke all on function public.drive_public_upload_done(text, uuid) from public;
grant execute on function public.drive_public_upload_done(text, uuid) to anon, authenticated;

-- A pasta da prova social do cliente: uma pasta do produto contratado (a
-- escolhida, p_folder, ou uma nova com p_name) passa a ter link público que
-- aceita envio, e fica ligada ao briefing. p_enabled false desliga o link
-- (e o envio) e desliga a pasta do briefing; os arquivos ficam.
create or replace function public.social_leads_proof_folder(p_company uuid, p_contract uuid, p_folder uuid,
 p_name text default null, p_enabled boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare f public.drive_folders; k public.contracts; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para editar o briefing deste cliente.' using errcode = '42501';
 end if;
 select * into k from public.contracts where company_id = p_company and id = p_contract;
 if p_folder is null and p_enabled then
  if length(trim(coalesce(p_name, ''))) not between 1 and 120 then
   raise exception 'Dê um nome para a pasta.' using errcode = '22023';
  end if;
  insert into public.drive_folders(company_id, client_id, contract_id, parent_id, name, created_by)
  values (p_company, k.client_id, p_contract, null, trim(p_name), auth.uid()) returning * into f;
  perform mavi_private.drive_log(p_company, 'folder_created', null, f.id, f.name, f.client_id, f.contract_id);
 else
  select * into f from public.drive_folders where company_id = p_company and id = coalesce(p_folder,
   (select proof_folder from public.social_leads_briefings where company_id = p_company and contract_id = p_contract))
  for update;
  if not found or f.contract_id is distinct from p_contract then
   raise exception 'Pasta não encontrada neste produto do cliente.' using errcode = 'P0002';
  end if;
 end if;
 if p_enabled then
  update public.drive_folders set visibility = 'public', public_upload = true where id = f.id returning * into f;
  insert into public.social_leads_briefings(company_id, contract_id, proof_folder, updated_by)
  values (p_company, p_contract, f.id, auth.uid())
  on conflict (company_id, contract_id) do update set proof_folder = excluded.proof_folder;
 else
  update public.drive_folders set visibility = 'private', public_upload = false,
   share_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
  where id = f.id returning * into f;
  update public.social_leads_briefings set proof_folder = null
  where company_id = p_company and contract_id = p_contract and proof_folder = f.id;
 end if;
 perform mavi_private.drive_log(p_company, 'folder_shared', null, f.id, f.name, f.client_id, f.contract_id,
  jsonb_build_object('visibility', f.visibility, 'public_upload', f.public_upload, 'via', 'social_leads'));
 return jsonb_build_object('id', f.id, 'name', f.name, 'visibility', f.visibility,
  'public_upload', f.public_upload, 'share_token', case when f.visibility = 'public' then f.share_token end);
end $$;
revoke all on function public.social_leads_proof_folder(uuid, uuid, uuid, text, boolean) from public, anon;
grant execute on function public.social_leads_proof_folder(uuid, uuid, uuid, text, boolean) to authenticated;

-- ------------------------------------------------------------ dashboards
-- Tempo até a aprovação: até o último post do plano aprovado (8 ou mais).
create or replace function mavi_private.dashboard_sql(c uuid, q jsonb, p_group text, p_interval text,
 p_from date, p_to date, p_filters jsonb, p_limit integer) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  src text := q->>'source';
  metric text := q->>'metric';
  tz text;
  base text;
  conds text[];
  m text;
  additive boolean := true;
  datef text;
  col text;
  is_ts boolean := true;
  person text;
  late text;
  f jsonb;
  fld text;
  op text;
  vals text[];
  colf text;
  typed text;
  key text;
  label text;
  bucket text;
  other text := '';
  lim integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  filters jsonb;
  nodate boolean := false;
  -- Tasks, status history and validations all read the task (t.).
  on_task boolean := src in ('tasks', 'status_history', 'reviews');
  executor constant text := 'coalesce(t.executor_id, t.assignee_id)';
  validator constant text := 'coalesce(p.ended_by, p.user_id)';
  dur constant text := 'extract(epoch from (coalesce(p.ended_at, now()) - p.started_at))';
  delivered_day text;
  rework constant text := 'exists (select 1 from public.task_status_periods x where x.task_id = t.id'
   ' and (x.status in (''rejected'', ''correction'') or x.from_status = ''done''))';
  -- Temperatura (migration 20261110090000): the bands that warn, by index.
  bands jsonb;
  alert_bands integer[];
  ind text;
begin
  select timezone into tz from public.companies where id = c;
  if tz is null then raise exception 'Empresa não encontrada'; end if;
  late := format('((t.status <> ''done'' and t.due_date < (now() at time zone %1$L)::date)'
   ' or (t.delivered_at is not null and (t.delivered_at at time zone %1$L)::date > t.due_date))', tz);
  delivered_day := format('(t.delivered_at at time zone %L)::date', tz);

  if src = 'tasks' then
    base := 'public.tasks t';
    conds := array[format('t.company_id = %L', c), 'not t.archived'];
    person := 't.assignee_id';
    datef := coalesce(q->>'dateField', 'created_at');
    if datef = 'created_at' then col := 't.created_at';
    elsif datef = 'delivered_at' then col := 't.delivered_at';
    elsif datef = 'due_date' then col := 't.due_date'; is_ts := false;
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'count' then 'count(*)'
      when 'estimated_hours' then 'coalesce(sum(t.estimated_minutes), 0) / 60.0'
      when 'late' then format('count(*) filter (where %s)', late)
      when 'lead_time_days' then 'avg(extract(epoch from (t.delivered_at - t.created_at)) / 86400.0)'
      -- Migration 20261104090000: delivery quality.
      when 'on_time_rate' then format('100.0 * count(*) filter (where %s <= t.due_date) / nullif(count(*), 0)', delivered_day)
      when 'on_time_original_rate' then
        format('100.0 * count(*) filter (where %s <= t.original_due_date) / nullif(count(*), 0)', delivered_day)
      when 'delay_days' then format('avg((%1$s - t.due_date)::numeric) filter (where %1$s > t.due_date)', delivered_day)
      when 'rescheduled' then 'count(*) filter (where t.due_date <> t.original_due_date)'
      when 'first_pass_rate' then format('100.0 * count(*) filter (where not %s) / nullif(count(*), 0)', rework)
      when 'rework_per_task' then 'avg((select count(*) from public.task_status_periods x where x.task_id = t.id'
       ' and x.status in (''rejected'', ''correction'') and x.from_status is distinct from x.status))'
    end;
    if metric in ('lead_time_days', 'on_time_rate', 'on_time_original_rate', 'delay_days', 'first_pass_rate',
     'rework_per_task') then
      additive := false;
      conds := conds || 't.delivered_at is not null'::text;
    end if;
  elsif src = 'hours' then
    base := 'public.time_entries e';
    conds := array[format('e.company_id = %L', c)];
    person := 'e.user_id';
    col := 'e.started_at';
    m := case metric
      when 'hours' then 'coalesce(sum(extract(epoch from (coalesce(e.ended_at, now()) - e.started_at))), 0) / 3600.0'
      when 'entries' then 'count(*)'
      when 'people' then 'count(distinct e.user_id)'
      when 'tasks' then 'count(distinct e.task_id)'
    end;
    if metric in ('people', 'tasks') then additive := false; end if;
  elsif src = 'status_history' then
    -- Migration 20261104090000: each period a task spent in a status with a
    -- responsible. "Vezes" counts entries into the status (a change of hands
    -- inside it is not a new entry); time runs until now while open.
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived'];
    person := 'p.user_id';
    datef := coalesce(q->>'dateField', 'started_at');
    if datef = 'started_at' then col := 'p.started_at';
    elsif datef = 'ended_at' then col := 'p.ended_at';
    else raise exception 'Campo de data inválido: %', datef using errcode = '22023';
    end if;
    m := case metric
      when 'entries' then 'count(*) filter (where p.from_status is distinct from p.status)'
      when 'hours' then format('coalesce(sum(%s), 0) / 3600.0', dur)
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
      when 'tasks' then 'count(distinct p.task_id)'
      when 'reopens' then 'count(*) filter (where p.from_status = ''done'')'
    end;
    if metric in ('avg_hours', 'tasks') then additive := false; end if;
  elsif src = 'reviews' then
    -- Migration 20261104090000: the validation periods. Approved = left
    -- validation delivered; reproved = sent back to Alteração or Correção.
    -- The person is whoever sent it to validation; the validator, whoever
    -- decided (or held it, while undecided).
    base := 'public.task_status_periods p join public.tasks t on t.id = p.task_id';
    conds := array[format('p.company_id = %L', c), 'not t.archived', 'p.status = ''review'''];
    person := 'p.previous_user_id';
    -- Each metric has its own date: the sending or the decision.
    col := case when metric = 'sent' then 'p.started_at' else 'p.ended_at' end;
    m := case metric
      when 'sent' then 'count(*) filter (where p.from_status is distinct from ''review'')'
      when 'approved' then 'count(*) filter (where p.to_status = ''done'')'
      when 'reproved' then 'count(*) filter (where p.to_status in (''rejected'', ''correction''))'
      when 'approval_rate' then '100.0 * count(*) filter (where p.to_status = ''done'')'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'reproval_rate' then '100.0 * count(*) filter (where p.to_status in (''rejected'', ''correction''))'
       ' / nullif(count(*) filter (where p.to_status in (''done'', ''rejected'', ''correction'')), 0)'
      when 'avg_hours' then format('avg(%s) / 3600.0', dur)
    end;
    if metric in ('approval_rate', 'reproval_rate', 'avg_hours') then additive := false; end if;
  elsif src = 'notices' then
    -- Mural de avisos (migration 20261107090000): one row per person reached
    -- by a notice (its current round), dated by the delivery. Seen, confirmed
    -- ("Li e entendi", only notices that ask for it) and pending (not seen,
    -- or not confirmed when asked).
    base := 'public.notice_receipts r join public.notices n on n.id = r.notice_id';
    conds := array[format('r.company_id = %L', c)];
    person := 'r.user_id';
    col := 'r.delivered_at';
    m := case metric
      when 'notices' then 'count(distinct r.notice_id)'
      when 'delivered' then 'count(*)'
      when 'seen' then 'count(r.seen_at)'
      when 'pending' then 'count(*) filter (where r.seen_at is null or (n.require_ack and r.acked_at is null))'
      when 'seen_rate' then '100.0 * count(r.seen_at) / nullif(count(*), 0)'
      when 'acked' then 'count(r.acked_at)'
      when 'ack_rate' then '100.0 * count(r.acked_at) / nullif(count(*) filter (where n.require_ack), 0)'
      when 'hours_to_see' then 'avg(extract(epoch from (r.seen_at - r.delivered_at))) / 3600.0'
      when 'hours_to_ack' then 'avg(extract(epoch from (r.acked_at - r.delivered_at))) / 3600.0'
    end;
    if metric in ('notices', 'seen_rate', 'ack_rate', 'hours_to_see', 'hours_to_ack') then additive := false; end if;
  elsif src = 'temperature' then
    -- Termômetro (migration 20261110090000): one row per client and day with
    -- the day's temperature (0–100), each indicator and the alert signals.
    -- Averages over the client-days of the period; counts are distinct
    -- clients.
    select s.bands into bands from public.temperature_settings s where s.company_id = c;
    select coalesce(array_agg((x.n - 1)::integer), '{}') into alert_bands
    from jsonb_array_elements(coalesce(bands, '[]')) with ordinality x(b, n) where coalesce((x.b->>'alert')::boolean, false);
    base := 'public.temperature_days d join public.clients cl on cl.id = d.client_id';
    conds := array[format('d.company_id = %L', c), 'not cl.archived'];
    col := 'd.day';
    is_ts := false;
    ind := q->>'indicator';
    if metric = 'indicator' and coalesce(ind, '') !~ '^[a-z][a-z0-9_]{1,39}$' then
      raise exception 'Escolha o indicador do termômetro.' using errcode = '22023';
    end if;
    m := case metric
      when 'score' then 'avg(d.score)'
      when 'indicator' then format('avg((d.indicators->>%L)::numeric)', ind)
      when 'clients' then 'count(distinct d.client_id) filter (where d.score is not null)'
      when 'alert_clients' then format('count(distinct d.client_id) filter (where d.band = any(%L::integer[]))', alert_bands)
      when 'alert_rate' then format('100.0 * count(distinct d.client_id) filter (where d.band = any(%L::integer[]))'
       ' / nullif(count(distinct d.client_id) filter (where d.score is not null), 0)', alert_bands)
      when 'flag_clients' then 'count(distinct d.client_id) filter (where cardinality(d.flags) > 0)'
    end;
    additive := false;
  elsif src = 'social_leads' then
    -- Social Leads (migration 20261020120000): decisions from the posts'
    -- history, the time until a plan's 8 posts are approved, and the
    -- clients by stage (today's picture: no period).
    if metric in ('approvals', 'rejections', 'approval_rate', 'rejection_rate', 'adjust_per_post') then
      base := 'public.social_leads_post_events e join public.contracts k on k.id = e.contract_id';
      conds := array[format('e.company_id = %L', c), 'e.kind in (''approved'', ''rejected'')'];
      person := 'e.actor_id';
      col := 'e.created_at';
      m := case metric
        when 'approvals' then 'count(*) filter (where e.kind = ''approved'')'
        when 'rejections' then 'count(*) filter (where e.kind = ''rejected'')'
        when 'approval_rate' then '100.0 * count(*) filter (where e.kind = ''approved'') / nullif(count(*), 0)'
        when 'rejection_rate' then '100.0 * count(*) filter (where e.kind = ''rejected'') / nullif(count(*), 0)'
        when 'adjust_per_post' then
          'count(*) filter (where e.kind = ''rejected'')::numeric / nullif(count(distinct (e.plan_id, e.number)), 0)'
      end;
      if metric not in ('approvals', 'rejections') then additive := false; end if;
    elsif metric = 'approval_days' then
      base := '(select p.id, p.company_id, p.contract_id, p.created_at, p.created_by,'
       ' (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id) as approved_at'
       ' from public.social_leads_plans p where (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id and x.decision = ''approved'') = (select count(*) from public.social_leads_posts x'
       ' where x.plan_id = p.id)) a join public.contracts k on k.id = a.contract_id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.created_by';
      col := 'a.approved_at';
      m := 'avg(extract(epoch from (a.approved_at - a.created_at)) / 86400.0)';
      additive := false;
    elsif metric = 'clients' then
      base := '(select k2.id, k2.company_id, mavi_private.social_leads_stage(k2.company_id, k2.id) as stage,'
       ' (select b.responsible_id from public.social_leads_briefings b where b.company_id = k2.company_id'
       ' and b.contract_id = k2.id) as responsible'
       ' from public.contracts k2 join public.social_leads_settings s on s.company_id = k2.company_id'
       ' and s.product_id = k2.product_id join public.clients cl on cl.id = k2.client_id'
       ' where not k2.archived and not cl.archived) a join public.contracts k on k.id = a.id';
      conds := array[format('a.company_id = %L', c)];
      person := 'a.responsible';
      nodate := true;
      m := 'count(*)';
    end if;
  else
    raise exception 'Fonte de dados inválida: %', src using errcode = '22023';
  end if;
  if m is null then raise exception 'Métrica inválida: %', metric using errcode = '22023'; end if;

  if nodate then
    if p_group = 'time' then
      raise exception 'Clientes por etapa é a situação de hoje: agrupe por etapa, cliente ou sem agrupar.' using errcode = '22023';
    end if;
  elsif is_ts then
    conds := conds || format('%1$s >= (%2$L::timestamp at time zone %4$L) and %1$s < (%3$L::timestamp at time zone %4$L)',
     col, p_from, p_to + 1, tz);
  else
    conds := conds || format('%s between %L and %L', col, p_from, p_to);
  end if;

  -- The query's own filters, then the dashboard's (client, product, team, person).
  filters := coalesce(q->'filters', '[]'::jsonb);
  if jsonb_typeof(filters) <> 'array' then raise exception 'Filtros inválidos' using errcode = '22023'; end if;
  filters := filters || coalesce((
    select jsonb_agg(jsonb_build_object('field', x.field, 'values', p_filters->x.name))
    from (values ('clients','client'), ('products','product'), ('teams','team'), ('people','person')) x(name, field)
    where jsonb_typeof(p_filters->x.name) = 'array' and jsonb_array_length(p_filters->x.name) > 0
  ), '[]'::jsonb);
  if jsonb_array_length(filters) > 20 then raise exception 'Filtros demais' using errcode = '22023'; end if;
  for f in select value from jsonb_array_elements(filters) loop
    fld := f->>'field';
    op := coalesce(f->>'op', 'in');
    if op not in ('in', 'not_in') then raise exception 'Operador inválido: %', op using errcode = '22023'; end if;
    if jsonb_typeof(coalesce(f->'values', '[]'::jsonb)) <> 'array' then
      raise exception 'Valores de filtro inválidos' using errcode = '22023';
    end if;
    select coalesce(array_agg(x), '{}') into vals from jsonb_array_elements_text(coalesce(f->'values', '[]'::jsonb)) x;
    if cardinality(vals) = 0 then continue; end if;
    if cardinality(vals) > 500 then raise exception 'Filtro com valores demais' using errcode = '22023'; end if;
    if src = 'temperature' then
      -- A client's temperature: the client itself, the products it hires,
      -- the teams that serve it and the people in those teams; the project
      -- filter doesn't apply.
      if fld = 'project' then continue; end if;
      if fld = 'band' then
        conds := conds || format(case when op = 'in' then 'd.band = any(%L::integer[])'
          else '(d.band is null or d.band <> all(%L::integer[]))' end,
         (select coalesce(array_agg(v::integer), '{}') from unnest(vals) v where v ~ '^\d{1,2}$'));
        continue;
      end if;
      colf := case fld
        when 'client' then format('select %L::uuid[]', vals)
        when 'product' then format('select k.client_id from public.contracts k where k.company_id = %L'
          ' and not k.archived and k.product_id = any(%L::uuid[])', c, vals)
        when 'team' then format('select ct.client_id from public.client_teams ct where ct.company_id = %L'
          ' and ct.team_id = any(%L::uuid[])', c, vals)
        when 'person' then format('select ct.client_id from public.client_teams ct join public.team_members tm'
          ' on tm.company_id = ct.company_id and tm.team_id = ct.team_id where ct.company_id = %L'
          ' and tm.user_id = any(%L::uuid[])', c, vals)
      end;
      if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
      conds := conds || case when fld = 'client'
        then format(case when op = 'in' then 'd.client_id = any(%L::uuid[])' else 'd.client_id <> all(%L::uuid[])' end, vals)
        else format(case when op = 'in' then 'd.client_id in (%s)' else 'd.client_id not in (%s)' end, colf) end;
      continue;
    end if;
    if src = 'social_leads' then
      -- A team counts the clients it serves.
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'k.client_id', format('select ct.client_id from public.client_teams ct where ct.company_id = %L and ct.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('client', 'product', 'person') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    if src = 'notices' then
      -- Avisos não têm cliente, produto nem projeto: esses filtros do
      -- dashboard não se aplicam a eles. A equipe é a de quem recebeu.
      if fld in ('client', 'product', 'project') then continue; end if;
      if fld = 'team' then
        conds := conds || format(case when op = 'in' then '%1$s in (%2$s)' else '%1$s not in (%2$s)' end,
         'r.user_id', format('select tm.user_id from public.team_members tm where tm.company_id = %L and tm.team_id = any(%L::uuid[])',
          c, vals));
        continue;
      end if;
      if fld not in ('person', 'creator', 'level') then
        raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023';
      end if;
    end if;
    if fld = 'late' and src = 'tasks' then
      conds := conds || case when (vals[1] = 'true') = (op = 'in') then late else format('not %s', late) end;
      continue;
    end if;
    colf := case
      when fld = 'client' then 'k.client_id'
      when fld = 'product' then 'k.product_id'
      when fld = 'project' then 't.project_id'
      when fld = 'team' then 't.team_id'
      when fld = 'person' then person
      when fld = 'creator' and on_task then 't.creator_id'
      when fld = 'status' and src = 'tasks' then 't.status'
      when fld = 'status' and src = 'status_history' then 'p.status'
      when fld = 'priority' and on_task then 't.priority'
      when fld = 'entry_source' and src = 'hours' then 'e.source'
      when fld = 'executor' and src = 'tasks' then executor
      when fld = 'previous' and src = 'status_history' then 'p.previous_user_id'
      when fld = 'validator' and src = 'reviews' then validator
      when fld = 'creator' and src = 'notices' then 'n.created_by'
      when fld = 'level' and src = 'notices' then 'n.level'
    end;
    if colf is null then raise exception 'Filtro inválido para esta fonte: %', fld using errcode = '22023'; end if;
    typed := format(case when fld in ('status', 'priority', 'entry_source', 'level') then '%L::text[]' else '%L::uuid[]' end, vals);
    conds := conds || format(case when op = 'in' then '%1$s = any(%2$s)' else '(%1$s is null or %1$s <> all(%2$s))' end,
     colf, typed);
  end loop;

  -- Joins only when something reads the task (t.) or its contract (k.):
  -- hours by day or by person never touch tasks.
  key := case
    when src = 'temperature' then case p_group
      when 'client' then 'd.client_id' when 'band' then 'd.band'
      when 'team' then 'ctg.team_id' when 'product' then 'kpg.product_id' end
    when src = 'notices' then case p_group
      when 'person' then person when 'team' then 'tm.team_id' when 'creator' then 'n.created_by'
      when 'notice' then 'n.id' when 'level' then 'n.level' end
    when src = 'social_leads' then case p_group
      when 'client' then 'k.client_id' when 'product' then 'k.product_id' when 'person' then person
      when 'stage' then case when metric = 'clients' then 'a.stage' end end
    when p_group = 'client' then 'k.client_id'
    when p_group = 'product' then 'k.product_id'
    when p_group = 'project' then 't.project_id'
    when p_group = 'team' then 't.team_id'
    when p_group = 'person' then person
    when p_group = 'creator' and on_task then 't.creator_id'
    when p_group = 'status' and src = 'tasks' then 't.status'
    when p_group = 'status' and src = 'status_history' then 'p.status'
    when p_group = 'priority' and on_task then 't.priority'
    when p_group = 'executor' and src = 'tasks' then executor
    when p_group = 'previous' and src = 'status_history' then 'p.previous_user_id'
    when p_group = 'validator' and src = 'reviews' then validator
  end;
  if src = 'hours' and (strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 't.') > 0
   or strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0) then
    base := base || ' join public.tasks t on t.id = e.task_id';
  end if;
  if src = 'notices' and p_group = 'team' then
    base := base || ' join public.team_members tm on tm.company_id = r.company_id and tm.user_id = r.user_id';
  end if;
  if src = 'temperature' and p_group = 'team' then
    base := base || ' join public.client_teams ctg on ctg.company_id = d.company_id and ctg.client_id = d.client_id';
  end if;
  if src = 'temperature' and p_group = 'product' then
    base := base || ' join (select distinct x.company_id, x.client_id, x.product_id from public.contracts x'
     ' where not x.archived) kpg on kpg.company_id = d.company_id and kpg.client_id = d.client_id';
  end if;
  if src not in ('social_leads', 'notices', 'temperature')
   and strpos(array_to_string(conds, ' ') || ' ' || coalesce(key, ''), 'k.') > 0 then
    base := base || ' join public.contracts k on k.id = t.contract_id';
  end if;

  if p_group = 'none' then
    return format('select jsonb_build_array(jsonb_build_object(''k'', ''total'', ''v'', %s)) from %s where %s',
     m, base, array_to_string(conds, ' and '));
  end if;

  if p_group = 'time' then
    if p_interval not in ('day', 'week', 'month') then
      raise exception 'Intervalo inválido: %', p_interval using errcode = '22023';
    end if;
    bucket := case when is_ts then format('date_trunc(%L, %s at time zone %L)::date', p_interval, col, tz)
      else format('date_trunc(%L, %s::timestamp)::date', p_interval, col) end;
    return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 b as (select d::date as k from generate_series(date_trunc(%5$L, %6$L::timestamp), %7$L::timestamp, %8$L::interval) d)
 select coalesce(jsonb_agg(jsonb_build_object('k', b.k, 'v', %9$s) order by b.k), '[]') from b left join g on g.k = b.k$f$,
     bucket, m, base, array_to_string(conds, ' and '), p_interval, p_from, p_to, '1 ' || p_interval,
     case when additive then 'coalesce(g.v, 0)' else 'g.v' end);
  end if;

  if key is null then raise exception 'Agrupamento inválido para esta fonte: %', p_group using errcode = '22023'; end if;
  label := case
    when p_group = 'client' then '(select x.name from public.clients x where x.id = r.k)'
    when p_group = 'product' then '(select x.name from public.products x where x.id = r.k)'
    when p_group = 'project' then '(select x.name from public.projects x where x.id = r.k)'
    when p_group = 'team' then '(select x.name from public.teams x where x.id = r.k)'
    when p_group in ('person', 'creator', 'executor', 'previous', 'validator') then
      format('(select x.name from public.memberships x where x.company_id = %L and x.user_id = r.k)', c)
    when p_group = 'notice' then '(select x.title from public.notices x where x.id = r.k)'
    when p_group = 'level' then 'case r.k::text when ''info'' then ''Informativo'' when ''important'' then ''Importante'''
     ' when ''critical'' then ''Crítico'' else r.k::text end'
    when p_group = 'stage' then 'case r.k::text when ''briefing'' then ''Briefing'' when ''plan'' then ''Plano para revisar'''
     ' when ''approval'' then ''Aguardando o cliente'' when ''production'' then ''Aprovado / produção'''
     ' when ''campaign'' then ''Campanha no ar'' else r.k::text end'
    when p_group = 'band' then format('coalesce((%L::jsonb)->(r.k::integer)->>''name'', ''Sem nota'')', coalesce(bands, '[]'))
    else 'r.k::text'
  end;
  -- Sums and counts fold the rest into "Outros"; averages and distinct
  -- counts cannot be added up, so the rest is left out.
  if additive then
    other := format('union all select jsonb_build_object(''k'', ''__other__'', ''l'', ''Outros'', ''v'', sum(r.v)), %s from r where r.n > %s having count(*) > 0',
     lim + 1, lim);
  end if;
  return format($f$with g as (select %1$s as k, %2$s as v from %3$s where %4$s group by 1),
 r as (select k, v, row_number() over (order by v desc nulls last, k) as n from g)
 select coalesce(jsonb_agg(o order by n), '[]') from (
  select jsonb_build_object('k', r.k::text, 'l', %5$s, 'v', r.v) as o, r.n from r where r.n <= %6$s
  %7$s
 ) s$f$, key, m, base, array_to_string(conds, ' and '), label, lim, other);
end $$;
revoke all on function mavi_private.dashboard_sql(uuid, jsonb, text, text, date, date, jsonb, integer) from public, anon, authenticated;

-- As tarefas de arte que ninguém editou ganham a descrição com os textos.
update public.tasks t set description = mavi_private.social_leads_task_text(x, p.label)
from public.social_leads_posts x join public.social_leads_plans p on p.id = x.plan_id
where t.id = x.task_id and t.description = mavi_private.social_leads_task_text_v2(x, p.label)
 and t.description is distinct from mavi_private.social_leads_task_text(x, p.label);
drop function if exists mavi_private.social_leads_task_text_v2(public.social_leads_posts, text);

notify pgrst, 'reload schema';

commit;
