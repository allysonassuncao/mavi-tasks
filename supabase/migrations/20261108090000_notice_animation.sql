begin;

-- Mural de avisos · fase 3: a animação do aviso.
--
-- A MAVI devolve um roteiro de cenas (JSON, formato fechado em
-- src/notice-animation.ts) e o player do SaaS o anima: nenhum código gerado
-- roda no app. Até 30 segundos, só visual.
--
-- - Cada geração, ajuste por conversa ou edição de texto das cenas é uma
--   versão (notice_animations). notices.animation_id é a versão que quem
--   recebe vê; num aviso no ar, trocar de versão é escolha de quem edita.
-- - A geração roda em segundo plano (/api/drive, ação "notice-animate"):
--   start_notice_animation abre a versão 'generating' e devolve o que o
--   servidor precisa (provedor, prints, versão anterior); ao terminar,
--   finish_notice_animation grava o roteiro e avisa quem pediu na caixa de
--   entrada. Uma geração por aviso de cada vez; presa há mais de 10 minutos
--   conta como falha.
-- - Quem gera escolhe entre os modelos que um administrador liberou
--   (notice_animation_models: para todos os líderes, ou só para certas
--   pessoas ou equipes); sem nenhum liberado, vale o modelo da
--   funcionalidade 'notice_animation' do Painel da MAVI. A base de
--   conhecimento só entra quando o administrador permite
--   (notice_animation_settings) e quem gera liga.
-- - Os prints são imagens anexadas ao próprio aviso: quem recebe já pode
--   abri-las, e o player as mostra por links assinados.

-- ------------------------------------------------------------ funcionalidade
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation')));

-- A caixa de entrada avisa quando a animação fica pronta (ou falha).
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation')) = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- ------------------------------------------------------------ tabelas
create table public.notice_animation_settings (
 company_id uuid primary key references public.companies(id),
 knowledge boolean not null default true,
 updated_at timestamptz not null default now(),
 updated_by uuid
);
alter table public.notice_animation_settings enable row level security;
revoke all on public.notice_animation_settings from public, anon, authenticated;

create table public.notice_animation_models (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 provider_id uuid not null references mavi_private.ai_providers(id) on delete cascade,
 model text not null check (length(model) between 1 and 120),
 -- Vazios os dois: todos os administradores e gestores.
 user_ids uuid[] not null default '{}',
 team_ids uuid[] not null default '{}',
 position integer not null default 0,
 created_at timestamptz not null default now(),
 unique (company_id, provider_id, model)
);
alter table public.notice_animation_models enable row level security;
revoke all on public.notice_animation_models from public, anon, authenticated;

create table public.notice_animations (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 notice_id uuid not null,
 version integer not null check (version >= 1),
 status text not null check (status in ('generating', 'ready', 'failed')),
 -- 'mavi': gerada ou ajustada pela MAVI; 'manual': texto das cenas editado.
 source text not null check (source in ('mavi', 'manual')),
 request text not null default '' check (length(request) <= 4000),
 base_id uuid,
 spec jsonb check (spec is null or (jsonb_typeof(spec) = 'object' and octet_length(spec::text) <= 200000)),
 refs uuid[] not null default '{}',
 knowledge boolean not null default false,
 provider_id uuid,
 model text,
 cost_usd numeric,
 error text,
 created_by uuid not null,
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 unique (company_id, id),
 unique (notice_id, version),
 foreign key (company_id, notice_id) references public.notices(company_id, id) on delete cascade,
 check ((status = 'ready') = (spec is not null))
);
create index notice_animations_notice on public.notice_animations(notice_id, version desc);
alter table public.notice_animations enable row level security;
revoke all on public.notice_animations from public, anon, authenticated;

alter table public.notices add column animation_id uuid references public.notice_animations(id) on delete set null;

-- ------------------------------------------------------------ regras
-- Os modelos que a pessoa pode usar para gerar (com o preço do modelo).
create function mavi_private.notice_animation_choices(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('provider_id', p.id, 'provider', p.name, 'kind', p.kind,
   'model', m.model, 'price', (select x from jsonb_array_elements(p.models) x where x->>'id' = m.model limit 1))
  order by m.position, p.name, m.model), '[]')
 from public.notice_animation_models m
 join mavi_private.ai_providers p on p.id = m.provider_id and p.company_id = m.company_id and p.active
 where m.company_id = c and mavi_private.leader(c)
  and exists (select 1 from jsonb_array_elements(p.models) x where x->>'id' = m.model)
  and (mavi_private.admin(c)
   or (cardinality(m.user_ids) = 0 and cardinality(m.team_ids) = 0)
   or auth.uid() = any(m.user_ids)
   or exists (select 1 from public.team_members tm where tm.company_id = c and tm.user_id = auth.uid()
    and tm.team_id = any(m.team_ids)))
