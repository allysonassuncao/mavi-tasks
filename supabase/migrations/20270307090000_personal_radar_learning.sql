begin;

-- MAVI · Radar pessoal, Fase 3: o aprendizado e a conferência do Jev.
--
-- * Lições: a MAVI junta os retornos de cada pessoa (não é comigo, não é
--   situação, resolvido, copiou, editou, reprovou, ensinou) em lições curtas
--   da pessoa, de detecção (o que é ou não é com ela) e de resposta (como
--   responder). Elas entram na leitura dos grupos e na resposta. A pessoa
--   edita, pausa, exclui e escreve as suas; a MAVI não mexe no que ela mexeu.
-- * Promoção: administradores e gestores levam uma lição para uma equipe ou um
--   cliente; o Jev confere se ela vale de forma geral (clara, sem dado
--   pessoal, sem contradizer as outras) antes de entrar em uso. Recusada, o
--   líder vê o motivo e pode pôr em uso assim mesmo.
-- * Conferência das situações: antes de virar item, o Jev confere se é mesmo
--   uma situação a resolver e se o dono pelo assunto faz sentido (funcionalidade
--   'personal_radar_check'; sem regra, o Jev do Radar do cliente). Sem o Jev,
--   nada trava.
-- * Autonomia: por tipo de situação, a taxa de respostas copiadas sem edição
--   no período; com a regra da pessoa atingida, o tipo fica "pronto para
--   responder sozinha". Só um indicador: nada é enviado.
-- O worker é o mesmo "ai-personal-radar" (acordado também quando há
-- aprendizado ou promoção para conferir).

-- ------------------------------------------------------------ Quem usa qual modelo
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask',
   'whatsapp_task', 'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text', 'task_audio',
   'whatsapp_transcribe', 'task_audio_transcribe', 'image_generation', 'mavi_page', 'web_search', 'canvas_writer',
   'mavi_rerank', 'conversation_summary', 'skill_coach', 'whatsapp_history', 'client_radar', 'client_radar_check',
   'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
   'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
   'personal_radar', 'personal_assistant', 'personal_radar_check')));

-- A da migração 20270115090000, com a conferência do Radar pessoal.
create or replace function mavi_private.ai_decision_feature(p_feature text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_feature, '') in ('client_temperature', 'client_radar_check', 'mavi_judge_check', 'personal_radar_check')
$$;

-- A da migração 20270304090000, com a conferência do Radar pessoal (Jev).
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
  'client_radar_themes', 'client_radar_report', 'mavi_learning', 'campaign_report', 'mavi_judge',
  'mavi_judge_check', 'task_title', 'dashboard_builder', 'campaign_alerts', 'task_search',
  'personal_radar', 'personal_assistant', 'personal_radar_check') then
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
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro, na conferência do Radar ou na autoavaliação da MAVI.'
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

