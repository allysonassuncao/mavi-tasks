begin;

-- Planejamento › Social Media: o mesmo módulo do Social Leads (briefing,
-- plano do mês com a MAVI, aprovação pelo link, produção das artes, ciclo e
-- campanha), ligado a outro produto do catálogo, o "Social Media".
--
-- - A configuração passa a ser uma por módulo (social_leads_settings.module):
--   cada módulo tem o seu produto, o seu squad, a sua equipe de criação e o
--   seu prazo de arte. Um produto só serve a um módulo.
-- - Briefings, planos, posts, tarefas e arquivos já eram do produto
--   contratado: os do Social Media são os dos contratos do produto Social
--   Media, sem nenhuma tabela nova.
-- - As funções que partem da empresa (carteira, "Adicionar cliente",
--   configurar) recebem o módulo (padrão 'social_leads', a tela de antes
--   continua valendo); as que partem do contrato ou do plano acham o módulo
--   pelo produto do contrato.
-- - O menu "Onboarding" passa a se chamar "Planejamento": os textos gerados
--   (tarefas de arte, do ciclo) dizem "Planejamento › Social Leads" ou
--   "Planejamento › Social Media". As tarefas que ninguém editou trocam o
--   texto, para continuarem acompanhando os posts.
-- - 'socialMedia' entra nos módulos que um administrador esconde por pessoa.

-- ------------------------------------------------------------ configuração por módulo
alter table public.social_leads_settings add column if not exists module text not null default 'social_leads'
 check (module in ('social_leads', 'social_media'));
alter table public.social_leads_settings drop constraint social_leads_settings_pkey;
alter table public.social_leads_settings add primary key (company_id, module);
alter table public.social_leads_settings add constraint social_leads_settings_product unique (company_id, product_id);

create or replace function mavi_private.social_leads_module_name(m text) returns text
language sql immutable set search_path = '' as $$
 select case m when 'social_media' then 'Social Media' else 'Social Leads' end
$$;
revoke all on function mavi_private.social_leads_module_name(text) from public, anon, authenticated;

-- O endereço da página do módulo (as notificações e o link da tarefa).
create or replace function mavi_private.social_leads_module_path(m text) returns text
language sql immutable set search_path = '' as $$
 select case m when 'social_media' then '/planejamento/social-media' else '/onboarding/social-leads' end
$$;
revoke all on function mavi_private.social_leads_module_path(text) from public, anon, authenticated;

-- O módulo de um produto contratado (pelo produto; sem configuração, Social Leads).
create or replace function mavi_private.social_leads_module_of(c uuid, k uuid) returns text
language sql stable security definer set search_path = '' as $$
 select coalesce((select s.module from public.contracts x
  join public.social_leads_settings s on s.company_id = x.company_id and s.product_id = x.product_id
  where x.company_id = c and x.id = k), 'social_leads')
$$;
revoke all on function mavi_private.social_leads_module_of(uuid, uuid) from public, anon, authenticated;

create or replace function mavi_private.social_leads_valid_module(m text) returns text
language plpgsql immutable set search_path = '' as $$ begin
 if coalesce(m, '') not in ('social_leads', 'social_media') then
  raise exception 'Módulo inválido.' using errcode = '22023';
 end if;
 return m;
end $$;
revoke all on function mavi_private.social_leads_valid_module(text) from public, anon, authenticated;

-- ------------------------------------------------------------ módulo no menu
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia']::text[]);

create or replace function public.set_member_pages(p_company uuid, p_user uuid, p_hidden text[]) returns void
language plpgsql security definer set search_path = '' as $$
declare v text[]; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Somente administradores escolhem os módulos de cada pessoa.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Usuário não encontrado na empresa';
 end if;
 select coalesce(array_agg(distinct x order by x), '{}') into v from unnest(coalesce(p_hidden, '{}')) x;
 if not v <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding','aiUsage','assistant','cases','notices',
  'temperature','socialMedia']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- ------------------------------------------------------------ configurar
drop function public.set_social_leads_settings(uuid, uuid, uuid, uuid, integer);
create function public.set_social_leads_settings(p_company uuid, p_product uuid, p_team uuid,
 p_design_team uuid default null, p_art_days integer default 5, p_module text default 'social_leads') returns void
