begin;

-- Onboarding › Social Leads: o produto de entrada da agência (gestão de
-- Instagram/Facebook + tráfego no Meta), trazido do artefato "Briefing Social
-- Leads" (build B29) para o MAVI.
--
-- - A carteira são os produtos contratados do produto escolhido como Social
--   Leads (social_leads_settings); o squad é uma equipe.
-- - Cada produto contratado tem um briefing e um plano por mês; cada plano tem
--   exatamente 8 posts (um vira anúncio). O conteúdo do plano segue o mesmo
--   contrato do artefato e do importador (diagnostico, swot, pilares, publico,
--   campanha, alertas, posts), para a skill social-leads continuar valendo.
-- - Nenhuma escrita destrutiva sem cópia: regenerar, importar, editar e
--   restaurar arquivam o plano vigente em social_leads_revisions.
-- - O cliente aprova pelo link (share_token), sem entrar no app: a decisão
--   fica registrada com a origem ("link" ou "equipe").
-- - Quem vê: quem vê o produto contratado (a mesma regra de Clientes e
--   Projetos). Quem grava: quem atende o cliente (equipe do cliente) e os
--   líderes que o veem.
-- - Mudanças são avisadas no tópico da empresa (kind "social_leads"), sem
--   consultas periódicas.

-- ------------------------------------------------------------ módulo no menu
alter table public.memberships drop constraint if exists memberships_hidden_pages_check;
alter table public.memberships add constraint memberships_hidden_pages_check
 check (hidden_pages <@ array['overview','tasks','agenda','clients','products','projects','campaigns','hours',
  'reports','drive','storage','dashboards','onboarding']::text[]);

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
  'reports','drive','storage','dashboards','onboarding']::text[] then
  raise exception 'Módulo inválido' using errcode = '22023';
 end if;
 update public.memberships set hidden_pages = v where company_id = p_company and user_id = p_user
  and hidden_pages is distinct from v;
end $$;

-- ------------------------------------------------------------ tabelas
create table public.social_leads_settings (
 company_id uuid primary key references public.companies(id),
 product_id uuid not null,
 -- O squad: os responsáveis são escolhidos entre os membros desta equipe.
 team_id uuid,
 updated_by uuid,
 updated_at timestamptz not null default now(),
 foreign key (company_id, product_id) references public.products(company_id, id),
 foreign key (company_id, team_id) references public.teams(company_id, id)
);

create table public.social_leads_briefings (
 company_id uuid not null,
 contract_id uuid not null,
 -- Os campos de texto do briefing do artefato (FIELD_IDS, sem accountManager).
 fields jsonb not null default '{}' check (jsonb_typeof(fields) = 'object'),
 campaign_objective text check (campaign_objective in ('form_nativo', 'ctwa')),
 responsible_id uuid,
 version integer not null default 1,
 created_by uuid not null default auth.uid(),
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (company_id, contract_id),
 foreign key (company_id, contract_id) references public.contracts(company_id, id),
 foreign key (company_id, responsible_id) references public.memberships(company_id, user_id)
);