-- ------------------------------------------------------------ aprendizados
-- O que a MAVI segue em cada pessoa, equipe e cliente:
--  detection: o que é (ou não é) com a pessoa e o que é (ou não é) uma situação;
--  reply: como responder (tom, o que trazer, o que evitar).
-- Alcance: person (só de quem aprendeu), team (todos da equipe), client (todo
-- mundo que lê aquele cliente). Só a MAVI escreve os da pessoa a partir dos
-- retornos dela; a pessoa edita, pausa, exclui e escreve os seus; administradores
-- e gestores promovem para a equipe ou o cliente, e o Jev confere antes de
-- valer (status 'checking' → 'active' ou 'refused'; o líder pode forçar).
create table public.personal_radar_lessons (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 scope text not null check (scope in ('person', 'team', 'client')),
 user_id uuid,
 team_id uuid,
 client_id uuid,
 kind text not null check (kind in ('detection', 'reply')),
 text text not null check (length(btrim(text)) between 5 and 400),
 status text not null default 'active' check (status in ('active', 'paused', 'dismissed', 'checking', 'refused')),
 origin text not null default 'mavi' check (origin in ('mavi', 'person', 'leader')),
 source_lesson uuid references public.personal_radar_lessons(id) on delete set null,
 feedback uuid[] not null default '{}',
 check_note text check (length(check_note) <= 500),
 checked_at timestamptz,
 check_attempts integer not null default 0,
 check_claimed_until timestamptz,
 created_by uuid,
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (scope <> 'person' or user_id is not null),
 check (scope <> 'team' or team_id is not null),
 check (scope <> 'client' or client_id is not null),
 foreign key (company_id, team_id) references public.teams(company_id, id) on delete cascade,
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index personal_radar_lessons_person on public.personal_radar_lessons(company_id, user_id) where scope = 'person';
create index personal_radar_lessons_shared on public.personal_radar_lessons(company_id, scope, status) where scope <> 'person';
alter table public.personal_radar_lessons enable row level security;
revoke all on public.personal_radar_lessons from public, anon, authenticated;

-- A fila do aprendizado: uma por pessoa, suja a cada retorno novo.
create table public.personal_radar_learning (
 company_id uuid not null,
 user_id uuid not null,
 dirty_at timestamptz not null default now(),
 claimed_until timestamptz,
 attempts integer not null default 0,
 last_error text,
 learned_at timestamptz,
 primary key (company_id, user_id),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
alter table public.personal_radar_learning enable row level security;
revoke all on public.personal_radar_learning from public, anon, authenticated;

create function mavi_private.personal_radar_feedback_dirty() returns trigger
language plpgsql security definer set search_path = '' as $$ begin
 insert into public.personal_radar_learning as l (company_id, user_id, dirty_at)
 select distinct n.company_id, n.user_id, now() from new_rows n
 on conflict (company_id, user_id) do update set dirty_at = now();
 return null;
end $$;
create trigger personal_radar_feedback_dirty after insert on public.personal_radar_feedback
 referencing new table as new_rows for each statement execute function mavi_private.personal_radar_feedback_dirty();
-- Os retornos que já existem entram na primeira rodada.
insert into public.personal_radar_learning (company_id, user_id, dirty_at)
select distinct f.company_id, f.user_id, now() - interval '1 hour' from public.personal_radar_feedback f
where f.learned_at is null on conflict do nothing;

-- As lições em uso para uma pessoa (dela, das equipes dela e do cliente).
create function mavi_private.personal_radar_lessons_for(c uuid, u uuid, p_client uuid, p_kind text) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(jsonb_build_object('scope', l.scope, 'text', l.text) order by
   case l.scope when 'person' then 0 when 'client' then 1 else 2 end, l.updated_at desc), '[]')
 from (select * from public.personal_radar_lessons l
  where l.company_id = c and l.kind = p_kind and l.status = 'active'
   and ((l.scope = 'person' and l.user_id = u)
    or (l.scope = 'team' and l.team_id in (select tm.team_id from public.team_members tm where tm.company_id = c and tm.user_id = u))
    or (l.scope = 'client' and p_client is not null and l.client_id = p_client))
  order by case l.scope when 'person' then 0 when 'client' then 1 else 2 end, l.updated_at desc
  limit 25) l
$$;
revoke all on function mavi_private.personal_radar_lessons_for(uuid, uuid, uuid, text) from public, anon, authenticated;

-- Para a leitura dos grupos: as lições de detecção de cada pessoa lida.
create function public.ai_personal_radar_lessons(p_secret text, p_company uuid, p_people uuid[], p_client uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return (select coalesce(jsonb_object_agg(u, mavi_private.personal_radar_lessons_for(p_company, u, p_client, 'detection')), '{}')
  from unnest(coalesce(p_people, '{}')) u);
end $$;

-- Para a resposta: as lições de resposta de quem escreve, no cliente do item.
create function public.personal_radar_reply_lessons(p_company uuid, p_client uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return mavi_private.personal_radar_lessons_for(p_company, auth.uid(), p_client, 'reply');
end $$;

-- ------------------------------------------------------------ o Jev
-- O Jev do Radar pessoal: o da funcionalidade 'personal_radar_check' ou,
-- sem regra, o do Radar do cliente (que cai no do termômetro).
create function mavi_private.personal_radar_jev_route(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select jsonb_build_object('provider_id', p.id, 'provider', p.name, 'kind', p.kind, 'base_url', p.base_url,
    'key_cipher', p.key_cipher, 'model', rt.model,
    'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = rt.model limit 1))
   from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
   where rt.company_id = c and rt.scope_type = 'feature' and rt.feature = 'personal_radar_check'
   limit 1),
  mavi_private.radar_jev_route(c))
$$;
revoke all on function mavi_private.personal_radar_jev_route(uuid) from public, anon, authenticated;

create function public.ai_personal_radar_config(p_secret text, p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object('jev', mavi_private.personal_radar_jev_route(p_company));
end $$;

-- ------------------------------------------------------------ worker: aprender
-- Uma pessoa com retornos novos (3 ou mais, ou o mais antigo com mais de 30
-- minutos), reservada por 10 minutos: os retornos ainda não aprendidos (até
-- 40), quem ela é e as lições dela.
create function public.ai_personal_radar_learning_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare l public.personal_radar_learning; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select q.* into l from public.personal_radar_learning q
 where (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
  and (q.learned_at is null or q.dirty_at > q.learned_at)
  and exists (select 1 from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
   and f.learned_at is null)
  and ((select count(*) from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
    and f.learned_at is null) >= 3
   or (select min(f.created_at) from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
    and f.learned_at is null) < now() - interval '30 minutes')
 order by q.dirty_at
 limit 1
 for update skip locked;
 if not found then return null; end if;
 update public.personal_radar_learning set claimed_until = now() + interval '10 minutes', attempts = attempts + 1
 where company_id = l.company_id and user_id = l.user_id;
 return jsonb_build_object('company', l.company_id, 'user', l.user_id,
  'person', (select jsonb_build_object('name', m.name, 'about', coalesce(p.about, ''),
    'teams', (select coalesce(jsonb_agg(distinct t.name), '[]') from public.team_members tm
     join public.teams t on t.company_id = tm.company_id and t.id = tm.team_id
     where tm.company_id = l.company_id and tm.user_id = l.user_id))
   from public.memberships m left join public.personal_radar_people p on p.company_id = m.company_id and p.user_id = m.user_id
   where m.company_id = l.company_id and m.user_id = l.user_id),
  'feedback', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', f.id, 'action', f.action,
    'note', nullif(f.note, ''), 'kind', f.snapshot->>'kind', 'title', f.snapshot->>'title',
    'summary', left(f.snapshot->>'summary', 300), 'client', f.snapshot->>'client', 'reason', f.snapshot->>'reason',
    'why', f.snapshot->>'why', 'draft', left(f.snapshot->>'draft', 800), 'final', left(f.snapshot->>'final', 800),
    'at', to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI'))) order by f.created_at), '[]')
   from (select * from public.personal_radar_feedback z where z.company_id = l.company_id and z.user_id = l.user_id
    and z.learned_at is null order by z.created_at limit 40) f),
  'lessons', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'text', x.text,
    'status', x.status, 'origin', x.origin) order by x.created_at), '[]')
   from public.personal_radar_lessons x where x.company_id = l.company_id and x.scope = 'person' and x.user_id = l.user_id));