language plpgsql security definer set search_path = '' as $$
declare m text := mavi_private.social_leads_valid_module(p_module); other text; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores configuram o %.', mavi_private.social_leads_module_name(m)
   using errcode = '42501';
 end if;
 if not exists (select 1 from public.products where company_id = p_company and id = p_product) then
  raise exception 'Produto não encontrado.' using errcode = 'P0002';
 end if;
 select module into other from public.social_leads_settings
 where company_id = p_company and product_id = p_product and module <> m;
 if found then
  raise exception 'Este produto já é o do %. Escolha outro produto.', mavi_private.social_leads_module_name(other)
   using errcode = '23505';
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
 insert into public.social_leads_settings(company_id, module, product_id, team_id, design_team_id, art_days,
  updated_by, updated_at)
 values (p_company, m, p_product, p_team, p_design_team, coalesce(p_art_days, 5), auth.uid(), now())
 on conflict (company_id, module) do update set product_id = excluded.product_id, team_id = excluded.team_id,
  design_team_id = excluded.design_team_id, art_days = excluded.art_days,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;
revoke all on function public.set_social_leads_settings(uuid, uuid, uuid, uuid, integer, text) from public, anon;
grant execute on function public.set_social_leads_settings(uuid, uuid, uuid, uuid, integer, text) to authenticated;

-- ------------------------------------------------------------ carteira
drop function public.social_leads_portfolio(uuid);
create function public.social_leads_portfolio(p_company uuid, p_module text default 'social_leads') returns jsonb
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
revoke all on function public.social_leads_portfolio(uuid, text) from public, anon;
grant execute on function public.social_leads_portfolio(uuid, text) to authenticated;

-- ------------------------------------------------------------ quem pode adicionar
-- O squad é o do módulo.
drop function if exists mavi_private.social_leads_may_add(uuid, uuid);
create function mavi_private.social_leads_may_add(c uuid, p_client uuid, p_module text default 'social_leads')
 returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(c)
  or exists (select 1 from public.client_teams ct
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id
   where ct.company_id = c and ct.client_id = p_client and tm.user_id = auth.uid())
  or exists (select 1 from public.social_leads_settings s
   join public.team_members tm on tm.company_id = s.company_id and tm.team_id = s.team_id
   where s.company_id = c and s.module = p_module and tm.user_id = auth.uid())
$$;
revoke all on function mavi_private.social_leads_may_add(uuid, uuid, text) from public, anon, authenticated;

drop function public.social_leads_addable_clients(uuid);
create function public.social_leads_addable_clients(p_company uuid, p_module text default 'social_leads') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare m text := mavi_private.social_leads_valid_module(p_module); s public.social_leads_settings; begin
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and active) then
  raise exception 'Sem acesso.' using errcode = '42501';
 end if;
 select * into s from public.social_leads_settings where company_id = p_company and module = m;
 if not found then return '[]'::jsonb; end if;
 return coalesce((
  select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'color', x.color,
    'archived_contract', x.archived_contract, 'hidden_contract', x.hidden_contract) order by x.name)
  from (
   select cl.id, cl.name, cl.color,
    (select k.id from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
      and k.product_id = s.product_id and k.archived order by k.created_at desc limit 1) as archived_contract,
    (select k.id from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
      and k.product_id = s.product_id and not k.archived order by k.created_at desc limit 1) as hidden_contract
   from public.clients cl
   where cl.company_id = p_company and not cl.archived
    and mavi_private.social_leads_may_add(p_company, cl.id, m)
    -- Fica de fora só quem já está na carteira da pessoa.
    and not exists (select 1 from public.contracts k where k.company_id = cl.company_id and k.client_id = cl.id
     and k.product_id = s.product_id and not k.archived and mavi_private.contract_read(k.company_id, k.id))
  ) x), '[]'::jsonb);
end $$;
revoke all on function public.social_leads_addable_clients(uuid, text) from public, anon;
grant execute on function public.social_leads_addable_clients(uuid, text) to authenticated;

drop function public.social_leads_add_client(uuid, uuid, text, uuid[]);
create function public.social_leads_add_client(p_company uuid, p_client uuid, p_name text,
 p_teams uuid[] default null, p_module text default 'social_leads') returns uuid
