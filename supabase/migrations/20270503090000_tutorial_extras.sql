begin;

-- Tutoriais, Fase 4: avaliação, métricas, a MAVI escreve e o aviso de
-- tutorial novo (pedido de 05/10/2026).
--
-- - "Isso ajudou?": no fim do tutorial, um voto por pessoa (pode trocar ou
--   tirar); no 👎, um motivo pronto e um comentário opcional. O voto guarda a
--   versão em que foi dado. Quem edita o tutorial (e os administradores) vê
--   os votos e os motivos.
-- - Métricas (administradores e gestores, aba Métricas): cada abertura de
--   tutorial (tutorial_views, com a origem: biblioteca, busca, trilha, "?",
--   MAVI, aviso ou link; a mesma pessoa no mesmo tutorial conta uma vez a cada
--   30 minutos) e cada busca da página (tutorial_searches, com quantos
--   resultados vieram). Por tutorial: visualizações, pessoas, vindas da busca,
--   conclusões e votos; e o que o time busca, com as buscas sem resultado.
-- - A MAVI escreve o tutorial (funcionalidade 'tutorial_writer' em Quem usa
--   qual modelo): de uma ideia, da transcrição de um vídeo ou melhorando o
--   texto aberto. Quem escreve confere e aplica no editor.
-- - Aviso de tutorial novo ou atualizado: quem publica escolhe não avisar,
--   avisar na caixa de entrada ('tutorial') ou criar um aviso no Mural (pelo
--   save_notice, com as regras do Mural). Vai para o público do tutorial.

-- ------------------------------------------------------------ avisos na caixa de entrada
-- As listas que já estão no banco (em qualquer ordem de migração), com o
-- aviso de tutorial. Fora das preferências: quem publica decide se avisa.
do $$ declare v text[]; w text[]; begin
 select coalesce(array_agg(distinct m[1]), '{}') into v from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_kind_check' and k.conrelid = 'public.notifications'::regclass;
 select coalesce(array_agg(distinct m[1]), '{}') into w from pg_constraint k,
  regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
 where k.conname = 'notifications_target_check' and k.conrelid = 'public.notifications'::regclass;
 v := array(select distinct x from unnest(v || array['tutorial']) x order by x);
 w := array(select distinct x from unnest(w || array['tutorial', 'notice']) x order by x);
 alter table public.notifications drop constraint notifications_kind_check;
 execute format('alter table public.notifications add constraint notifications_kind_check check (kind in (%s))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
 alter table public.notifications drop constraint notifications_target_check;
 execute format('alter table public.notifications add constraint notifications_target_check check ('
  '((kind in (%s)) = (task_id is null)) '
  'and (task_id is not null or (title is not null and link is not null)) '
  'and ((kind = ''notice'') = (notice_id is not null)))', (select string_agg(quote_literal(x), ',') from unnest(w) x));
end $$;

-- ------------------------------------------------------------ funcionalidade da MAVI
-- As funcionalidades que a regra aceita, lidas da própria constraint: quem
-- acrescentar uma nova só precisa mudar a constraint.
create function mavi_private.ai_route_features() returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct m[1]), '{}') from pg_constraint k,
  regexp_matches(substring(pg_get_constraintdef(k.oid) from 'IS NULL\)? OR (.*)$'), '''([a-z_]+)''', 'g') m
 where k.conname = 'ai_routes_feature_check' and k.conrelid = 'mavi_private.ai_routes'::regclass
$$;
revoke all on function mavi_private.ai_route_features() from public, anon, authenticated;