end $$;

-- As mudanças: p_ops = [{op: add | update | retire, id?, kind?, text?,
-- feedback?: [ids]}]. A MAVI não mexe no que a pessoa escreveu, pausou ou
-- excluiu, e não recria o que foi excluído. p_learned: os retornos lidos.
create function public.ai_personal_radar_learning_store(p_secret text, p_company uuid, p_user uuid, p_ops jsonb,
 p_learned uuid[], p_usage jsonb default '{}') returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; n integer := 0; v_text text; v_kind text; v_id uuid; v_fb uuid[]; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := left(btrim(coalesce(o->>'text', '')), 400);
  v_kind := case when o->>'kind' in ('detection', 'reply') then o->>'kind' end;
  v_id := case when coalesce(o->>'id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (o->>'id')::uuid end;
  select coalesce(array_agg(f.id), '{}') into v_fb from public.personal_radar_feedback f
  where f.company_id = p_company and f.user_id = p_user
   and f.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(o->'feedback') = 'array' then o->'feedback' else '[]' end));
  if o->>'op' = 'add' and v_kind is not null and length(v_text) >= 5
   and not exists (select 1 from public.personal_radar_lessons x where x.company_id = p_company and x.scope = 'person'
    and x.user_id = p_user and lower(x.text) = lower(v_text)) then
   insert into public.personal_radar_lessons(company_id, scope, user_id, kind, text, origin, feedback)
   values (p_company, 'person', p_user, v_kind, v_text, 'mavi', v_fb);
   n := n + 1;
  elsif o->>'op' = 'update' and v_id is not null and length(v_text) >= 5 then
   update public.personal_radar_lessons set text = v_text, kind = coalesce(v_kind, kind),
    feedback = (select array(select distinct unnest(feedback || v_fb))), updated_at = now()
   where id = v_id and company_id = p_company and scope = 'person' and user_id = p_user
    and origin = 'mavi' and status = 'active';
   n := n + case when found then 1 else 0 end;
  elsif o->>'op' = 'retire' and v_id is not null then
   delete from public.personal_radar_lessons where id = v_id and company_id = p_company and scope = 'person'
    and user_id = p_user and origin = 'mavi' and status = 'active'
    and not exists (select 1 from public.personal_radar_lessons y where y.source_lesson = v_id);
   n := n + case when found then 1 else 0 end;
  end if;
 end loop;
 update public.personal_radar_feedback set learned_at = now()
 where company_id = p_company and user_id = p_user and id = any(coalesce(p_learned, '{}'));
 update public.personal_radar_learning set learned_at = now(), claimed_until = null, attempts = 0, last_error = null
 where company_id = p_company and user_id = p_user;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 or coalesce((p_usage->>'input')::integer, 0) > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, p_user, 'personal_radar', 'learning', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), coalesce((p_usage->>'output')::integer, 0),
   coalesce((p_usage->>'cache_read')::integer, 0), coalesce((p_usage->>'cache_write')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 if n > 0 then
  perform mavi_private.broadcast(p_company, jsonb_build_object('kind', 'personal_radar', 'people', jsonb_build_array(p_user),
   'lessons', true));
 end if;
 return n;
end $$;

create function public.ai_personal_radar_learning_fail(p_secret text, p_company uuid, p_user uuid, p_error text)
returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.personal_radar_learning set claimed_until = now() + make_interval(mins => attempts * 10),
  last_error = left(p_error, 500)
 where company_id = p_company and user_id = p_user;
end $$;

-- ------------------------------------------------------------ worker: conferir a promoção
-- Uma lição promovida esperando o Jev (até 3 tentativas), com as outras do
-- mesmo alcance (para ver contradição) e o Jev da empresa.
create function public.ai_personal_radar_check_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.personal_radar_lessons; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select l.* into x from public.personal_radar_lessons l
 where l.status = 'checking' and l.check_attempts < 3 and (l.check_claimed_until is null or l.check_claimed_until < now())
 order by l.updated_at limit 1 for update skip locked;
 if not found then return null; end if;
 update public.personal_radar_lessons set check_claimed_until = now() + interval '5 minutes', check_attempts = check_attempts + 1
 where id = x.id;
 return jsonb_build_object('id', x.id, 'company', x.company_id, 'scope', x.scope, 'kind', x.kind, 'text', x.text,
  'target', case x.scope when 'team' then (select name from public.teams where company_id = x.company_id and id = x.team_id)
   else (select name from public.clients where company_id = x.company_id and id = x.client_id) end,
  'others', (select coalesce(jsonb_agg(o.text), '[]') from public.personal_radar_lessons o
   where o.company_id = x.company_id and o.id <> x.id and o.scope = x.scope and o.kind = x.kind and o.status = 'active'
    and o.team_id is not distinct from x.team_id and o.client_id is not distinct from x.client_id),
  'jev', mavi_private.personal_radar_jev_route(x.company_id));
end $$;

-- O resultado: p_ok (vale), p_note (o motivo da recusa), p_usage.
create function public.ai_personal_radar_check_store(p_secret text, p_lesson uuid, p_ok boolean, p_note text default null,
 p_usage jsonb default '{}') returns void
language plpgsql security definer set search_path = '' as $$
declare x public.personal_radar_lessons; v_cost numeric; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.personal_radar_lessons set status = case when p_ok then 'active' else 'refused' end,
  check_note = left(p_note, 500), checked_at = now(), check_claimed_until = null, updated_at = now()
 where id = p_lesson and status = 'checking'
 returning * into x;
 if x.id is null then return; end if;
 v_cost := least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100);
 if v_cost > 0 then
  insert into public.ai_usage(company_id, user_id, module, kind, model, input_tokens, cost_usd, provider_id, provider_name)
  values (x.company_id, null, 'personal_radar', 'lesson_check', left(coalesce(p_usage->>'model', ''), 80),
   coalesce((p_usage->>'input')::integer, 0), v_cost,
   case when (p_usage->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 perform mavi_private.broadcast(x.company_id, jsonb_build_object('kind', 'personal_radar', 'people',
  jsonb_build_array(x.created_by), 'lessons', true));
end $$;

-- O que acorda o worker: além dos grupos, os aprendizados e as promoções.
create or replace function mavi_private.personal_radar_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.personal_radar_people p where p.active
   and mavi_private.personal_radar_due(p.company_id))
  and not exists (select 1 from public.personal_radar_learning q
   where (q.claimed_until is null or q.claimed_until < now()) and q.attempts < 5
    and (q.learned_at is null or q.dirty_at > q.learned_at)
    and exists (select 1 from public.personal_radar_feedback f where f.company_id = q.company_id and f.user_id = q.user_id
     and f.learned_at is null and (f.created_at < now() - interval '30 minutes'
      or (select count(*) from public.personal_radar_feedback g where g.company_id = q.company_id and g.user_id = q.user_id
       and g.learned_at is null) >= 3)))
  and not exists (select 1 from public.personal_radar_lessons l where l.status = 'checking' and l.check_attempts < 3
   and (l.check_claimed_until is null or l.check_claimed_until < now())) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-personal-radar"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 290000);
end $$;

revoke all on function public.ai_personal_radar_lessons(text, uuid, uuid[], uuid), public.ai_personal_radar_config(text, uuid),
 public.ai_personal_radar_learning_claim(text), public.ai_personal_radar_learning_store(text, uuid, uuid, jsonb, uuid[], jsonb),
 public.ai_personal_radar_learning_fail(text, uuid, uuid, text), public.ai_personal_radar_check_claim(text),
 public.ai_personal_radar_check_store(text, uuid, boolean, text, jsonb) from public, anon, authenticated;
grant execute on function public.ai_personal_radar_lessons(text, uuid, uuid[], uuid), public.ai_personal_radar_config(text, uuid),
 public.ai_personal_radar_learning_claim(text), public.ai_personal_radar_learning_store(text, uuid, uuid, jsonb, uuid[], jsonb),
 public.ai_personal_radar_learning_fail(text, uuid, uuid, text), public.ai_personal_radar_check_claim(text),
 public.ai_personal_radar_check_store(text, uuid, boolean, text, jsonb) to anon, authenticated;

-- ------------------------------------------------------------ a tela: aprendizados
create function mavi_private.personal_radar_lesson_json(l public.personal_radar_lessons) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_strip_nulls(jsonb_build_object('id', l.id, 'scope', l.scope, 'kind', l.kind, 'text', l.text,
  'status', l.status, 'origin', l.origin, 'check_note', l.check_note, 'checked_at', l.checked_at,
  'updated_at', l.updated_at, 'evidence', cardinality(l.feedback),
  'user', case when l.scope = 'person' then (select jsonb_build_object('id', m.user_id, 'name', m.name)
   from public.memberships m where m.company_id = l.company_id and m.user_id = l.user_id) end,
  'team', case when l.scope = 'team' then (select jsonb_build_object('id', t.id, 'name', t.name)
   from public.teams t where t.company_id = l.company_id and t.id = l.team_id) end,
  'client', case when l.scope = 'client' then (select jsonb_build_object('id', k.id, 'name', k.name)
   from public.clients k where k.company_id = l.company_id and k.id = l.client_id) end,
  'promoted', (select jsonb_agg(jsonb_build_object('scope', y.scope, 'status', y.status)) from public.personal_radar_lessons y
   where y.source_lesson = l.id)))
$$;
revoke all on function mavi_private.personal_radar_lesson_json(public.personal_radar_lessons) from public, anon, authenticated;

-- As lições: as da pessoa (p_user nulo = quem olha; outra pessoa, para quem
-- pode ver a lista dela) e as da equipe e dos clientes que valem para ela.
-- Líderes veem todas as da agência e podem promover.
create function public.personal_radar_lessons(p_company uuid, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := coalesce(p_user, auth.uid()); v_leader boolean := mavi_private.leader(p_company); begin
 if not mavi_private.personal_radar_can_view(p_company, v_user) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return jsonb_build_object(
  'mine', (select coalesce(jsonb_agg(mavi_private.personal_radar_lesson_json(l) order by l.status = 'dismissed', l.kind, l.updated_at desc), '[]')
   from public.personal_radar_lessons l where l.company_id = p_company and l.scope = 'person' and l.user_id = v_user),
  'shared', (select coalesce(jsonb_agg(mavi_private.personal_radar_lesson_json(l) order by l.status = 'dismissed', l.scope, l.updated_at desc), '[]')
   from public.personal_radar_lessons l where l.company_id = p_company and l.scope <> 'person'
    and (v_leader or (l.status = 'active' and ((l.scope = 'team' and l.team_id in (select tm.team_id from public.team_members tm
      where tm.company_id = p_company and tm.user_id = v_user))
     or (l.scope = 'client' and l.client_id = any(mavi_private.served_clients_of(p_company, v_user))))))),
  'can_edit', v_user = auth.uid(),
  'can_promote', v_leader,
  'teams', case when v_leader then (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name), '[]')
   from public.teams t where t.company_id = p_company) else '[]' end,
  'clients', case when v_leader then (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name) order by k.name), '[]')
   from public.clients k where k.company_id = p_company and not k.archived
    and (k.id = any(mavi_private.served_clients_of(p_company, v_user))
     or exists (select 1 from public.personal_radar_items i where i.company_id = p_company and i.client_id = k.id))) else '[]' end);