language plpgsql security definer set search_path = '' as $$
declare m text := mavi_private.social_leads_valid_module(p_module); n text;
 s public.social_leads_settings; pr public.products; cl public.clients; k uuid; seen boolean; begin
 n := mavi_private.social_leads_module_name(m);
 if not exists (select 1 from public.memberships where company_id = p_company and user_id = auth.uid() and active) then
  raise exception 'Sem acesso.' using errcode = '42501';
 end if;
 select * into s from public.social_leads_settings where company_id = p_company and module = m;
 if not found then raise exception 'Configure o % antes.', n using errcode = '22023'; end if;
 if p_client is null then
  raise exception 'Escolha um cliente já cadastrado. Clientes novos são cadastrados em Clientes.' using errcode = '22023';
 end if;
 select * into cl from public.clients where company_id = p_company and id = p_client and not archived;
 if not found then raise exception 'Cliente não encontrado.' using errcode = 'P0002'; end if;
 if not mavi_private.social_leads_may_add(p_company, cl.id, m) then
  raise exception 'Você só adiciona clientes atendidos por uma equipe sua.' using errcode = '42501';
 end if;
 seen := exists (select 1 from public.contracts x where x.company_id = p_company and x.client_id = cl.id
  and x.product_id = s.product_id and not x.archived and mavi_private.contract_read(p_company, x.id));
 if s.team_id is not null then
  insert into public.client_teams(company_id, client_id, team_id) values (p_company, cl.id, s.team_id)
  on conflict do nothing;
 end if;
 -- Já tem o produto (e a pessoa não o via): o squad passa a atendê-lo.
 select id into k from public.contracts where company_id = p_company and client_id = cl.id
  and product_id = s.product_id and not archived order by created_at desc limit 1;
 if found then
  -- Visible before the squad was added: it was in the portfolio already.
  if seen then
   raise exception 'Este cliente já está no %.', n using errcode = '23505';
  end if;
  if not mavi_private.contract_read(p_company, k) then
   raise exception 'Este cliente já está no %, atendido por equipes das quais você não faz parte. Peça para entrar na equipe do squad.', n
    using errcode = '42501';
  end if;
 else
  select id into k from public.contracts where company_id = p_company and client_id = cl.id
   and product_id = s.product_id and archived order by created_at desc limit 1 for update;
  if found then
   update public.contracts set archived = false where company_id = p_company and id = k;
  else
   select * into pr from public.products where company_id = p_company and id = s.product_id;
   insert into public.contracts(company_id, client_id, product_id, name)
   values (p_company, cl.id, s.product_id, left(coalesce(pr.name, n) || ' · ' || cl.name, 160))
   returning id into k;
  end if;
 end if;
 perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'social_leads', 'contract', k,
  'table', 'contracts'));
 return k;
end $$;
revoke all on function public.social_leads_add_client(uuid, uuid, text, uuid[], text) from public, anon;
grant execute on function public.social_leads_add_client(uuid, uuid, text, uuid[], text) to authenticated;