create table public.social_leads_plans (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 contract_id uuid not null,
 month_number integer not null check (month_number between 1 and 240),
 label text not null check (length(trim(label)) between 1 and 60),
 -- {diagnostico, swot, pilares, publico, campanha, alertas}; os posts ficam em social_leads_posts.
 content jsonb not null check (jsonb_typeof(content) = 'object'),
 -- Resumo da última alteração (importação, edição, restauração).
 summary text not null default '',
 source text not null default 'ai' check (source in ('ai', 'import', 'manual', 'artifact')),
 share_token text not null unique default (replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','')),
 share_enabled boolean not null default false,
 shared_at timestamptz,
 version integer not null default 1,
 created_by uuid,
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 unique (company_id, contract_id, month_number),
 foreign key (company_id, contract_id) references public.contracts(company_id, id)
);
create index social_leads_plans_contract on public.social_leads_plans(company_id, contract_id, month_number desc);

create table public.social_leads_posts (
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid not null,
 number integer not null check (number between 1 and 8),
 pillar text not null check (pillar in ('posicionar', 'autoridade', 'oferta')),
 hook text not null check (length(trim(hook)) > 0),
 copy_direction text not null check (length(trim(copy_direction)) > 0),
 visual_direction text not null check (length(trim(visual_direction)) > 0),
 format text not null check (length(trim(format)) > 0),
 cta text not null check (length(trim(cta)) > 0),
 is_ad boolean not null default false,
 decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
 note text not null default '' check (length(note) <= 2000),
 decided_via text check (decided_via in ('link', 'team')),
 decided_by uuid,
 decided_at timestamptz,
 updated_at timestamptz not null default now(),
 primary key (plan_id, number),
 foreign key (company_id, plan_id) references public.social_leads_plans(company_id, id) on delete cascade,
 check ((decision = 'pending') = (decided_at is null))
);
-- Exatamente um anúncio por plano (o "pelo menos um" é conferido na gravação).
create unique index social_leads_posts_one_ad on public.social_leads_posts(plan_id) where is_ad;
create index social_leads_posts_contract on public.social_leads_posts(company_id, contract_id);

create table public.social_leads_revisions (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid not null,
 number integer not null,
 reason text not null,
 -- O plano inteiro, no formato do artefato (com posts, status e observações).
 content jsonb not null,
 created_by uuid,
 created_at timestamptz not null default now(),
 unique (plan_id, number),
 foreign key (company_id, plan_id) references public.social_leads_plans(company_id, id) on delete cascade
);

-- Gerações pela IA em andamento (uma por produto contratado) e a última falha.
create table public.social_leads_jobs (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 contract_id uuid not null,
 plan_id uuid,
 kind text not null check (kind in ('new', 'current')),
 status text not null default 'running' check (status in ('running', 'done', 'failed')),
 error text,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 finished_at timestamptz,
 foreign key (company_id, contract_id) references public.contracts(company_id, id)
);
create unique index social_leads_jobs_running on public.social_leads_jobs(contract_id) where status = 'running';
create index social_leads_jobs_contract on public.social_leads_jobs(company_id, contract_id, created_at desc);

-- ------------------------------------------------------------ acesso
-- Grava quem atende o cliente (equipe do cliente, ou administrador) e os
-- líderes que veem o produto contratado.
create function mavi_private.social_leads_can_write(c uuid, k uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.contract_access(c, k)
  or (mavi_private.leader(c) and mavi_private.contract_read(c, k))
$$;
revoke all on function mavi_private.social_leads_can_write(uuid, uuid) from public, anon;
grant execute on function mavi_private.social_leads_can_write(uuid, uuid) to authenticated;

alter table public.social_leads_settings enable row level security;
alter table public.social_leads_briefings enable row level security;
alter table public.social_leads_plans enable row level security;
alter table public.social_leads_posts enable row level security;
alter table public.social_leads_revisions enable row level security;
alter table public.social_leads_jobs enable row level security;
revoke all on public.social_leads_settings, public.social_leads_briefings, public.social_leads_plans,
 public.social_leads_posts, public.social_leads_revisions, public.social_leads_jobs from anon, authenticated;
grant select on public.social_leads_settings, public.social_leads_briefings, public.social_leads_posts,
 public.social_leads_revisions, public.social_leads_jobs to authenticated;
-- O token do link só sai por social_leads_share (para quem pode gravar).
grant select (id, company_id, contract_id, month_number, label, content, summary, source, share_enabled,
 shared_at, version, created_by, updated_by, created_at, updated_at) on public.social_leads_plans to authenticated;

create policy social_leads_settings_read on public.social_leads_settings for select to authenticated
 using (company_id in (select mavi_private.active_companies()));
create policy social_leads_briefings_read on public.social_leads_briefings for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));
create policy social_leads_plans_read on public.social_leads_plans for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));
create policy social_leads_posts_read on public.social_leads_posts for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));
create policy social_leads_revisions_read on public.social_leads_revisions for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));
create policy social_leads_jobs_read on public.social_leads_jobs for select to authenticated
 using (company_id in (select mavi_private.active_companies()) and mavi_private.contract_read(company_id, contract_id));