do $$ declare v text[]; begin
 v := array(select distinct x from unnest(mavi_private.ai_route_features() || array['tutorial_writer']) x order by x);
 alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
 execute format('alter table mavi_private.ai_routes add constraint ai_routes_feature_check check ('
  '(scope_type = ''feature'') = (feature is not null) and (feature is null or feature in (%s)))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
end $$;

-- A da migração 20270420090000, conferindo a funcionalidade pela constraint.
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
 if p_type = 'feature' and not (coalesce(v_feature, '') = any(mavi_private.ai_route_features())) then
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
 -- Deepgram e AssemblyAI só transcrevem, e pelo link do arquivo: por enquanto, os vídeos dos tutoriais.
 if v_kind in ('deepgram', 'assemblyai') and coalesce(v_feature, '') <> 'tutorial_transcribe' then
  raise exception 'Este provedor só transcreve os vídeos dos tutoriais (Tutoriais: transcrição dos vídeos).'
   using errcode = '22023';
 end if;
 -- Transcrição: o endpoint de transcrição da OpenAI e um modelo que transcreve.
 if mavi_private.ai_transcribe_feature(v_feature) then
  if v_kind not in ('openai', 'groq', 'mistral', 'custom', 'deepgram', 'assemblyai') then
   raise exception 'A transcrição usa a OpenAI, o Groq, a Mistral ou um endereço compatível (nos tutoriais, também Deepgram e AssemblyAI).'
    using errcode = '22023';
  end if;
  if v_kind not in ('deepgram', 'assemblyai') and not mavi_private.ai_transcribe_model(p_model) then
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
 -- O termômetro e as conferências leem com o Jev pelo OpenRouter; o Jev não conversa.
 if mavi_private.ai_decision_feature(v_feature) and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'Esta funcionalidade usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.'
   using errcode = '22023';
 end if;
 if not mavi_private.ai_decision_feature(v_feature) and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, nas conferências (Radar, insights das campanhas) ou na autoavaliação da MAVI.'
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
revoke all on function public.ai_set_route(uuid, text, uuid, uuid, text, text) from public, anon;
grant execute on function public.ai_set_route(uuid, text, uuid, uuid, text, text) to authenticated;

-- Quem pede à MAVI para escrever um tutorial: administradores e gestores com
-- a MAVI à mostra (o servidor confere antes de chamar o modelo).
create function public.tutorial_can_write(p_company uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(p_company) and exists (select 1 from public.memberships m
  where m.company_id = p_company and m.user_id = auth.uid() and m.active
   and not ('assistant' = any(coalesce(m.hidden_pages, '{}'))))
$$;

-- ------------------------------------------------------------ "Isso ajudou?"
create table public.tutorial_feedback (
 company_id uuid not null,
 tutorial_id uuid not null,
 user_id uuid not null,
 vote text not null check (vote in ('up', 'down')),
 reason text check (reason in ('outdated', 'confusing', 'missing_step', 'not_what_i_wanted', 'other')),
 comment text not null default '' check (length(comment) <= 500),
 -- A versão do tutorial quando a pessoa votou.
 version integer not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(tutorial_id, user_id),
 check (vote = 'down' or reason is null),
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade,
 foreign key(company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index tutorial_feedback_company on public.tutorial_feedback(company_id, updated_at desc);
alter table public.tutorial_feedback enable row level security;
revoke all on public.tutorial_feedback from public, anon, authenticated;

-- Vota (p_vote nulo tira o voto). Só nos tutoriais publicados que a pessoa vê.
create function public.vote_tutorial(p_tutorial uuid, p_vote text, p_reason text default null,
 p_comment text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; f public.tutorial_feedback; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_for_user(t, auth.uid()) then
  raise exception 'Este tutorial não está disponível para você.' using errcode = '42501';
 end if;
 if p_vote is null then
  delete from public.tutorial_feedback where tutorial_id = t.id and user_id = auth.uid();
  return null;
 end if;
 if p_vote not in ('up', 'down') then raise exception 'Voto inválido' using errcode = '22023'; end if;
 if p_reason is not null and p_reason not in ('outdated', 'confusing', 'missing_step', 'not_what_i_wanted', 'other') then
  raise exception 'Motivo inválido' using errcode = '22023';
 end if;
 insert into public.tutorial_feedback(company_id, tutorial_id, user_id, vote, reason, comment, version)
 values (t.company_id, t.id, auth.uid(), p_vote, case when p_vote = 'down' then p_reason end,
  left(btrim(coalesce(p_comment, '')), 500), t.version)
 on conflict (tutorial_id, user_id) do update set vote = excluded.vote, reason = excluded.reason,
  comment = excluded.comment, version = excluded.version, updated_at = now()
 returning * into f;
 return jsonb_build_object('vote', f.vote, 'reason', f.reason, 'comment', f.comment, 'version', f.version,
  'updated_at', f.updated_at);
end $$;

-- Os votos de um tutorial (quem edita), os mais novos antes.
create function public.tutorial_feedback_list(p_tutorial uuid)
returns table(user_id uuid, name text, vote text, reason text, comment text, version integer, updated_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_edit(t) then return; end if;
 return query select f.user_id, mavi_private.member_name(t.company_id, f.user_id), f.vote, f.reason, f.comment,
  f.version, f.updated_at
 from public.tutorial_feedback f where f.tutorial_id = t.id order by f.updated_at desc, f.user_id;
end $$;

-- ------------------------------------------------------------ visualizações e buscas
create table public.tutorial_searches (
 id bigint generated always as identity primary key,
 company_id uuid not null references public.companies(id),
 user_id uuid not null,
 query text not null check (length(query) between 1 and 300),
 -- Sem acento e espaços juntados: as mesmas palavras contam juntas.
 query_key text not null,
 module text,
 results integer not null check (results >= 0),
 searched_at timestamptz not null default now(),
 foreign key(company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index tutorial_searches_company on public.tutorial_searches(company_id, searched_at desc);
create index tutorial_searches_user on public.tutorial_searches(company_id, user_id, query_key, searched_at desc);
alter table public.tutorial_searches enable row level security;
revoke all on public.tutorial_searches from public, anon, authenticated;

create table public.tutorial_views (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 tutorial_id uuid not null,
 user_id uuid not null,
 source text not null check (source in ('library', 'search', 'trail', 'help', 'mavi', 'notice', 'link')),
 search_id bigint references public.tutorial_searches(id) on delete set null,
 viewed_at timestamptz not null default now(),
 foreign key(company_id, tutorial_id) references public.tutorials(company_id, id) on delete cascade,
 foreign key(company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
create index tutorial_views_company on public.tutorial_views(company_id, viewed_at desc);
create index tutorial_views_tutorial on public.tutorial_views(company_id, tutorial_id, user_id, viewed_at desc);
create index tutorial_views_search on public.tutorial_views(search_id) where search_id is not null;
alter table public.tutorial_views enable row level security;
revoke all on public.tutorial_views from public, anon, authenticated;

-- Uma busca da página (o servidor chama depois de buscar). A mesma busca da
-- mesma pessoa em 2 minutos (trocou um filtro) é a mesma linha. Devolve o id
-- (a tela leva junto ao abrir um resultado).
create function public.log_tutorial_search(p_company uuid, p_query text, p_module text, p_results integer)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_query text := left(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g')), 300); v_key text;
 v_id bigint; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 if v_query = '' then return null; end if;
 v_key := mavi_private.fold(lower(v_query));
 select s.id into v_id from public.tutorial_searches s
 where s.company_id = p_company and s.user_id = auth.uid() and s.query_key = v_key
  and s.searched_at > now() - interval '2 minutes'
 order by s.searched_at desc limit 1;
 if v_id is not null then
  update public.tutorial_searches set results = greatest(coalesce(p_results, 0), 0), module = nullif(p_module, '')
  where id = v_id;
  return v_id;
 end if;
 insert into public.tutorial_searches(company_id, user_id, query, query_key, module, results)
 values (p_company, auth.uid(), v_query, v_key, nullif(left(coalesce(p_module, ''), 40), ''),
  greatest(coalesce(p_results, 0), 0))
 returning id into v_id;
 return v_id;
end $$;

-- Uma abertura de tutorial (publicado, do público da pessoa). A mesma pessoa
-- no mesmo tutorial conta de novo só depois de 30 minutos.
create function public.log_tutorial_view(p_tutorial uuid, p_source text default 'library', p_search bigint default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; v_source text := coalesce(p_source, 'library'); v_search bigint; begin
 if v_source not in ('library', 'search', 'trail', 'help', 'mavi', 'notice', 'link') then v_source := 'link'; end if;
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_for_user(t, auth.uid()) then return false; end if;
 if exists (select 1 from public.tutorial_views v where v.company_id = t.company_id and v.tutorial_id = t.id
  and v.user_id = auth.uid() and v.viewed_at > now() - interval '30 minutes') then return false; end if;
 -- A busca só vale se for da própria pessoa.
 select s.id into v_search from public.tutorial_searches s
 where s.id = p_search and s.company_id = t.company_id and s.user_id = auth.uid();
 insert into public.tutorial_views(company_id, tutorial_id, user_id, source, search_id)
 values (t.company_id, t.id, auth.uid(), case when v_search is not null then 'search' else v_source end, v_search);
 return true;
end $$;

-- ------------------------------------------------------------ métricas
-- Os números do período (datas no fuso da empresa, as duas incluídas):
-- totais, cada tutorial e as buscas (as mais feitas e as sem resultado).
create function public.tutorial_metrics(p_company uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_start timestamptz; v_end timestamptz; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores veem as métricas dos tutoriais.' using errcode = '42501';
 end if;
 if p_from is null or p_to is null or p_to < p_from then raise exception 'Período inválido' using errcode = '22023'; end if;
 if p_to - p_from > 400 then raise exception 'Escolha um período de até 400 dias.' using errcode = '22023'; end if;
 select coalesce(timezone, 'America/Sao_Paulo') into v_tz from public.companies where id = p_company;
 v_start := p_from::timestamp at time zone v_tz;
 v_end := (p_to + 1)::timestamp at time zone v_tz;
 return (
  with views as (
   select v.* from public.tutorial_views v
   where v.company_id = p_company and v.viewed_at >= v_start and v.viewed_at < v_end),
  searches as (
   select s.*, exists (select 1 from public.tutorial_views v where v.search_id = s.id) as opened
   from public.tutorial_searches s
   where s.company_id = p_company and s.searched_at >= v_start and s.searched_at < v_end),
  done as (
   select p.tutorial_id, count(*)::integer as n from public.tutorial_progress p
   where p.company_id = p_company and p.completed_at >= v_start and p.completed_at < v_end
   group by p.tutorial_id),
  votes as (
   select f.tutorial_id, count(*) filter (where f.vote = 'up')::integer as up,
    count(*) filter (where f.vote = 'down')::integer as down,
    count(*) filter (where f.vote = 'down' and f.version = t.version)::integer as down_current
   from public.tutorial_feedback f join public.tutorials t on t.id = f.tutorial_id
   where f.company_id = p_company group by f.tutorial_id),
  per as (
   select t.id, t.title, t.status, t.version,
    (select count(*) from views v where v.tutorial_id = t.id)::integer as views,
    (select count(distinct v.user_id) from views v where v.tutorial_id = t.id)::integer as viewers,
    (select count(*) from views v where v.tutorial_id = t.id and v.source = 'search')::integer as from_search,
    coalesce(d.n, 0) as completions, coalesce(x.up, 0) as up, coalesce(x.down, 0) as down,
    coalesce(x.down_current, 0) as down_current,
    (select max(v.viewed_at) from public.tutorial_views v where v.company_id = p_company and v.tutorial_id = t.id)
     as last_view
   from public.tutorials t
   left join done d on d.tutorial_id = t.id
   left join votes x on x.tutorial_id = t.id
   where t.company_id = p_company and (t.status = 'published' or exists (select 1 from views v where v.tutorial_id = t.id))),
  grouped as (
   select s.query_key, (array_agg(s.query order by s.searched_at desc, s.id desc))[1] as query, count(*)::integer as searches,
    count(distinct s.user_id)::integer as people, round(avg(s.results), 1) as avg_results,
    count(*) filter (where s.results = 0)::integer as empty, count(*) filter (where s.opened)::integer as opened,
    max(s.searched_at) as last_at
   from searches s group by s.query_key)
  select jsonb_build_object(
   'from', p_from, 'to', p_to,
   'totals', jsonb_build_object(
    'views', (select count(*) from views), 'viewers', (select count(distinct user_id) from views),
    'searches', (select count(*) from searches), 'empty_searches', (select count(*) from searches where results = 0),
    'opened_searches', (select count(*) from searches where opened),
    'completions', (select coalesce(sum(n), 0) from done),
    'up', (select count(*) from public.tutorial_feedback f where f.company_id = p_company and f.vote = 'up'
     and f.updated_at >= v_start and f.updated_at < v_end),
    'down', (select count(*) from public.tutorial_feedback f where f.company_id = p_company and f.vote = 'down'
     and f.updated_at >= v_start and f.updated_at < v_end)),
   'sources', coalesce((select jsonb_object_agg(source, n) from (select source, count(*) as n from views group by source) z), '{}'),
   'tutorials', coalesce((select jsonb_agg(to_jsonb(p) order by p.views desc, p.viewers desc, p.title) from per p), '[]'),
   'queries', coalesce((select jsonb_agg(to_jsonb(g) order by g.searches desc, g.last_at desc)
    from (select * from grouped order by searches desc, last_at desc limit 50) g), '[]'),
   'empty', coalesce((select jsonb_agg(to_jsonb(g) order by g.empty desc, g.last_at desc)
    from (select * from grouped where empty > 0 order by empty desc, last_at desc limit 50) g), '[]'))
 );
end $$;

-- ------------------------------------------------------------ aviso de tutorial novo
-- Quem publica avisa o público do tutorial: p_channel 'inbox' (aviso na
-- caixa de entrada de cada pessoa, menos quem publica) ou 'notice' (um aviso
-- no Mural, pelas regras do Mural: o gestor só avisa o próprio escopo).
-- p_updated: o texto fala em tutorial atualizado. Devolve {channel, people, notice}.
create function public.announce_tutorial(p_tutorial uuid, p_channel text, p_updated boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t public.tutorials; v_title text; v_link text; v_people integer; v_targets jsonb; v_body text; r jsonb; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_edit(t) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if t.status <> 'published' then raise exception 'Publique o tutorial antes de avisar.' using errcode = '22023'; end if;
 if p_channel not in ('inbox', 'notice') then raise exception 'Escolha como avisar.' using errcode = '22023'; end if;
 v_title := case when p_updated then 'Tutorial atualizado: ' else 'Tutorial novo: ' end || t.title;
 v_link := '/tutoriais?tutorial=' || t.id || '&de=aviso';

 if p_channel = 'inbox' then
  insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
  select t.company_id, m.user_id, auth.uid(), null, 'tutorial', left(v_title, 300), nullif(left(t.summary, 500), ''), v_link
  from public.memberships m
  where m.company_id = t.company_id and m.active and m.user_id <> auth.uid()
   and mavi_private.tutorial_for_user(t, m.user_id);
  get diagnostics v_people = row_count;
  return jsonb_build_object('channel', 'inbox', 'people', v_people, 'notice', null);
 end if;

 -- O público do tutorial no formato do Mural (papéis viram as pessoas).
 v_targets := case when t.aud_all then jsonb_build_array(jsonb_build_object('kind', 'everyone'))
  else coalesce((
   select jsonb_agg(x) from (
    select jsonb_build_object('kind', 'team', 'id', tm) as x from unnest(t.aud_teams) tm
    union all
    select jsonb_build_object('kind', 'user', 'id', u) from (
     select unnest(t.aud_users) as u
     union
     select m.user_id from public.memberships m
     where m.company_id = t.company_id and m.active and m.role = any(t.aud_roles)) us) z), '[]') end;
 v_body := 'mavi:richtext:v1:' || jsonb_build_object('type', 'doc', 'content',
  case when t.summary <> '' then jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content',
   jsonb_build_array(jsonb_build_object('type', 'text', 'text', t.summary)))) else '[]'::jsonb end
  || jsonb_build_array(jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
   jsonb_build_object('type', 'text', 'text', 'Abrir o tutorial',
    'marks', jsonb_build_array(jsonb_build_object('type', 'link', 'attrs', jsonb_build_object('href', v_link))))))))::text;
 r := public.save_notice(t.company_id, null, jsonb_build_object('title', left(v_title, 160), 'body', v_body,
  'level', 'info', 'inbox', true, 'targets', v_targets, 'exclude', to_jsonb(t.aud_exclude)), true, false, null);
 return jsonb_build_object('channel', 'notice', 'people', null, 'notice', r->>'id');
end $$;

-- ------------------------------------------------------------ o que a tela lê
-- A da migração 20270424090000, com o voto da pessoa e, para quem edita, a
-- contagem dos votos.
create or replace function public.tutorial_detail(p_tutorial uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare t public.tutorials; d public.tutorial_drafts; v_edit boolean; p public.tutorial_progress;
 f public.tutorial_feedback; begin
 select * into t from public.tutorials where id = p_tutorial;
 if not found or not mavi_private.tutorial_can_see(t) then return null; end if;
 v_edit := mavi_private.tutorial_can_edit(t);
 if v_edit then select * into d from public.tutorial_drafts where tutorial_id = t.id; end if;
 select * into p from public.tutorial_progress x where x.company_id = t.company_id and x.user_id = auth.uid()
  and x.tutorial_id = t.id;
 select * into f from public.tutorial_feedback x where x.tutorial_id = t.id and x.user_id = auth.uid();
 return jsonb_build_object(
  'id', t.id, 'company_id', t.company_id, 'title', t.title, 'summary', t.summary, 'body', t.body,
  'modules', to_jsonb(t.modules), 'category', t.category, 'tags', to_jsonb(t.tags), 'status', t.status,
  'version', t.version, 'revision', t.revision,
  'audience', case when v_edit then jsonb_build_object('aud_all', t.aud_all, 'aud_roles', to_jsonb(t.aud_roles),
   'aud_teams', to_jsonb(t.aud_teams), 'aud_users', to_jsonb(t.aud_users), 'aud_exclude', to_jsonb(t.aud_exclude)) end,
  'created_by', t.created_by, 'author_name', mavi_private.member_name(t.company_id, t.created_by),
  'updated_by_name', mavi_private.member_name(t.company_id, t.updated_by),
  'created_at', t.created_at, 'updated_at', t.updated_at, 'published_at', t.published_at,
  'media', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'content_type', m.content_type,
    'size_bytes', m.size_bytes, 'duration_seconds', m.duration_seconds, 'transcript', m.transcript,
    'transcript_status', m.transcript_status, 'transcript_source', m.transcript_source,
    'transcript_error', case when v_edit then m.transcript_error end) order by m.created_at)
   from public.tutorial_media m where m.company_id = t.company_id and m.tutorial_id = t.id and m.status = 'ready'), '[]'),
  'draft', case when d.tutorial_id is not null then jsonb_build_object('content', d.content, 'saved_at', d.saved_at,
   'saved_by_name', mavi_private.member_name(t.company_id, d.saved_by)) end,
  'can_edit', v_edit,
  'trackable', mavi_private.tutorial_for_user(t, auth.uid()),
  'progress', case when p.tutorial_id is not null then jsonb_build_object('completed_at', p.completed_at,
   'completed_version', p.completed_version, 'completed_how', p.completed_how, 'undone', p.undone_at is not null) end,
  'trails', coalesce((select jsonb_agg(jsonb_build_object('id', tr.id, 'title', tr.title) order by tr.title)
   from public.tutorial_trail_items i join public.tutorial_trails tr on tr.id = i.trail_id
   where i.company_id = t.company_id and i.tutorial_id = t.id and mavi_private.trail_can_see(tr)), '[]'),
  'my_vote', case when f.tutorial_id is not null then jsonb_build_object('vote', f.vote, 'reason', f.reason,
   'comment', f.comment, 'version', f.version, 'updated_at', f.updated_at) end,
  'votes', case when v_edit then (select jsonb_build_object(
    'up', count(*) filter (where x.vote = 'up'), 'down', count(*) filter (where x.vote = 'down'),
    'down_current', count(*) filter (where x.vote = 'down' and x.version = t.version))
   from public.tutorial_feedback x where x.tutorial_id = t.id) end);
end $$;

-- ------------------------------------------------------------ permissões
revoke all on function public.tutorial_can_write(uuid), public.vote_tutorial(uuid, text, text, text),
 public.tutorial_feedback_list(uuid), public.log_tutorial_search(uuid, text, text, integer),
 public.log_tutorial_view(uuid, text, bigint), public.tutorial_metrics(uuid, date, date),
 public.announce_tutorial(uuid, text, boolean)
 from public, anon, authenticated;
grant execute on function public.tutorial_can_write(uuid), public.vote_tutorial(uuid, text, text, text),
 public.tutorial_feedback_list(uuid), public.log_tutorial_search(uuid, text, text, integer),
 public.log_tutorial_view(uuid, text, bigint), public.tutorial_metrics(uuid, date, date),
 public.announce_tutorial(uuid, text, boolean)
 to authenticated;

notify pgrst, 'reload schema';

commit;