-- ------------------------------------------------------------ arquivar e excluir
-- O módulo vem do produto do contrato.
create or replace function public.social_leads_archive(p_contract uuid, p_archived boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.contracts; s public.social_leads_settings; n text; begin
 select * into k from public.contracts where id = p_contract for update;
 if not found then raise exception 'Cliente não encontrado no Social Leads.' using errcode = 'P0002'; end if;
 select * into s from public.social_leads_settings where company_id = k.company_id and product_id = k.product_id;
 if not found then
  raise exception 'Cliente não encontrado no Social Leads.' using errcode = 'P0002';
 end if;
 n := mavi_private.social_leads_module_name(s.module);
 if p_archived is null then raise exception 'Informe se o cliente sai do %.', n using errcode = '22023'; end if;
 if p_archived then
  if not mavi_private.social_leads_can_write(k.company_id, k.id) then
   raise exception 'Sem permissão para tirar este cliente do %.', n using errcode = '42501';
  end if;
  if exists (select 1 from public.social_leads_jobs where contract_id = k.id and status = 'running'
   and created_at > now() - interval '15 minutes') then
   raise exception 'A MAVI está gerando o plano deste cliente. Espere terminar para arquivar.' using errcode = '55P03';
  end if;
  update public.contracts set archived = true where id = k.id;
 else
  if not mavi_private.social_leads_may_add(k.company_id, k.client_id, s.module) then
   raise exception 'Você só adiciona clientes atendidos por uma equipe sua.' using errcode = '42501';
  end if;
  if exists (select 1 from public.contracts where company_id = k.company_id and client_id = k.client_id
   and product_id = k.product_id and not archived and id <> k.id) then
   raise exception 'Este cliente já está no %.', n using errcode = '23505';
  end if;
  if exists (select 1 from public.clients where company_id = k.company_id and id = k.client_id and archived) then
   raise exception 'Este cliente está arquivado em Clientes. Desarquive-o antes.' using errcode = '22023';
  end if;
  update public.contracts set archived = false where id = k.id;
  if s.team_id is not null then
   insert into public.client_teams(company_id, client_id, team_id) values (k.company_id, k.client_id, s.team_id)
   on conflict do nothing;
  end if;
 end if;
 perform mavi_private.broadcast(k.company_id, jsonb_build_object('kind', 'social_leads', 'contract', k.id,
  'table', 'contracts'));
end $$;

create or replace function public.social_leads_remove(p_contract uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare k public.contracts; s public.social_leads_settings; n text; begin
 select * into k from public.contracts where id = p_contract for update;
 select * into s from public.social_leads_settings where company_id = k.company_id and product_id = k.product_id;
 if k.id is null or s.company_id is null then
  raise exception 'Cliente não encontrado no Social Leads.' using errcode = 'P0002';
 end if;
 n := mavi_private.social_leads_module_name(s.module);
 if not mavi_private.social_leads_can_write(k.company_id, k.id) then
  raise exception 'Sem permissão para tirar este cliente do %.', n using errcode = '42501';
 end if;
 if exists (select 1 from public.social_leads_plans where contract_id = k.id)
  or exists (select 1 from public.tasks where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.projects where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.drive_files where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.drive_folders where company_id = k.company_id and contract_id = k.id)
  or exists (select 1 from public.ad_campaigns where company_id = k.company_id and contract_id = k.id) then
  raise exception 'Este cliente já tem histórico no % (plano, tarefa ou arquivo). Arquive em vez de excluir.', n
   using errcode = '23503';
 end if;
 begin
  delete from public.social_leads_ai_usage where contract_id = k.id;
  delete from public.social_leads_jobs where contract_id = k.id;
  delete from public.social_leads_briefings where company_id = k.company_id and contract_id = k.id;
  delete from public.contracts where id = k.id;
 exception when foreign_key_violation then
  -- Something else of the app still points at the product (hours, notes…).
  raise exception 'Este cliente já tem histórico ligado a este produto. Arquive em vez de excluir.'
   using errcode = '23503';
 end;
 perform mavi_private.broadcast(k.company_id, jsonb_build_object('kind', 'social_leads', 'contract', k.id,
  'table', 'contracts'));
end $$;

-- ------------------------------------------------------------ textos das tarefas
-- As tarefas de arte que ninguém editou passam a dizer "Planejamento › …"
-- (com o texto de antes, o gatilho que acompanha os posts deixaria de
-- reconhecê-las). Troca feita antes de redefinir o texto.
update public.tasks t set description = replace(t.description,
  'Onde fica: Onboarding › Social Leads › ',
  'Onde fica: Planejamento › ' || mavi_private.social_leads_module_name(
   mavi_private.social_leads_module_of(x.company_id, x.contract_id)) || ' › ')
from public.social_leads_posts x join public.social_leads_plans p on p.id = x.plan_id
where t.id = x.task_id and t.description = mavi_private.social_leads_task_text(x, p.label);

-- Deixa de ser immutable: o módulo vem do produto do contrato.
create or replace function mavi_private.social_leads_task_text(x public.social_leads_posts, p_label text) returns text
language sql stable security definer set search_path = '' as $$
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
    'Onde fica: Planejamento › ' || mavi_private.social_leads_module_name(
     mavi_private.social_leads_module_of(x.company_id, x.contract_id)) || ' › ' || p_label || ' › Post ' || x.number,
    '[{"type":"italic"}]')
  ]) with ordinality as u(b, n) where b is not null), '[]'::jsonb))::text
$$;
revoke all on function mavi_private.social_leads_task_text(public.social_leads_posts, text) from public, anon, authenticated;

-- As tarefas do ciclo que ainda estão com o texto de antes.
update public.tasks t set description = replace(t.description, 'em Onboarding › Social Leads.',
  'em Planejamento › ' || mavi_private.social_leads_module_name(
   mavi_private.social_leads_module_of(t.company_id, t.contract_id)) || '.')
where t.description = 'Apresente os resultados do mês ao cliente e gere o plano do próximo mês em Onboarding › Social Leads.';

create or replace function mavi_private.social_leads_start_cycle(p_company uuid, p_contract uuid,
 p_followup uuid default null, p_meeting uuid default null) returns boolean