-- ------------------------------------------------------------ avisos ao vivo
create function mavi_private.broadcast_social_leads() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 r := coalesce(new, old);
 perform mavi_private.broadcast(r.company_id, jsonb_build_object(
  'kind', 'social_leads', 'contract', r.contract_id, 'table', tg_table_name));
 return null;
end $$;
revoke all on function mavi_private.broadcast_social_leads() from public, anon, authenticated;
create trigger broadcast_social_leads after insert or update or delete on public.social_leads_briefings
 for each row execute function mavi_private.broadcast_social_leads();
create trigger broadcast_social_leads after insert or update or delete on public.social_leads_plans
 for each row execute function mavi_private.broadcast_social_leads();
create trigger broadcast_social_leads after insert or update or delete on public.social_leads_jobs
 for each row execute function mavi_private.broadcast_social_leads();
-- Posts: um aviso por instrução (uma gravação troca os 8 de uma vez).
create function mavi_private.broadcast_social_leads_posts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record; begin
 for r in select distinct company_id, contract_id from changed loop
  perform mavi_private.broadcast(r.company_id, jsonb_build_object(
   'kind', 'social_leads', 'contract', r.contract_id, 'table', 'social_leads_posts'));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.broadcast_social_leads_posts() from public, anon, authenticated;
create trigger broadcast_social_leads_posts_ins after insert on public.social_leads_posts
 referencing new table as changed for each statement execute function mavi_private.broadcast_social_leads_posts();
create trigger broadcast_social_leads_posts_upd after update on public.social_leads_posts
 referencing new table as changed for each statement execute function mavi_private.broadcast_social_leads_posts();
create trigger broadcast_social_leads_posts_del after delete on public.social_leads_posts
 referencing old table as changed for each statement execute function mavi_private.broadcast_social_leads_posts();

-- ------------------------------------------------------------ validação
-- Texto obrigatório de um objeto (mensagem em português para a tela).
create function mavi_private.sl_text(o jsonb, k text, what text, max_len integer default 4000) returns text
language plpgsql immutable set search_path = '' as $$
declare v text; begin
 if o is null or jsonb_typeof(o->k) is distinct from 'string' or length(trim(o->>k)) = 0 then
  raise exception '% está vazio.', what using errcode = '22023';
 end if;
 v := trim(o->>k);
 if length(v) > max_len then raise exception '% passou de % caracteres.', what, max_len using errcode = '22023'; end if;
 return v;
end $$;
-- Texto opcional.
create function mavi_private.sl_opt(o jsonb, k text, max_len integer default 4000) returns text
language plpgsql immutable set search_path = '' as $$
begin
 if o is null or o->k is null or jsonb_typeof(o->k) = 'null' then return ''; end if;
 if jsonb_typeof(o->k) <> 'string' then raise exception 'Campo % inválido.', k using errcode = '22023'; end if;
 if length(o->>k) > max_len then raise exception 'Campo % passou de % caracteres.', k, max_len using errcode = '22023'; end if;
 return trim(o->>k);
end $$;