$$;

create function public.notice_animation_options(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_route jsonb; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores criam animações.' using errcode = '42501';
 end if;
 v_route := public.ai_resolve_route(p_company, null, null, null, 'notice_animation');
 return jsonb_build_object(
  'knowledge', coalesce((select knowledge from public.notice_animation_settings where company_id = p_company), true),
  'models', mavi_private.notice_animation_choices(p_company),
  'default', case when v_route is null then null else jsonb_build_object('provider_id', v_route->>'provider_id',
   'provider', v_route->>'provider', 'kind', v_route->>'kind', 'model', v_route->>'model', 'price', v_route->'price') end,
  'can_manage', mavi_private.admin(p_company));
end $$;

-- O que o administrador vê e muda no Painel da MAVI.
create function public.notice_animation_admin(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'knowledge', coalesce((select knowledge from public.notice_animation_settings where company_id = p_company), true),
  'models', coalesce((select jsonb_agg(jsonb_build_object('provider_id', m.provider_id, 'model', m.model,
    'user_ids', to_jsonb(m.user_ids), 'team_ids', to_jsonb(m.team_ids)) order by m.position)
   from public.notice_animation_models m where m.company_id = p_company), '[]'));
end $$;

create function public.set_notice_animation_admin(p_company uuid, p_knowledge boolean, p_models jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare x jsonb; i integer := 0; v_provider uuid; v_model text; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem os modelos das animações.' using errcode = '42501';
 end if;
 if jsonb_typeof(coalesce(p_models, '[]')) <> 'array' or jsonb_array_length(coalesce(p_models, '[]')) > 20 then
  raise exception 'Lista de modelos inválida' using errcode = '22023';
 end if;
 insert into public.notice_animation_settings(company_id, knowledge, updated_by)
 values (p_company, coalesce(p_knowledge, true), auth.uid())
 on conflict (company_id) do update set knowledge = excluded.knowledge, updated_at = now(), updated_by = auth.uid();
 delete from public.notice_animation_models where company_id = p_company;
 for x in select * from jsonb_array_elements(coalesce(p_models, '[]')) loop
  v_provider := nullif(x->>'provider_id', '')::uuid;
  v_model := x->>'model';
  if not exists (select 1 from mavi_private.ai_providers p where p.id = v_provider and p.company_id = p_company
    and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = v_model)) then
   raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
  end if;
  insert into public.notice_animation_models(company_id, provider_id, model, user_ids, team_ids, position)
  values (p_company, v_provider, v_model,
   coalesce((select array_agg(distinct u::uuid) from jsonb_array_elements_text(coalesce(x->'user_ids', '[]')) u
    where exists (select 1 from public.memberships mm where mm.company_id = p_company and mm.user_id = u::uuid)), '{}'),
   coalesce((select array_agg(distinct t::uuid) from jsonb_array_elements_text(coalesce(x->'team_ids', '[]')) t
    where exists (select 1 from public.teams tt where tt.company_id = p_company and tt.id = t::uuid)), '{}'),
   i)
  on conflict (company_id, provider_id, model) do nothing;
  i := i + 1;
 end loop;
end $$;

-- ------------------------------------------------------------ gerar
-- Abre uma geração (ou um ajuste de p_base) e devolve ao servidor o que ele
-- precisa. p_provider nulo: o modelo da funcionalidade (ou o do servidor).
create function public.start_notice_animation(p_notice uuid, p_request text, p_provider uuid, p_model text,
 p_refs uuid[], p_knowledge boolean, p_base uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n public.notices; b public.notice_animations; v_id uuid; v_version integer; v_route jsonb;
 v_request text := btrim(coalesce(p_request, '')); v_refs uuid[]; v_knowledge boolean; begin
 select * into n from public.notices where id = p_notice for update;
 if not found or not mavi_private.notice_can_edit(n) then
  raise exception 'Sem permissão para criar a animação deste aviso.' using errcode = '42501';
 end if;
 if length(v_request) < 3 or length(v_request) > 4000 then
  raise exception 'Conte para a MAVI o que a animação deve mostrar.' using errcode = '22023';
 end if;
 update public.notice_animations set status = 'failed', error = 'A geração demorou demais.', finished_at = now()
 where notice_id = n.id and status = 'generating' and created_at < now() - interval '10 minutes';
 if exists (select 1 from public.notice_animations where notice_id = n.id and status = 'generating') then
  raise exception 'A MAVI já está criando uma animação para este aviso. Espere ela terminar.' using errcode = '22023';
 end if;
 if p_base is not null then
  select * into b from public.notice_animations where id = p_base and notice_id = n.id and status = 'ready';
  if not found then raise exception 'Versão não encontrada.' using errcode = 'P0002'; end if;
 end if;
 -- O provedor: um dos liberados para a pessoa, ou o da funcionalidade.
 if p_provider is not null then
  if not exists (select 1 from jsonb_array_elements(mavi_private.notice_animation_choices(n.company_id)) x
    where x->>'provider_id' = p_provider::text and x->>'model' = p_model) then
   raise exception 'Este modelo não está liberado para você criar animações.' using errcode = '42501';
  end if;
  select jsonb_build_object('scope', 'notice_animation', 'provider_id', p.id, 'provider', p.name, 'kind', p.kind,
   'base_url', p.base_url, 'key_cipher', p.key_cipher, 'model', p_model,
   'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = p_model limit 1))
  into v_route from mavi_private.ai_providers p where p.id = p_provider;
 else
  v_route := public.ai_resolve_route(n.company_id, null, null, null, 'notice_animation');
 end if;
 v_refs := coalesce((select array_agg(a.id order by a.position) from public.notice_attachments a
  where a.notice_id = n.id and a.status = 'ready' and a.id = any(coalesce(p_refs, '{}'))
   and a.content_type in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')), '{}');
 v_refs := v_refs[1:6];
 v_knowledge := coalesce(p_knowledge, false)
  and coalesce((select knowledge from public.notice_animation_settings where company_id = n.company_id), true);
 v_version := coalesce((select max(version) from public.notice_animations where notice_id = n.id), 0) + 1;
 insert into public.notice_animations(company_id, notice_id, version, status, source, request, base_id, refs,
  knowledge, provider_id, model, created_by)
 values (n.company_id, n.id, v_version, 'generating', 'mavi', v_request, p_base, v_refs, v_knowledge,
  (v_route->>'provider_id')::uuid, v_route->>'model', auth.uid())
 returning id into v_id;
 perform mavi_private.broadcast(n.company_id, jsonb_build_object('kind', 'notice', 'notice', n.id,
  'users', jsonb_build_array(auth.uid())));
 return jsonb_build_object('id', v_id, 'version', v_version, 'company_id', n.company_id, 'route', v_route,
  'notice', jsonb_build_object('title', n.title, 'text', mavi_private.rich_plain(n.body), 'level', n.level),
  'base', case when b.id is null then null else b.spec end,
  'knowledge', v_knowledge,
  'refs', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'content_type', a.content_type,
    'size_bytes', a.size_bytes, 'path', coalesce(a.path, f.path)) order by array_position(v_refs, a.id))
   from public.notice_attachments a
   left join public.drive_files f on f.company_id = a.company_id and f.id = a.drive_file_id
   where a.id = any(v_refs)), '[]'));
end $$;

-- O fim da geração (quem pediu, com o token dela): o roteiro ou o erro.
create function public.finish_notice_animation(p_animation uuid, p_spec jsonb, p_error text, p_cost numeric)
returns void
language plpgsql security definer set search_path = '' as $$
declare a public.notice_animations; n public.notices; begin
 select * into a from public.notice_animations where id = p_animation for update;
 if not found or a.created_by <> auth.uid() then raise exception 'Geração não encontrada.' using errcode = 'P0002'; end if;
 if a.status <> 'generating' then return; end if;
 select * into n from public.notices where id = a.notice_id for update;
 update public.notice_animations set
  status = case when p_error is null and p_spec is not null then 'ready' else 'failed' end,
  spec = case when p_error is null then p_spec end,
  error = case when p_error is not null or p_spec is null then left(coalesce(p_error, 'A MAVI não devolveu a animação.'), 1000) end,
  cost_usd = case when p_cost >= 0 and p_cost < 100 then p_cost end,
  finished_at = now()
 where id = a.id returning * into a;
 -- A primeira versão pronta (ou qualquer uma, num aviso que ainda não está
 -- no ar) passa a ser a do aviso; no ar, quem edita escolhe.
 if a.status = 'ready' and (n.animation_id is null or mavi_private.notice_status(n) <> 'live') then
  update public.notices set animation_id = a.id where id = n.id;
  if mavi_private.notice_status(n) = 'live' then perform mavi_private.notice_changed(n.company_id, n.id); end if;
 end if;
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 values (a.company_id, a.created_by, null, null, 'notice_animation',
  left(case when a.status = 'ready' then 'Animação pronta: ' else 'A animação falhou: ' end || n.title, 300),
  case when a.status = 'ready'
   then 'Confira a versão ' || a.version || ' e ajuste o que quiser.'
    || coalesce(format(' Custo da MAVI: US$ %s.', replace(to_char(a.cost_usd, 'FM9990.00'), '.', ',')), '')
   else left(a.error, 300) end,
  '/mural?aviso=' || n.id || '&animacao=1');
 perform mavi_private.broadcast(n.company_id, jsonb_build_object('kind', 'notice', 'notice', n.id,
  'users', jsonb_build_array(a.created_by)));
end $$;

-- Texto das cenas editado à mão: uma versão nova, sem a MAVI.
create function public.save_notice_animation(p_notice uuid, p_spec jsonb, p_base uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare n public.notices; b public.notice_animations; v_id uuid; begin
 select * into n from public.notices where id = p_notice for update;
 if not found or not mavi_private.notice_can_edit(n) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if jsonb_typeof(p_spec) is distinct from 'object' or jsonb_typeof(p_spec->'scenes') is distinct from 'array'
  or jsonb_array_length(p_spec->'scenes') not between 1 and 10 or octet_length(p_spec::text) > 200000 then
  raise exception 'Animação inválida' using errcode = '22023';
 end if;
 select * into b from public.notice_animations where id = p_base and notice_id = n.id and status = 'ready';
 insert into public.notice_animations(company_id, notice_id, version, status, source, request, base_id, spec, refs,
  created_by, finished_at)
 values (n.company_id, n.id, coalesce((select max(version) from public.notice_animations where notice_id = n.id), 0) + 1,
  'ready', 'manual', '', b.id, p_spec, coalesce(b.refs, '{}'), auth.uid(), now())
 returning id into v_id;
 if mavi_private.notice_status(n) <> 'live' then
  update public.notices set animation_id = v_id where id = n.id;
 end if;
 return v_id;
end $$;

-- A versão que quem recebe vê (nulo: o aviso fica sem animação).
create function public.use_notice_animation(p_notice uuid, p_animation uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare n public.notices; begin
 select * into n from public.notices where id = p_notice for update;
 if not found or not mavi_private.notice_can_edit(n) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if p_animation is not null and not exists (select 1 from public.notice_animations
   where id = p_animation and notice_id = n.id and status = 'ready') then
  raise exception 'Versão não encontrada.' using errcode = 'P0002';
 end if;
 update public.notices set animation_id = p_animation, updated_at = now() where id = n.id;
 perform mavi_private.notice_changed(n.company_id, n.id);
end $$;

-- As versões (só quem edita).
create function public.notice_animations(p_notice uuid)
returns table(id uuid, version integer, status text, source text, request text, spec jsonb, refs uuid[],
 knowledge boolean, provider_id uuid, model text, cost_usd numeric, error text, author_name text,
 created_at timestamptz, finished_at timestamptz, current boolean)
language sql stable security definer set search_path = '' as $$
 select a.id, a.version, a.status, a.source, a.request, a.spec, a.refs, a.knowledge, a.provider_id, a.model,
  a.cost_usd, a.error, mavi_private.member_name(a.company_id, a.created_by), a.created_at, a.finished_at,
  a.id is not distinct from n.animation_id
 from public.notices n join public.notice_animations a on a.notice_id = n.id
 where n.id = p_notice and mavi_private.notice_can_edit(n)
 order by a.version desc
 limit 100
$$;

-- ------------------------------------------------------------ quem recebe
-- A animação da versão escolhida vai com o aviso (popup e aviso aberto).
drop function public.my_live_notices(uuid);
create function public.my_live_notices(p_company uuid)
returns table(id uuid, title text, body text, level text, popup boolean, banner boolean, pinned boolean,
 require_ack boolean, round integer, publish_at timestamptz, expires_at timestamptz, author_name text,
 delivered_at timestamptz, seen_at timestamptz, acked_at timestamptz, snoozed_until timestamptz,
 banner_closed_at timestamptz, attachments integer, reminded_at timestamptz, animation jsonb)
language sql stable security definer set search_path = '' as $$
 select n.id, n.title, n.body, n.level, n.popup, n.banner, n.pinned, n.require_ack, n.round, n.publish_at,
  n.expires_at, mavi_private.member_name(n.company_id, n.created_by), r.delivered_at, r.seen_at, r.acked_at,
  r.snoozed_until, r.banner_closed_at,
  (select count(*)::integer from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready'),
  r.reminded_at,
  (select x.spec from public.notice_animations x where x.id = n.animation_id and x.status = 'ready')
 from public.notice_receipts r
 join public.notices n on n.id = r.notice_id and n.round = r.round
 where r.company_id = p_company and r.user_id = auth.uid() and mavi_private.member(p_company)
  and mavi_private.notice_status(n) = 'live'
 order by case n.level when 'critical' then 0 when 'important' then 1 else 2 end, r.delivered_at desc
 limit 50
$$;

create or replace function public.notice_detail(p_notice uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n public.notices; r public.notice_receipts; v_edit boolean; begin
 select * into n from public.notices where id = p_notice;
 if not found or not mavi_private.notice_can_see(n) then return null; end if;
 v_edit := mavi_private.notice_can_edit(n);
 select * into r from public.notice_receipts where notice_id = n.id and user_id = auth.uid();
 return jsonb_build_object(
  'id', n.id, 'company_id', n.company_id, 'title', n.title, 'body', n.body, 'level', n.level,
  'popup', n.popup, 'inbox', n.inbox, 'push', n.push, 'banner', n.banner, 'pinned', n.pinned,
  'require_ack', n.require_ack, 'publish_at', n.publish_at, 'expires_at', n.expires_at, 'repeat', n.repeat,
  'next_repeat', n.next_repeat, 'round', n.round, 'status', mavi_private.notice_status(n),
  'created_by', n.created_by, 'author_name', mavi_private.member_name(n.company_id, n.created_by),
  'created_at', n.created_at, 'updated_at', n.updated_at, 'version', n.version, 'can_edit', v_edit,
  'last_reminded_at', case when v_edit then n.last_reminded_at end,
  'animation_id', n.animation_id,
  'animation', (select x.spec from public.notice_animations x where x.id = n.animation_id and x.status = 'ready'),
  'receipt', case when r.notice_id is null or r.round <> n.round then null else jsonb_build_object(
   'delivered_at', r.delivered_at, 'seen_at', r.seen_at, 'acked_at', r.acked_at,
   'snoozed_until', r.snoozed_until, 'banner_closed_at', r.banner_closed_at) end,
  'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name,
    'content_type', a.content_type, 'size_bytes', a.size_bytes, 'source', a.source) order by a.position, a.created_at)
   from public.notice_attachments a where a.notice_id = n.id and a.status = 'ready'), '[]'),
  'targets', case when v_edit then coalesce((select jsonb_agg(jsonb_build_object('kind', t.kind, 'id', t.target_id,
    'mode', t.mode)) from public.notice_targets t where t.notice_id = n.id and t.kind <> 'exclude'), '[]') end,
  'exclude', case when v_edit then coalesce((select jsonb_agg(t.target_id) from public.notice_targets t
    where t.notice_id = n.id and t.kind = 'exclude'), '[]') end);
end $$;

revoke all on function mavi_private.notice_animation_choices(uuid) from public, anon, authenticated;
revoke all on function public.notice_animation_options(uuid), public.notice_animation_admin(uuid),
 public.set_notice_animation_admin(uuid, boolean, jsonb),
 public.start_notice_animation(uuid, text, uuid, text, uuid[], boolean, uuid),
 public.finish_notice_animation(uuid, jsonb, text, numeric), public.save_notice_animation(uuid, jsonb, uuid),
 public.use_notice_animation(uuid, uuid), public.notice_animations(uuid), public.my_live_notices(uuid),
 public.notice_detail(uuid) from public, anon;
grant execute on function public.notice_animation_options(uuid), public.notice_animation_admin(uuid),
 public.set_notice_animation_admin(uuid, boolean, jsonb),
 public.start_notice_animation(uuid, text, uuid, text, uuid[], boolean, uuid),
 public.finish_notice_animation(uuid, jsonb, text, numeric), public.save_notice_animation(uuid, jsonb, uuid),
 public.use_notice_animation(uuid, uuid), public.notice_animations(uuid), public.my_live_notices(uuid),
 public.notice_detail(uuid) to authenticated;

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual IA cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project', 'feature') then
  raise exception 'Tipo inválido.' using errcode = '22023';
 end if;
 if p_type not in ('company', 'feature') and p_id is null then
  raise exception 'Escolha para quem vale a regra.' using errcode = '22023';
 end if;
 if p_type = 'feature' and coalesce(v_feature, '') not in ('assistant', 'meetings_history', 'meetings_ask',
  'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation') then
  raise exception 'Funcionalidade inválida.' using errcode = '22023';
 end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from v_id and feature is not distinct from v_feature;
  return;
 end if;
 if not exists (select 1 from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model)) then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, feature, provider_id, model)
 values (p_company, p_type, v_id, v_feature, p_provider, p_model)
 on conflict on constraint ai_routes_scope_key do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

commit;