language plpgsql security definer set search_path = '' as $$
declare b public.social_leads_briefings; client text; today date; f uuid; m uuid; begin
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract for update;
 if not found or b.cycle ? 'followup' then return false; end if;
 if exists (select 1 from unnest(array[p_followup, p_meeting]) as u where u is not null and not exists (
  select 1 from public.memberships where company_id = p_company and user_id = u and active)) then
  raise exception 'Responsável do ciclo inválido.' using errcode = '22023';
 end if;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 where k.company_id = p_company and k.id = p_contract;
 today := mavi_private.company_today(p_company);
 f := public.create_task(p_company, p_contract, left('Acompanhamento quinzenal · ' || client, 240),
  coalesce(p_followup, auth.uid()), today + 14,
  null, null, 'Revise os resultados das últimas duas semanas (alcance, seguidores, leads) e alinhe com o cliente o que ajustar.',
  'normal', 30, false, null, null, '{}', 'biweekly');
 m := public.create_task(p_company, p_contract, left('Reunião de resultados e novo plano · ' || client, 240),
  coalesce(p_meeting, auth.uid()), today + 28,
  null, null, 'Apresente os resultados do mês ao cliente e gere o plano do próximo mês em Planejamento › '
   || mavi_private.social_leads_module_name(mavi_private.social_leads_module_of(p_company, p_contract)) || '.',
  'high', 60, false, null, null, '{}', 'monthly');
 update public.social_leads_briefings set cycle = jsonb_build_object('followup', f, 'meeting', m, 'started_at', now())
 where company_id = p_company and contract_id = p_contract;
 return true;
end $$;

-- ------------------------------------------------------------ liberar produção
-- A equipe de criação e o prazo são os do módulo do contrato.
create or replace function public.social_leads_release(p_plan uuid, p_assign jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; s public.social_leads_settings; fallback uuid; client uuid; name text;
 x public.social_leads_posts; a jsonb; team uuid; who uuid; t uuid; n integer := 0; due date; cyc boolean;
 cycle jsonb; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if p_assign is not null and jsonb_typeof(p_assign) <> 'object' then
  raise exception 'Escolha de responsáveis inválida.' using errcode = '22023';
 end if;
 cycle := coalesce(p_assign->'cycle', '{}');
 if jsonb_typeof(cycle) <> 'object'
  or coalesce(jsonb_typeof(cycle->'followup'), 'string') <> 'string'
  or coalesce(jsonb_typeof(cycle->'meeting'), 'string') <> 'string'
  or coalesce(cycle->>'followup', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f-]{36}$'
  or coalesce(cycle->>'meeting', '00000000-0000-0000-0000-000000000000') !~* '^[0-9a-f-]{36}$' then
  raise exception 'Responsável do ciclo inválido.' using errcode = '22023';
 end if;
 select s2.* into s from public.contracts k2
 join public.social_leads_settings s2 on s2.company_id = k2.company_id and s2.product_id = k2.product_id
 where k2.company_id = p.company_id and k2.id = p.contract_id;
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
 cyc := mavi_private.social_leads_start_cycle(p.company_id, p.contract_id,
  (cycle->>'followup')::uuid, (cycle->>'meeting')::uuid);
 return jsonb_build_object('created', n, 'cycle', cyc);
end $$;

-- ------------------------------------------------------------ campanha
create or replace function public.social_leads_create_campaign(p_plan uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; client text; ad text; notes text; n text; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.contract_read(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if not mavi_private.leader(p.company_id) then
  raise exception 'Somente administradores e gestores criam campanhas.' using errcode = '42501';
 end if;
 n := mavi_private.social_leads_module_name(mavi_private.social_leads_module_of(p.company_id, p.contract_id));
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = p.company_id and k.id = p.contract_id;
 select format('Post %s: %s (%s · %s)', x.number, x.hook, x.format, x.cta) into ad
 from public.social_leads_posts x where x.plan_id = p.id and x.is_ad;
 notes := left(concat_ws(E'\n',
  'Criada a partir do ' || n || ' · ' || p.label || '.',
  'Objetivo: ' || nullif(p.content->'campanha'->>'objetivo', ''),
  'Região: ' || nullif(p.content->'campanha'->>'regiao', ''),
  'Idade e gênero: ' || nullif(p.content->'campanha'->>'idadeGenero', ''),
  'Segmentação: ' || nullif(p.content->'campanha'->>'segmentacao', ''),
  'Posicionamentos: ' || nullif(p.content->'campanha'->>'posicionamentos', ''),
  'Orçamento: ' || nullif(p.content->'campanha'->>'orcamento', ''),
  'Como o lead chega: ' || nullif(p.content->'campanha'->>'roteamentoLead', ''),
  'Anúncio: ' || ad), 4000);
 return public.create_ad_campaign(p.company_id, p.contract_id, left(n || ' · ' || client, 160), 'meta', '', '', notes);
end $$;

-- ------------------------------------------------------------ aviso de plano pronto
-- O link abre a página do módulo do contrato.
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
    || coalesce(format(' Custo da MAVI: US$ %s.', replace(to_char(cost, 'FM9990.00'), '.', ',')), '')
   else left(p_error, 300) end,
  mavi_private.social_leads_module_path(mavi_private.social_leads_module_of(j.company_id, j.contract_id))
   || '?contrato=' || j.contract_id);
end $$;

notify pgrst, 'reload schema';

commit;