-- O plano no contrato do artefato, conferido e normalizado: exatamente 4
-- pilares, 8 posts numerados de 1 a 8, um só anúncio, pilar de post válido.
-- Devolve {content: {...sem posts}, posts: [...]} com os posts ordenados.
create function mavi_private.social_leads_normalize(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
 d jsonb; s jsonb; c jsonb; x jsonb; posts jsonb := '[]'; pilares jsonb := '[]'; alertas jsonb := '[]';
 perguntas jsonb := '[]'; n integer; seen integer[] := '{}'; ads integer := 0; badge text;
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
 if jsonb_typeof(p->'posts') is distinct from 'array' or jsonb_array_length(p->'posts') <> 8 then
  raise exception 'O plano precisa de exatamente 8 posts.' using errcode = '22023';
 end if;
 for x in select value from jsonb_array_elements(p->'posts') loop
  if jsonb_typeof(x) <> 'object' or jsonb_typeof(x->'numero') <> 'number' then
   raise exception 'Post sem número.' using errcode = '22023';
  end if;
  n := (x->>'numero')::numeric::integer;
  if n not between 1 and 8 or (x->>'numero')::numeric <> n then raise exception 'Número de post fora de 1 a 8: %.', x->>'numero' using errcode = '22023'; end if;
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
revoke all on function mavi_private.sl_text(jsonb, text, text, integer), mavi_private.sl_opt(jsonb, text, integer),
 mavi_private.social_leads_normalize(jsonb) from public, anon;

-- O plano vigente no formato do artefato (para versões e para a IA).
create function mavi_private.social_leads_full(p_plan uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select p.content || jsonb_build_object('label', p.label, 'createdAt', p.created_at, 'posts', coalesce((
  select jsonb_agg(jsonb_build_object('numero', x.number, 'badge', x.pillar, 'gancho', x.hook,
   'direcaoCopy', x.copy_direction, 'direcaoVisual', x.visual_direction, 'formato', x.format, 'cta', x.cta,
   'ehAnuncio', x.is_ad,
   'status', case x.decision when 'approved' then 'aprovado' when 'rejected' then 'reprovado' else 'pendente' end,
   'observacao', x.note) order by x.number)
  from public.social_leads_posts x where x.plan_id = p.id), '[]'))
 from public.social_leads_plans p where p.id = p_plan
$$;
revoke all on function mavi_private.social_leads_full(uuid) from public, anon, authenticated;

create function mavi_private.social_leads_snapshot(p_plan uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; begin
 select * into p from public.social_leads_plans where id = p_plan;
 insert into public.social_leads_revisions(company_id, contract_id, plan_id, number, reason, content, created_by)
 values (p.company_id, p.contract_id, p.id,
  coalesce((select max(number) from public.social_leads_revisions where plan_id = p.id), 0) + 1,
  p_reason, mavi_private.social_leads_full(p.id), auth.uid());
end $$;
revoke all on function mavi_private.social_leads_snapshot(uuid, text) from public, anon, authenticated;

-- Grava os posts normalizados. p_mode:
--  'reset'   todos voltam a pendente (regeneração);
--  'changed' só volta a pendente o post cujo conteúdo mudou (a aprovação valia para o texto anterior);
--  'keep'    usa o status/observação do próprio conteúdo (importação do artefato, restauração).
create function mavi_private.social_leads_put_posts(p_plan uuid, p_posts jsonb, p_mode text) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; x jsonb; o public.social_leads_posts; dec text; same boolean; begin
 select * into p from public.social_leads_plans where id = p_plan;
 -- Tira o anúncio de todos antes, para o índice de um anúncio por plano.
 update public.social_leads_posts set is_ad = false where plan_id = p.id and is_ad;
 for x in select value from jsonb_array_elements(p_posts) loop
  select * into o from public.social_leads_posts where plan_id = p.id and number = (x->>'numero')::integer;
  same := found and o.pillar = x->>'badge' and o.hook = x->>'gancho' and o.copy_direction = x->>'direcaoCopy'
   and o.visual_direction = x->>'direcaoVisual' and o.format = x->>'formato' and o.cta = x->>'cta'
   and o.is_ad is not distinct from ((x->>'ehAnuncio')::boolean);
  dec := case
   when p_mode = 'keep' then case x->>'status' when 'aprovado' then 'approved' when 'reprovado' then 'rejected' else 'pending' end
   when p_mode = 'changed' and same then o.decision
   else 'pending' end;
  insert into public.social_leads_posts as t(company_id, contract_id, plan_id, number, pillar, hook, copy_direction,
   visual_direction, format, cta, is_ad, decision, note, decided_via, decided_by, decided_at, updated_at)
  values (p.company_id, p.contract_id, p.id, (x->>'numero')::integer, x->>'badge', x->>'gancho', x->>'direcaoCopy',
   x->>'direcaoVisual', x->>'formato', x->>'cta', (x->>'ehAnuncio')::boolean, dec,
   case when p_mode = 'keep' then coalesce(x->>'observacao', '') when p_mode = 'changed' and same then o.note else '' end,
   case when dec = 'pending' then null when p_mode = 'changed' and same then o.decided_via else 'team' end,
   case when dec = 'pending' then null when p_mode = 'changed' and same then o.decided_by else auth.uid() end,
   case when dec = 'pending' then null when p_mode = 'changed' and same then o.decided_at else now() end,
   now())
  on conflict (plan_id, number) do update set pillar = excluded.pillar, hook = excluded.hook,
   copy_direction = excluded.copy_direction, visual_direction = excluded.visual_direction, format = excluded.format,
   cta = excluded.cta, is_ad = excluded.is_ad, decision = excluded.decision, note = excluded.note,
   decided_via = excluded.decided_via, decided_by = excluded.decided_by, decided_at = excluded.decided_at,
   updated_at = case when t.decision is distinct from excluded.decision or not same then now() else t.updated_at end;
 end loop;
end $$;
revoke all on function mavi_private.social_leads_put_posts(uuid, jsonb, text) from public, anon, authenticated;

-- ------------------------------------------------------------ funções da tela
-- Qual produto é o Social Leads e qual equipe é o squad (líderes).
create function public.set_social_leads_settings(p_company uuid, p_product uuid, p_team uuid) returns void
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
 insert into public.social_leads_settings(company_id, product_id, team_id, updated_by, updated_at)
 values (p_company, p_product, p_team, auth.uid(), now())
 on conflict (company_id) do update set product_id = excluded.product_id, team_id = excluded.team_id,
  updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;

-- A carteira: os produtos contratados do Social Leads que a pessoa vê, com o
-- briefing, o último plano (e as decisões) e a geração em andamento.
create function public.social_leads_portfolio(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.social_leads_settings; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso.' using errcode = '42501'; end if;
 select * into s from public.social_leads_settings where company_id = p_company;
 if not found then return jsonb_build_object('configured', false, 'items', '[]'::jsonb); end if;
 return jsonb_build_object('configured', true, 'product_id', s.product_id, 'team_id', s.team_id, 'items', coalesce((
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
     'last_decision_at', (select max(x.decided_at) from public.social_leads_posts x where x.plan_id = p.id))
    from public.social_leads_plans p where p.company_id = k.company_id and p.contract_id = k.id
    order by p.month_number desc limit 1),
   'job', (select jsonb_build_object('id', j.id, 'kind', j.kind, 'status', j.status, 'error', j.error,
     'created_at', j.created_at, 'finished_at', j.finished_at)
    from public.social_leads_jobs j where j.company_id = k.company_id and j.contract_id = k.id
    order by j.created_at desc limit 1)
  ) order by cl.name, k.name)
  from public.contracts k
  join public.clients cl on cl.company_id = k.company_id and cl.id = k.client_id
  where k.company_id = p_company and k.product_id = s.product_id and not k.archived and not cl.archived
   and mavi_private.contract_read(k.company_id, k.id)
 ), '[]'::jsonb));