end $$;

-- Escrever ou editar uma lição: a da própria pessoa (vira "escrita por
-- você"); as da equipe e do cliente, só líderes.
create function public.save_personal_radar_lesson(p_company uuid, p_id uuid, p_kind text, p_text text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; v_text text := btrim(coalesce(p_text, '')); begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if length(v_text) not between 5 and 400 then
  raise exception 'Escreva a lição com 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if coalesce(p_kind, '') not in ('detection', 'reply') then raise exception 'Tipo inválido' using errcode = '22023'; end if;
 if p_id is null then
  if not mavi_private.personal_radar_allowed(p_company, v_me) then
   raise exception 'O Radar pessoal ainda não foi liberado para você.' using errcode = '42501';
  end if;
  insert into public.personal_radar_lessons(company_id, scope, user_id, kind, text, origin, created_by, updated_by)
  values (p_company, 'person', v_me, p_kind, v_text, 'person', v_me, v_me) returning * into l;
 else
  select * into l from public.personal_radar_lessons where id = p_id and company_id = p_company for update;
  if not found or (l.scope = 'person' and l.user_id <> v_me) or (l.scope <> 'person' and not mavi_private.leader(p_company)) then
   raise exception 'Lição não encontrada' using errcode = 'P0002';
  end if;
  update public.personal_radar_lessons set text = v_text, kind = p_kind,
   origin = case when scope = 'person' then 'person' else 'leader' end,
   -- A da equipe ou do cliente editada passa pelo Jev de novo.
   status = case when scope <> 'person' and status in ('active', 'refused') then 'checking' else status end,
   check_attempts = case when scope <> 'person' then 0 else check_attempts end,
   updated_by = v_me, updated_at = now()
  where id = p_id returning * into l;
 end if;
 return mavi_private.personal_radar_lesson_json(l);
end $$;

-- Ligar, pausar ou excluir: a da pessoa, por ela; as outras, por líderes. O
-- líder também põe em uso uma recusada pelo Jev (decisão dele).
create function public.set_personal_radar_lesson_status(p_company uuid, p_id uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; begin
 select * into l from public.personal_radar_lessons where id = p_id and company_id = p_company for update;
 if not found or not mavi_private.member(p_company)
  or (l.scope = 'person' and l.user_id <> v_me) or (l.scope <> 'person' and not mavi_private.leader(p_company)) then
  raise exception 'Lição não encontrada' using errcode = 'P0002';
 end if;
 if coalesce(p_status, '') not in ('active', 'paused', 'dismissed') then
  raise exception 'Situação inválida' using errcode = '22023';
 end if;
 update public.personal_radar_lessons set status = p_status,
  check_note = case when l.status = 'refused' and p_status = 'active' then 'Posta em uso por um líder.' else check_note end,
  updated_by = v_me, updated_at = now()
 where id = p_id returning * into l;
 return mavi_private.personal_radar_lesson_json(l);
end $$;

-- Promover para uma equipe ou um cliente (administradores e gestores): uma
-- cópia nova, que o Jev confere antes de valer.
create function public.promote_personal_radar_lesson(p_company uuid, p_id uuid, p_scope text, p_target uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); l public.personal_radar_lessons; n public.personal_radar_lessons; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Só administradores e gestores promovem lições.' using errcode = '42501';
 end if;
 select * into l from public.personal_radar_lessons where id = p_id and company_id = p_company;
 if not found or l.scope <> 'person' then raise exception 'Lição não encontrada' using errcode = 'P0002'; end if;
 if p_scope = 'team' and not exists (select 1 from public.teams where company_id = p_company and id = p_target)
  or p_scope = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_target)
  or coalesce(p_scope, '') not in ('team', 'client') then
  raise exception 'Escolha a equipe ou o cliente.' using errcode = '22023';
 end if;
 if exists (select 1 from public.personal_radar_lessons x where x.source_lesson = l.id and x.scope = p_scope
  and (x.team_id = p_target or x.client_id = p_target) and x.status <> 'dismissed') then
  raise exception 'Esta lição já foi promovida para lá.' using errcode = '23505';
 end if;
 insert into public.personal_radar_lessons(company_id, scope, team_id, client_id, kind, text, status, origin, source_lesson,
  feedback, created_by, updated_by)
 values (p_company, p_scope, case when p_scope = 'team' then p_target end, case when p_scope = 'client' then p_target end,
  l.kind, l.text, 'checking', 'leader', l.id, l.feedback, v_me, v_me)
 returning * into n;
 return mavi_private.personal_radar_lesson_json(n);
end $$;

revoke all on function public.personal_radar_reply_lessons(uuid, uuid), public.personal_radar_lessons(uuid, uuid),
 public.save_personal_radar_lesson(uuid, uuid, text, text), public.set_personal_radar_lesson_status(uuid, uuid, text),
 public.promote_personal_radar_lesson(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.personal_radar_reply_lessons(uuid, uuid), public.personal_radar_lessons(uuid, uuid),
 public.save_personal_radar_lesson(uuid, uuid, text, text), public.set_personal_radar_lesson_status(uuid, uuid, text),
 public.promote_personal_radar_lesson(uuid, uuid, text, uuid) to authenticated;

-- ------------------------------------------------------------ autonomia
-- A regra de cada pessoa por tipo de situação: com a taxa de respostas
-- copiadas sem edição acima de min_rate em pelo menos min_count respostas
-- dos últimos days dias, o tipo fica "pronto para responder sozinha". Só um
-- indicador: nada é enviado sozinho.
create table public.personal_radar_autonomy (
 company_id uuid not null,
 user_id uuid not null,
 kind text not null check (kind in ('question', 'request', 'complaint', 'material', 'approval', 'deadline')),
 enabled boolean not null default true,
 days integer not null default 30 check (days between 7 and 180),
 min_rate numeric(4,3) not null default 0.9 check (min_rate between 0.5 and 1),
 min_count integer not null default 10 check (min_count between 3 and 500),
 updated_at timestamptz not null default now(),
 primary key (company_id, user_id, kind),
 foreign key (company_id, user_id) references public.memberships(company_id, user_id) on delete cascade
);
alter table public.personal_radar_autonomy enable row level security;
revoke all on public.personal_radar_autonomy from public, anon, authenticated;

-- Os números de cada tipo: respostas decididas (copiadas, editadas ou
-- reprovadas) no período da regra e quantas foram copiadas sem mexer.
create function public.personal_radar_autonomy(p_company uuid, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_user uuid := coalesce(p_user, auth.uid()); begin
 if not mavi_private.personal_radar_can_view(p_company, v_user) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return (select jsonb_agg(jsonb_build_object('kind', k.kind, 'enabled', coalesce(a.enabled, true),
   'days', coalesce(a.days, 30), 'min_rate', coalesce(a.min_rate, 0.9), 'min_count', coalesce(a.min_count, 10),
   'decided', s.decided, 'approved', s.approved, 'edited', s.edited, 'rejected', s.rejected,
   'rate', case when s.decided > 0 then round(s.approved::numeric / s.decided, 3) end,
   'ready', coalesce(a.enabled, true) and s.decided >= coalesce(a.min_count, 10)
    and s.approved::numeric / greatest(s.decided, 1) >= coalesce(a.min_rate, 0.9)) order by k.n)
  from (values ('question', 1), ('request', 2), ('complaint', 3), ('material', 4), ('approval', 5), ('deadline', 6)) k(kind, n)
  left join public.personal_radar_autonomy a on a.company_id = p_company and a.user_id = v_user and a.kind = k.kind
  cross join lateral (
   select count(*) filter (where f.action in ('approved', 'edited', 'rejected')) as decided,
    count(*) filter (where f.action = 'approved') as approved,
    count(*) filter (where f.action = 'edited') as edited,
    count(*) filter (where f.action = 'rejected') as rejected
   from public.personal_radar_feedback f
   where f.company_id = p_company and f.user_id = v_user and f.snapshot->>'kind' = k.kind
    and f.created_at > now() - make_interval(days => coalesce(a.days, 30))) s);
end $$;

create function public.set_personal_radar_autonomy(p_company uuid, p_kind text, p_enabled boolean, p_days integer,
 p_min_rate numeric, p_min_count integer) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.personal_radar_allowed(p_company, auth.uid()) then
  raise exception 'O Radar pessoal ainda não foi liberado para você.' using errcode = '42501';
 end if;
 if coalesce(p_kind, '') not in ('question', 'request', 'complaint', 'material', 'approval', 'deadline') then
  raise exception 'Tipo inválido' using errcode = '22023';
 end if;
 if p_days not between 7 and 180 or p_min_rate not between 0.5 and 1 or p_min_count not between 3 and 500 then
  raise exception 'Use de 7 a 180 dias, taxa de 50%% a 100%% e de 3 a 500 respostas.' using errcode = '22023';
 end if;
 insert into public.personal_radar_autonomy as a (company_id, user_id, kind, enabled, days, min_rate, min_count)
 values (p_company, auth.uid(), p_kind, coalesce(p_enabled, true), p_days, p_min_rate, p_min_count)
 on conflict (company_id, user_id, kind) do update set enabled = excluded.enabled, days = excluded.days,
  min_rate = excluded.min_rate, min_count = excluded.min_count, updated_at = now();
 return public.personal_radar_autonomy(p_company, null);
end $$;

revoke all on function public.personal_radar_autonomy(uuid, uuid),
 public.set_personal_radar_autonomy(uuid, text, boolean, integer, numeric, integer) from public, anon;
grant execute on function public.personal_radar_autonomy(uuid, uuid),
 public.set_personal_radar_autonomy(uuid, text, boolean, integer, numeric, integer) to authenticated;

commit;