end $$;

-- Salva o briefing (rascunho a cada alteração). p_version: a versão lida
-- (null para o primeiro); outra pessoa ter salvo antes devolve um conflito.
create function public.save_social_leads_briefing(p_company uuid, p_contract uuid, p_fields jsonb,
 p_objective text, p_responsible uuid, p_version integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare b public.social_leads_briefings; k text; v integer; clean jsonb := '{}'; begin
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
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract for update;
 if not found then
  if p_version is not null then raise exception 'O briefing foi removido. Recarregue a página.' using errcode = '40001'; end if;
  insert into public.social_leads_briefings(company_id, contract_id, fields, campaign_objective, responsible_id, updated_by)
  values (p_company, p_contract, clean, p_objective, p_responsible, auth.uid());
  return 1;
 end if;
 if p_version is distinct from b.version then
  raise exception 'Outra pessoa salvou este briefing antes. Recarregue para ver a versão atual.' using errcode = '40001';
 end if;
 update public.social_leads_briefings set fields = clean, campaign_objective = p_objective,
  responsible_id = p_responsible, version = version + 1, updated_by = auth.uid(), updated_at = now()
 where company_id = p_company and contract_id = p_contract returning version into v;
 return v;
end $$;

-- Grava um plano inteiro (IA, importação ou edição).
--  p_plan null: cria o próximo mês.
--  p_reason: 'regeneração do mês' (todos voltam a pendente; bloqueado com o
--  plano todo aprovado), ou outro motivo (só os posts alterados voltam).
-- Arquiva o vigente antes. Devolve {id, version}.
create function public.social_leads_write_plan(p_company uuid, p_contract uuid, p_plan uuid, p_content jsonb,
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
 if p_reason = 'regeneração do mês' and (select count(*) from public.social_leads_posts
  where plan_id = p.id and decision = 'approved') = 8 then
  raise exception 'Plano aprovado: os 8 posts foram aprovados. Para mudar um post, use "alterar" nele ou a atualização pelo chat.'
   using errcode = '55000';
 end if;
 perform mavi_private.social_leads_snapshot(p.id, coalesce(nullif(trim(p_reason), ''), 'edição'));
 update public.social_leads_plans set content = norm->'content', source = p_source,
  summary = coalesce(p_summary, summary), version = version + 1, updated_by = auth.uid(), updated_at = now()
 where id = p.id returning * into p;
 perform mavi_private.social_leads_put_posts(p.id, norm->'posts',
  case when p_reason = 'regeneração do mês' then 'reset' else 'changed' end);
 return jsonb_build_object('id', p.id, 'version', p.version);
end $$;

-- Volta uma versão anterior (arquiva a atual antes), com as decisões dela.
create function public.social_leads_restore(p_revision uuid, p_version integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.social_leads_revisions; p public.social_leads_plans; norm jsonb; begin
 select * into r from public.social_leads_revisions where id = p_revision;
 if not found or not mavi_private.social_leads_can_write(r.company_id, r.contract_id) then
  raise exception 'Versão não encontrada.' using errcode = 'P0002';
 end if;
 select * into p from public.social_leads_plans where id = r.plan_id for update;
 if p_version is not null and p_version <> p.version then
  raise exception 'O plano mudou desde que você o abriu. Recarregue para ver a versão atual.' using errcode = '40001';
 end if;
 norm := mavi_private.social_leads_normalize(r.content);
 perform mavi_private.social_leads_snapshot(p.id, format('antes de restaurar a versão %s', r.number));
 update public.social_leads_plans set content = norm->'content', version = version + 1, updated_by = auth.uid(),
  updated_at = now(), summary = format('Versão %s restaurada', r.number)
 where id = p.id returning * into p;
 perform mavi_private.social_leads_put_posts(p.id, norm->'posts', 'keep');
 return jsonb_build_object('id', p.id, 'version', p.version);
end $$;

-- A equipe registra a decisão do cliente (reunião, WhatsApp) ou a reabre.
create function public.social_leads_decide(p_plan uuid, p_number integer, p_decision text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; begin
 select * into p from public.social_leads_plans where id = p_plan;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 if p_decision not in ('pending', 'approved', 'rejected') then raise exception 'Decisão inválida.' using errcode = '22023'; end if;
 if length(coalesce(p_note, '')) > 2000 then raise exception 'A observação passou de 2.000 caracteres.' using errcode = '22023'; end if;
 update public.social_leads_posts set decision = p_decision, note = coalesce(trim(p_note), ''),
  decided_via = case when p_decision = 'pending' then null else 'team' end,
  decided_by = case when p_decision = 'pending' then null else auth.uid() end,
  decided_at = case when p_decision = 'pending' then null else now() end, updated_at = now()
 where plan_id = p.id and number = p_number;
 if not found then raise exception 'Post não encontrado.' using errcode = 'P0002'; end if;
end $$;

-- Liga, desliga ou troca o link de aprovação. Devolve o token (para montar o endereço).
create function public.social_leads_share(p_plan uuid, p_enabled boolean, p_new_link boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; begin
 select * into p from public.social_leads_plans where id = p_plan for update;
 if not found or not mavi_private.social_leads_can_write(p.company_id, p.contract_id) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 update public.social_leads_plans set share_enabled = coalesce(p_enabled, share_enabled),
  shared_at = case when p_enabled and not share_enabled then now() else shared_at end,
  share_token = case when p_new_link
   then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') else share_token end
 where id = p.id returning * into p;
 return jsonb_build_object('share_enabled', p.share_enabled, 'share_token', p.share_token, 'shared_at', p.shared_at);
end $$;

-- ------------------------------------------------------------ geração pela IA
-- Abre uma geração (uma por produto contratado; uma parada há mais de 15
-- minutos é dada como falha) e devolve o que a IA precisa: briefing, nome do
-- cliente, o plano atual (regeneração) ou o anterior (próximo mês).
create function public.social_leads_start_job(p_company uuid, p_contract uuid, p_plan uuid, p_kind text) returns jsonb
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
 return jsonb_build_object('job', j.id, 'client_name', cl.name, 'briefing', b.fields,
  'campaign_objective', b.campaign_objective,
  'responsible', (select name from public.memberships where company_id = p_company and user_id = b.responsible_id),
  'next_month', coalesce((select max(month_number) from public.social_leads_plans where contract_id = p_contract), 0) + 1,
  'previous', case when prev is null then null else mavi_private.social_leads_full(prev) end);
end $$;

create function public.social_leads_finish_job(p_job uuid, p_plan uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.social_leads_jobs; begin
 select * into j from public.social_leads_jobs where id = p_job for update;
 if not found or j.created_by <> auth.uid() then raise exception 'Geração não encontrada.' using errcode = 'P0002'; end if;
 if j.status <> 'running' then return; end if;
 update public.social_leads_jobs set status = case when p_error is null then 'done' else 'failed' end,
  error = left(p_error, 1000), plan_id = coalesce(p_plan, plan_id), finished_at = now()
 where id = p_job;
end $$;

-- O que a IA precisa para ajustar um plano a pedido da equipe.
create function public.social_leads_adjust_context(p_company uuid, p_contract uuid, p_plan uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare b public.social_leads_briefings; begin
 if not mavi_private.social_leads_can_write(p_company, p_contract) then
  raise exception 'Sem permissão para editar o plano deste cliente.' using errcode = '42501';
 end if;
 if not exists (select 1 from public.social_leads_plans where id = p_plan and company_id = p_company and contract_id = p_contract) then
  raise exception 'Plano não encontrado.' using errcode = 'P0002';
 end if;
 select * into b from public.social_leads_briefings where company_id = p_company and contract_id = p_contract;
 return jsonb_build_object(
  'client_name', (select c.name from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
   where k.company_id = p_company and k.id = p_contract),
  'briefing', coalesce(b.fields, '{}'), 'campaign_objective', b.campaign_objective,
  'plan', mavi_private.social_leads_full(p_plan));
end $$;

-- ------------------------------------------------------------ link do cliente
-- O que o cliente vê: o que o PDF de apresentação mostrava. Ficam de fora os
-- alertas, o orçamento, os posicionamentos, as perguntas do formulário, o
-- roteamento do lead, o SWOT e a segmentação.
create function public.social_leads_shared_plan(p_token text) returns jsonb
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
    'decided_via', x.decided_via) order by x.number)
   from public.social_leads_posts x where x.plan_id = p.id), '[]'));
end $$;

-- A decisão do cliente pelo link. Pedir ajuste exige dizer o quê.
create function public.social_leads_client_decide(p_token text, p_number integer, p_decision text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare p public.social_leads_plans; begin
 select * into p from public.social_leads_plans where share_token = p_token and share_enabled for update;
 if not found then raise exception 'Link inválido ou desativado.' using errcode = 'P0002'; end if;
 if p_decision not in ('approved', 'rejected') then raise exception 'Decisão inválida.' using errcode = '22023'; end if;
 if p_decision = 'rejected' and length(trim(coalesce(p_note, ''))) = 0 then
  raise exception 'Conte o que você quer ajustar neste post.' using errcode = '22023';
 end if;
 if length(coalesce(p_note, '')) > 2000 then raise exception 'O comentário passou de 2.000 caracteres.' using errcode = '22023'; end if;
 update public.social_leads_posts set decision = p_decision, note = trim(coalesce(p_note, '')), decided_via = 'link',
  decided_by = null, decided_at = now(), updated_at = now()
 where plan_id = p.id and number = p_number;
 if not found then raise exception 'Post não encontrado.' using errcode = 'P0002'; end if;
end $$;

-- ------------------------------------------------------------ importação do artefato
-- Usada só pelo script de importação (scripts/import-social-leads-artifact.mjs),
-- rodado no SQL Editor: grava o briefing e o plano como estavam, com as
-- decisões. Idempotente por produto contratado e mês.
create function mavi_private.social_leads_import(p_company uuid, p_contract uuid, p_author uuid, p_fields jsonb,
 p_objective text, p_responsible uuid, p_plan jsonb, p_created_at timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare norm jsonb; p public.social_leads_plans; n integer; begin
 insert into public.social_leads_briefings(company_id, contract_id, fields, campaign_objective, responsible_id, created_by, updated_by)
 values (p_company, p_contract, p_fields, p_objective, p_responsible, p_author, p_author)
 on conflict (company_id, contract_id) do nothing;
 if p_plan is null then return null; end if;
 norm := mavi_private.social_leads_normalize(p_plan);
 n := coalesce(nullif(regexp_replace(coalesce(p_plan->>'label', ''), '\D', '', 'g'), '')::integer, 1);
 select * into p from public.social_leads_plans where contract_id = p_contract and month_number = n;
 if found then return p.id; end if;
 insert into public.social_leads_plans(company_id, contract_id, month_number, label, content, summary, source,
  created_by, updated_by, created_at, updated_at)
 values (p_company, p_contract, n, 'Mês ' || n, norm->'content', 'Importado do artefato Social Leads', 'artifact',
  p_author, p_author, coalesce(p_created_at, now()), now())
 returning * into p;
 perform set_config('request.jwt.claim.sub', p_author::text, true);
 perform mavi_private.social_leads_put_posts(p.id, norm->'posts', 'keep');
 return p.id;
end $$;
revoke all on function mavi_private.social_leads_import(uuid, uuid, uuid, jsonb, text, uuid, jsonb, timestamptz)
 from public, anon, authenticated;

-- ------------------------------------------------------------ permissões de execução
revoke all on function public.set_social_leads_settings(uuid, uuid, uuid), public.social_leads_portfolio(uuid),
 public.save_social_leads_briefing(uuid, uuid, jsonb, text, uuid, integer),
 public.social_leads_write_plan(uuid, uuid, uuid, jsonb, text, integer, text, text),
 public.social_leads_restore(uuid, integer), public.social_leads_decide(uuid, integer, text, text),
 public.social_leads_share(uuid, boolean, boolean), public.social_leads_start_job(uuid, uuid, uuid, text),
 public.social_leads_finish_job(uuid, uuid, text), public.social_leads_adjust_context(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_social_leads_settings(uuid, uuid, uuid), public.social_leads_portfolio(uuid),
 public.save_social_leads_briefing(uuid, uuid, jsonb, text, uuid, integer),
 public.social_leads_write_plan(uuid, uuid, uuid, jsonb, text, integer, text, text),
 public.social_leads_restore(uuid, integer), public.social_leads_decide(uuid, integer, text, text),
 public.social_leads_share(uuid, boolean, boolean), public.social_leads_start_job(uuid, uuid, uuid, text),
 public.social_leads_finish_job(uuid, uuid, text), public.social_leads_adjust_context(uuid, uuid, uuid) to authenticated;
revoke all on function public.social_leads_shared_plan(text), public.social_leads_client_decide(text, integer, text, text) from public;
grant execute on function public.social_leads_shared_plan(text), public.social_leads_client_decide(text, integer, text, text)
 to anon, authenticated;

commit;
