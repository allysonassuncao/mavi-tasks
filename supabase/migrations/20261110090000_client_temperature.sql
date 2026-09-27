begin;

-- MAVI · Termômetro do cliente.
--
-- A temperatura da relação com cada cliente, lida nas reuniões gravadas
-- (Gravações da MAVI) e nos grupos de WhatsApp. Quem lê é o Jev (TypeSafe),
-- pelo OpenRouter: um modelo de decisão que não escreve texto — recebe o
-- material e perguntas de formato fechado e devolve notas numa escala,
-- escolhas e sim/não, com a probabilidade de cada resposta.
--
-- - Leituras (temperature_signals): uma por reunião e uma por dia de cada
--   grupo. Nascem e são refeitas pelo trigger em ai_documents (o documento da
--   MAVI mudou), então seguem o que a base já sabe: cliente certo, grupo
--   ignorado, reunião apagada. Dias sem nenhuma fala do cliente não são
--   lidos. Mensagens do número da agência e dos telefones do time (Meu perfil
--   e Membros) aparecem marcadas como do time: o Jev avalia o cliente.
-- - Configuração (temperature_settings, temperature_indicators,
--   temperature_product_rules): administradores e gestores definem a escala
--   (faixas com nome, cor e se avisam), os indicadores (nota numa escala de 2
--   a 10 níveis, do pior para o melhor, com peso) e os sinais de alerta
--   (sim/não), os assuntos que mexem com o humor do cliente, a janela e o
--   peso de cada fonte. Cada produto pode desligar ou mudar o peso de um
--   indicador da empresa e somar indicadores próprios. Mudou uma pergunta
--   (indicador, sinal ou assunto): a versão sobe e o histórico é lido de novo
--   (no Jev, centavos). Mudou só peso, faixa ou janela: só o cálculo refaz.
-- - Cálculo (temperature_days): cada indicador é a média das leituras da
--   janela, pesada pela fonte, pela idade (meia-vida), pela confiança do Jev
--   e pela evidência (a pergunta "o material fala disso?"); a nota geral é a
--   média dos indicadores pelos pesos. Um dia por cliente, para o gráfico e
--   para os Dashboards (fonte "Temperatura dos clientes").
-- - Texto da MAVI: um parágrafo curto (funcionalidade
--   'client_temperature_text'), refeito só quando a faixa muda, a nota anda
--   8 pontos ou um sinal aparece.
-- - Aviso: quando o cliente cai para uma faixa que avisa, ou um sinal de
--   alerta aparece, os supervisores das equipes que atendem o cliente
--   (sem nenhum, os administradores) recebem na caixa de entrada e no push.
--   Enquanto o histórico ainda está sendo lido, nada é avisado.
-- - O worker (/api/ai, ação "ai-temperature") roda pelo pg_cron
--   (supabase/operations/schedule-client-temperature.sql).

-- ------------------------------------------------------------ funcionalidades
alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
alter table mavi_private.ai_routes add constraint ai_routes_feature_check
 check ((scope_type = 'feature') = (feature is not null)
  and (feature is null or feature in ('assistant', 'meetings_history', 'meetings_ask', 'whatsapp_task',
   'social_leads_plan', 'social_leads_adjust', 'social_leads_briefing', 'social_leads_colors',
   'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
   'client_temperature', 'client_temperature_text')));

-- O modelo do Jev (não é de conversa: não serve para as outras funcionalidades).
create function mavi_private.jev_model(p_model text) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(p_model, '') ~* 'typesafe/jev'
$$;

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text,
 p_feature text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare v_id uuid := case when p_type in ('company', 'feature') then null else p_id end;
 v_feature text := case when p_type = 'feature' then p_feature end; v_kind text; begin
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
  'task_copilot', 'client_dossier', 'copilot_learning', 'notice_writer', 'notice_animation',
  'client_temperature', 'client_temperature_text') then
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
 -- O termômetro lê com o Jev pelo OpenRouter; o Jev não conversa.
 if v_feature = 'client_temperature' and not (v_kind = 'openrouter' and mavi_private.jev_model(p_model)) then
  raise exception 'O termômetro usa o Jev (TypeSafe) pelo OpenRouter: escolha o modelo do Jev.' using errcode = '22023';
 end if;
 if coalesce(v_feature, '') <> 'client_temperature' and mavi_private.jev_model(p_model) then
  raise exception 'O Jev só responde a perguntas de decisão: use-o no termômetro do cliente.' using errcode = '22023';
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

-- O Jev da empresa: o escolhido em "Por funcionalidade" ou, sem escolha, o
-- primeiro Jev cadastrado num provedor OpenRouter ligado.
create function mavi_private.temperature_route(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('provider_id', x.id, 'provider', x.name, 'kind', x.kind, 'base_url', x.base_url,
  'key_cipher', x.key_cipher, 'model', x.model,
  'price', (select m from jsonb_array_elements(x.models) m where m->>'id' = x.model limit 1))
 from (
  select p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models, rt.model, 1 as o
  from mavi_private.ai_routes rt join mavi_private.ai_providers p on p.id = rt.provider_id and p.active
  where rt.company_id = c and rt.scope_type = 'feature' and rt.feature = 'client_temperature'
  union all
  select p.id, p.name, p.kind, p.base_url, p.key_cipher, p.models, m->>'id', 2
  from mavi_private.ai_providers p cross join lateral jsonb_array_elements(p.models) m
  where p.company_id = c and p.active and p.kind = 'openrouter' and mavi_private.jev_model(m->>'id')
 ) x
 order by x.o, x.name
 limit 1
$$;

-- ------------------------------------------------------------ telefones do time
-- O telefone de cada pessoa (um só, em todas as empresas dela). Nas
-- conversas dos grupos, as mensagens desses números são do time.
create table mavi_private.user_phones (
 user_id uuid primary key,
 phone text not null check (phone ~ '^\d{10,15}$'),
 key text not null,
 updated_by uuid,
 updated_at timestamptz not null default now()
);
create index user_phones_key on mavi_private.user_phones (key);
revoke all on mavi_private.user_phones from public, anon, authenticated;

-- Os dígitos que identificam um número: no Brasil, país + DDD + os 8 últimos
-- (o WhatsApp às vezes guarda o celular sem o nono dígito).
create function mavi_private.phone_key(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '\D', '', 'g'); begin
 if length(d) in (10, 11) then d := '55' || d; end if;
 if d like '55%' and length(d) in (12, 13) then return substr(d, 1, 4) || right(d, 8); end if;
 return nullif(d, '');
end $$;

create function mavi_private.team_phone_keys(c uuid) returns text[]
language sql stable security definer set search_path = '' as $$
 select coalesce(array_agg(distinct p.key), '{}') from mavi_private.user_phones p
 join public.memberships m on m.user_id = p.user_id and m.company_id = c
$$;

-- A própria pessoa ou um líder da empresa.
create function public.member_phone(p_company uuid, p_user uuid) returns text
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.member(p_company) or not (p_user = auth.uid() or mavi_private.leader(p_company))
  or not exists (select 1 from public.memberships where company_id = p_company and user_id = p_user) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 return (select phone from mavi_private.user_phones where user_id = p_user);
end $$;

create function public.set_member_phone(p_company uuid, p_user uuid, p_phone text) returns text
language plpgsql security definer set search_path = '' as $$
declare target public.memberships; v_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g'); v_old text; begin
 if not mavi_private.member(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into target from public.memberships where company_id = p_company and user_id = p_user;
 if not found then raise exception 'Usuário não encontrado na empresa' using errcode = 'P0002'; end if;
 if p_user <> auth.uid() then
  if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if target.role = 'admin' and not mavi_private.admin(p_company) then
   raise exception 'Somente administradores editam administradores.' using errcode = '42501';
  end if;
 end if;
 if length(v_digits) in (10, 11) then v_digits := '55' || v_digits; end if;
 if v_digits <> '' and length(v_digits) not between 12 and 15 then
  raise exception 'Informe o telefone com DDD (e o código do país, se não for do Brasil).' using errcode = '22023';
 end if;
 select key into v_old from mavi_private.user_phones where user_id = p_user;
 if v_digits = '' then
  delete from mavi_private.user_phones where user_id = p_user;
 else
  insert into mavi_private.user_phones(user_id, phone, key, updated_by) values (p_user, v_digits, mavi_private.phone_key(v_digits), auth.uid())
  on conflict (user_id) do update set phone = excluded.phone, key = excluded.key, updated_by = auth.uid(), updated_at = now();
 end if;
 -- As conversas em que esse número falou são lidas de novo (quem é time mudou).
 update public.temperature_signals s set status = 'pending', dirty_at = now() - interval '1 hour', attempts = 0
 from mavi_private.whatsapp_ai_days d, public.memberships m
 where m.user_id = p_user and s.company_id = m.company_id and s.source_type = 'whatsapp' and s.source_id = d.id
  and s.status in ('done', 'skipped', 'failed')
  and exists (select 1 from public.whatsapp_messages w where w.company_id = d.company_id and w.group_id = d.group_id
   and w.sent_at >= d.day::timestamp at time zone 'America/Sao_Paulo'
   and w.sent_at < (d.day + 1)::timestamp at time zone 'America/Sao_Paulo'
   and mavi_private.phone_key(w.sender_phone) in (v_old, mavi_private.phone_key(v_digits)));
 return nullif(v_digits, '');
end $$;

-- ------------------------------------------------------------ configuração
create table public.temperature_settings (
 company_id uuid primary key references public.companies(id),
 -- Faixas da nota (0 a 100, da mais baixa para a mais alta):
 -- [{name, min, color, alert}], a primeira começa em 0.
 bands jsonb not null,
 window_days integer not null default 60 check (window_days between 7 and 365),
 half_life_days integer not null default 21 check (half_life_days between 1 and 180),
 meeting_weight numeric not null default 2 check (meeting_weight between 0 and 10),
 whatsapp_weight numeric not null default 1 check (whatsapp_weight between 0 and 10),
 flag_threshold numeric not null default 0.7 check (flag_threshold between 0.5 and 0.99),
 flag_days integer not null default 14 check (flag_days between 1 and 90),
 -- Assuntos que mexem com o humor do cliente: [{key, label, neutral}].
 reasons jsonb not null,
 reason_question text not null check (length(btrim(reason_question)) between 10 and 300),
 alerts boolean not null default true,
 -- Versão das perguntas ao Jev (sobe quando uma pergunta muda).
 version integer not null default 1,
 questions_hash text not null default '',
 updated_by uuid,
 updated_at timestamptz not null default now()
);
alter table public.temperature_settings enable row level security;
revoke all on public.temperature_settings from public, anon, authenticated;

create table public.temperature_indicators (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 -- Nulo: da empresa. Com produto: só para os clientes que contratam o produto.
 product_id uuid,
 key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
 -- score: nota numa escala (entra na média) · flag: sinal de alerta (sim/não).
 kind text not null check (kind in ('score', 'flag')),
 name text not null check (length(btrim(name)) between 2 and 80),
 description text not null check (length(btrim(description)) between 10 and 1000),
 -- score: os níveis, do pior para o melhor (2 a 10).
 levels jsonb not null default '[]' check (jsonb_typeof(levels) = 'array'),
 weight numeric not null default 1 check (weight between 0 and 10),
 sources text[] not null default '{meeting,whatsapp}'
  check (cardinality(sources) between 1 and 2 and sources <@ array['meeting', 'whatsapp']),
 -- flag: avisar quando aparece.
 alert boolean not null default false,
 active boolean not null default true,
 position integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, key),
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade,
 check (kind = 'flag' and jsonb_array_length(levels) = 0 or kind = 'score' and jsonb_array_length(levels) between 2 and 10)
);
create index temperature_indicators_company on public.temperature_indicators (company_id, position);
alter table public.temperature_indicators enable row level security;
revoke all on public.temperature_indicators from public, anon, authenticated;

-- Ajuste de um indicador da empresa num produto: desligar ou outro peso.
create table public.temperature_product_rules (
 company_id uuid not null,
 product_id uuid not null,
 indicator_id uuid not null references public.temperature_indicators(id) on delete cascade,
 active boolean not null default true,
 weight numeric check (weight is null or weight between 0 and 10),
 primary key (product_id, indicator_id),
 foreign key (company_id, product_id) references public.products(company_id, id) on delete cascade
);
alter table public.temperature_product_rules enable row level security;
revoke all on public.temperature_product_rules from public, anon, authenticated;

-- A configuração inicial da empresa (só na primeira vez).
create function mavi_private.temperature_seed(c uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if exists (select 1 from public.temperature_settings where company_id = c) then return; end if;
 insert into public.temperature_settings(company_id, bands, reasons, reason_question) values (c,
  '[{"name":"Gelado","min":0,"color":"#2a78d6","alert":true},
    {"name":"Frio","min":30,"color":"#7fb2ea","alert":true},
    {"name":"Morno","min":50,"color":"#eda100","alert":false},
    {"name":"Quente","min":70,"color":"#eb6834","alert":false},
    {"name":"Fervendo","min":85,"color":"#e34948","alert":false}]',
  '[{"key":"resultados","label":"Resultados (leads, vendas, desempenho das campanhas)","neutral":false},
    {"key":"prazos","label":"Prazos e atrasos nas entregas","neutral":false},
    {"key":"qualidade","label":"Qualidade das entregas (artes, textos, vídeos, páginas)","neutral":false},
    {"key":"atendimento","label":"Atendimento e comunicação com o time","neutral":false},
    {"key":"financeiro","label":"Preço, custo, verba ou pagamento","neutral":false},
    {"key":"estrategia","label":"Estratégia, planejamento e próximos passos","neutral":false},
    {"key":"elogio","label":"Elogios e reconhecimento ao trabalho","neutral":false},
    {"key":"rotina","label":"Rotina: nada que mexa com o humor do cliente","neutral":true}]',
  'Qual assunto mais mexe com o humor do cliente neste material?')
 on conflict (company_id) do nothing;
 if exists (select 1 from public.temperature_indicators where company_id = c) then return; end if;
 insert into public.temperature_indicators(company_id, key, kind, name, description, levels, weight, sources, alert,
  position) values
 (c, 'satisfacao', 'score', 'Satisfação com resultados',
  'Como o cliente avalia os resultados que a agência entrega: leads, vendas, campanhas, conteúdo e o retorno do investimento.',
  '["Muito insatisfeito: reclama dos resultados e questiona o trabalho",
    "Insatisfeito: diz que os resultados estão abaixo do esperado",
    "Neutro: nem elogia nem reclama dos resultados",
    "Satisfeito: reconhece bons resultados",
    "Muito satisfeito: comemora e elogia os resultados"]', 3, '{meeting,whatsapp}', false, 1),
 (c, 'permanencia', 'score', 'Risco de cancelamento',
  'O quanto o cliente dá sinais de que vai continuar com a agência ou de que pode sair (cancelar, pausar, reduzir o contrato, trocar de agência).',
  '["Alto risco: fala em cancelar, pausar, reduzir o contrato ou trocar de agência",
    "Risco: compara com concorrentes, questiona o custo ou o valor do trabalho",
    "Incerto: sinais misturados",
    "Baixo risco: fala com naturalidade dos próximos meses",
    "Sem risco: fala em ampliar, renovar ou indicar a agência"]', 3, '{meeting,whatsapp}', false, 2),
 (c, 'relacao', 'score', 'Relação e comunicação',
  'O tom do cliente com o time: paciência, confiança, cordialidade, cobranças e reclamações sobre atendimento e prazos.',
  '["Hostil: tom agressivo, cobranças duras, reclama do atendimento",
    "Tensa: impaciência, cobra prazos ou respostas",
    "Cordial: tom neutro e profissional",
    "Boa: tom amigável e colaborativo",
    "Excelente: confiança, parceria e elogios ao time"]', 2, '{meeting,whatsapp}', false, 3),
 (c, 'engajamento', 'score', 'Engajamento',
  'O quanto o cliente participa: responde, aprova, envia material, aparece nas reuniões e puxa as próximas ações.',
  '["Ausente: não responde e não participa",
    "Baixo: responde pouco e com atraso, trava aprovações",
    "Regular: participa quando é chamado",
    "Alto: responde, aprova e envia material com agilidade",
    "Muito alto: propõe ideias e puxa as próximas ações"]', 2, '{meeting,whatsapp}', false, 4),
 (c, 'cancelamento', 'flag', 'Fala em cancelar',
  'O cliente fala em cancelar, pausar, encerrar o contrato, reduzir o escopo ou trocar de agência?',
  '[]', 1, '{meeting,whatsapp}', true, 5),
 (c, 'cobranca_prazo', 'flag', 'Reclama de atraso',
  'O cliente reclama de atraso, de prazo não cumprido ou de demora nas entregas ou nas respostas?',
  '[]', 1, '{meeting,whatsapp}', false, 6),
 (c, 'financeiro', 'flag', 'Questiona o custo',
  'O cliente reclama do preço, questiona o custo ou o retorno, pede desconto ou fala em cortar a verba?',
  '[]', 1, '{meeting,whatsapp}', false, 7);
 update public.temperature_settings set questions_hash = md5(mavi_private.temperature_questions(c)::text)
 where company_id = c;
end $$;

-- As perguntas ao Jev (todas as ativas: da empresa e dos produtos). O que
-- vale para cada cliente é decidido no cálculo.
create function mavi_private.temperature_questions(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object(
  'indicators', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'kind', i.kind, 'name', i.name,
     'description', i.description, 'levels', i.levels, 'sources', to_jsonb(i.sources)) order by i.key)
    from public.temperature_indicators i where i.company_id = c and i.active), '[]'),
  'reasons', (select jsonb_agg(jsonb_build_object('key', r->>'key', 'label', r->>'label') order by n)
    from public.temperature_settings s, jsonb_array_elements(s.reasons) with ordinality x(r, n) where s.company_id = c),
  'reason_question', (select s.reason_question from public.temperature_settings s where s.company_id = c))
$$;

-- ------------------------------------------------------------ leituras
create table public.temperature_signals (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null,
 client_id uuid not null,
 source_type text not null check (source_type in ('meeting', 'whatsapp')),
 -- Reunião: a gravação. WhatsApp: o dia do grupo (mavi_private.whatsapp_ai_days).
 source_id uuid not null,
 group_id uuid,
 -- WhatsApp: a primeira mensagem do cliente no dia (o link abre a conversa ali).
 message_id uuid,
 title text not null default '',
 occurred_at timestamptz not null,
 day date not null,
 status text not null default 'pending' check (status in ('pending', 'done', 'skipped', 'failed')),
 dirty_at timestamptz,
 claimed_at timestamptz,
 claimed_until timestamptz,
 attempts integer not null default 0,
 last_error text,
 -- Versão das perguntas da última leitura.
 version integer,
 -- {chave: {v: nota 0–100, c: confiança, e: evidência}} dos indicadores.
 answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
 -- {chave: probabilidade} dos sinais de alerta.
 flags jsonb not null default '{}' check (jsonb_typeof(flags) = 'object'),
 -- {key, p: {assunto: probabilidade}}.
 reason jsonb,
 excerpt text not null default '',
 client_lines integer not null default 0,
 cost_usd numeric not null default 0,
 evaluated_at timestamptz,
 created_at timestamptz not null default now(),
 unique (company_id, source_type, source_id),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index temperature_signals_client on public.temperature_signals (client_id, day);
create index temperature_signals_due on public.temperature_signals (dirty_at) where status = 'pending';
alter table public.temperature_signals enable row level security;
revoke all on public.temperature_signals from public, anon, authenticated;

-- O que cada cliente mostra hoje e o que falta calcular.
create table mavi_private.temperature_state (
 client_id uuid primary key,
 company_id uuid not null,
 -- Recalcular a partir deste dia (nulo: em dia).
 refresh_from date,
 refreshing_until timestamptz,
 score numeric,
 band integer,
 current jsonb,
 refreshed_at timestamptz,
 -- Avisos ligados (o histórico já foi lido): a primeira vez só marca a base.
 ready boolean not null default false,
 alerted_band integer,
 alerted_flags text[] not null default '{}',
 summary text,
 summary_at timestamptz,
 summary_score numeric,
 summary_band integer,
 summary_flags text[] not null default '{}',
 summary_pending boolean not null default false,
 summary_attempts integer not null default 0,
 summary_until timestamptz,
 summary_error text
);
create index temperature_state_refresh on mavi_private.temperature_state (refresh_from) where refresh_from is not null;
create index temperature_state_summary on mavi_private.temperature_state (company_id) where summary_pending;
revoke all on mavi_private.temperature_state from public, anon, authenticated;

-- A temperatura de cada dia (o gráfico e os Dashboards).
create table public.temperature_days (
 company_id uuid not null,
 client_id uuid not null,
 day date not null,
 score numeric(5, 1),
 -- Índice da faixa (0 = a mais baixa).
 band integer,
 indicators jsonb not null default '{}',
 flags text[] not null default '{}',
 signals integer not null default 0,
 primary key (client_id, day),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index temperature_days_company on public.temperature_days (company_id, day);
alter table public.temperature_days enable row level security;
revoke all on public.temperature_days from public, anon, authenticated;

-- O cliente precisa recalcular a partir do dia.
create function mavi_private.temperature_mark(c uuid, p_client uuid, p_day date) returns void
language sql security definer set search_path = '' as $$
 insert into mavi_private.temperature_state(client_id, company_id, refresh_from)
 values (p_client, c, coalesce(p_day, current_date))
 on conflict (client_id) do update set refresh_from = least(coalesce(mavi_private.temperature_state.refresh_from,
  excluded.refresh_from), excluded.refresh_from)
$$;

-- O documento da MAVI de uma reunião ou de um dia de grupo mudou: a leitura
-- fica pendente (ou sai, com o documento).
create function mavi_private.temperature_touch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_tz text; v_day date; v_group uuid; o public.temperature_signals; begin
 if tg_op = 'DELETE' then
  if old.source_type in ('meeting', 'whatsapp') then
   delete from public.temperature_signals where company_id = old.company_id and source_type = old.source_type
    and source_id = old.source_id returning * into o;
   if o.id is not null then perform mavi_private.temperature_mark(o.company_id, o.client_id, o.day); end if;
  end if;
  return null;
 end if;
 if new.source_type not in ('meeting', 'whatsapp') then return null; end if;
 select * into o from public.temperature_signals where company_id = new.company_id and source_type = new.source_type
  and source_id = new.source_id;
 if new.client_id is null then
  if o.id is not null then
   delete from public.temperature_signals where id = o.id;
   perform mavi_private.temperature_mark(o.company_id, o.client_id, o.day);
  end if;
  return null;
 end if;
 if new.source_type = 'whatsapp' then
  select d.day, d.group_id into v_day, v_group from mavi_private.whatsapp_ai_days d where d.id = new.source_id;
 else
  select timezone into v_tz from public.companies where id = new.company_id;
  v_day := (coalesce(new.occurred_at, now()) at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 end if;
 v_day := coalesce(v_day, current_date);
 insert into public.temperature_signals(company_id, client_id, source_type, source_id, group_id, title, occurred_at,
  day, status, dirty_at)
 values (new.company_id, new.client_id, new.source_type, new.source_id, v_group, left(coalesce(new.title, ''), 300),
  coalesce(new.occurred_at, now()), v_day, 'pending', now())
 on conflict (company_id, source_type, source_id) do update set client_id = excluded.client_id,
  group_id = excluded.group_id, title = excluded.title, occurred_at = excluded.occurred_at, day = excluded.day,
  status = 'pending', dirty_at = now(), attempts = 0, last_error = null;
 -- Mudou de cliente: o antigo perde a leitura.
 if o.id is not null and o.client_id <> new.client_id then
  update public.temperature_signals set answers = '{}', flags = '{}', reason = null
  where company_id = new.company_id and source_type = new.source_type and source_id = new.source_id;
  perform mavi_private.temperature_mark(o.company_id, o.client_id, o.day);
 end if;
 return null;
end $$;
create trigger ai_documents_temperature after insert or update of content_hash, client_id or delete
 on public.ai_documents for each row execute function mavi_private.temperature_touch();

-- ------------------------------------------------------------ cálculo
-- Os indicadores que valem para um cliente, com o peso do cliente: os da
-- empresa (a menos que todos os produtos dele desliguem; o peso é a média
-- dos pesos dos produtos que o mantêm) e os dos produtos que ele contrata.
create function mavi_private.temperature_client_indicators(c uuid, p_client uuid)
returns table(id uuid, key text, kind text, name text, description text, levels jsonb, weight numeric,
 alert boolean, product_id uuid, "position" integer)
language sql stable security definer set search_path = '' as $$
 with prods as (
  select distinct k.product_id from public.contracts k
  where k.company_id = c and k.client_id = p_client and not k.archived
 )
 select i.id, i.key, i.kind, i.name, i.description, i.levels,
  case when i.product_id is null and exists (select 1 from prods) then
   coalesce((select avg(coalesce(r.weight, i.weight)) from prods
    left join public.temperature_product_rules r on r.product_id = prods.product_id and r.indicator_id = i.id
    where coalesce(r.active, true)), i.weight)
  else i.weight end,
  i.alert, i.product_id, i.position
 from public.temperature_indicators i
 where i.company_id = c and i.active and (
  (i.product_id is null and (not exists (select 1 from prods) or exists (select 1 from prods
    left join public.temperature_product_rules r on r.product_id = prods.product_id and r.indicator_id = i.id
    where coalesce(r.active, true))))
  or i.product_id in (select product_id from prods))
$$;

-- A faixa de uma nota (índice; nulo sem nota).
create function mavi_private.temperature_band(p_bands jsonb, p_score numeric) returns integer
language sql immutable set search_path = '' as $$
 select case when p_score is null then null else
  (select max(n)::integer - 1 from jsonb_array_elements(p_bands) with ordinality x(b, n)
   where (b->>'min')::numeric <= p_score) end
$$;

-- A temperatura de cada dia de um período, das leituras da janela.
create function mavi_private.temperature_series(c uuid, p_client uuid, p_from date, p_to date)
returns table(day date, score numeric, indicators jsonb, flags text[], signals integer)
language sql stable security definer set search_path = '' as $$
 with s as (select * from public.temperature_settings where company_id = c),
 ind as (select * from mavi_private.temperature_client_indicators(c, p_client)),
 days as (select d::date as day from generate_series(p_from, p_to, interval '1 day') d),
 sig as (
  select x.id, x.source_type, x.day, x.answers, x.flags from public.temperature_signals x, s
  where x.client_id = p_client and x.status <> 'skipped' and x.answers <> '{}'
   and x.day between p_from - greatest(s.window_days, s.flag_days) + 1 and p_to
 ),
 contrib as (
  select d.day, a.key, (a.value->>'v')::numeric as v,
   (case g.source_type when 'meeting' then s.meeting_weight else s.whatsapp_weight end)
    * power(0.5, (d.day - g.day)::numeric / s.half_life_days) as base,
   least(greatest(coalesce((a.value->>'e')::numeric, 1), 0), 1) as e,
   least(greatest(coalesce((a.value->>'c')::numeric, 1), 0.05), 1) as conf
  from days d cross join s
  join sig g on g.day between d.day - s.window_days + 1 and d.day
  cross join lateral jsonb_each(g.answers) a
  where jsonb_typeof(a.value->'v') = 'number'
 ),
 per as (
  select contrib.day, contrib.key, sum(base * e * conf * v) / nullif(sum(base * e * conf), 0) as val,
   sum(base * e) as evidence
  from contrib join ind on ind.key = contrib.key and ind.kind = 'score'
  where e >= 0.15
  group by 1, 2
 ),
 ok as (select * from per where evidence >= 0.3 and val is not null),
 overall as (
  select ok.day, sum(ind.weight * ok.val) / nullif(sum(ind.weight), 0) as score,
   jsonb_object_agg(ok.key, round(ok.val, 1)) as indicators
  from ok join ind on ind.key = ok.key
  group by ok.day
 ),
 fl as (
  select d.day, array_agg(distinct f.key order by f.key) as flags
  from days d cross join s
  join sig g on g.day between d.day - s.flag_days + 1 and d.day
  cross join lateral jsonb_each_text(g.flags) f
  join ind on ind.key = f.key and ind.kind = 'flag'
  where f.value ~ '^[0-9.]+$' and f.value::numeric >= s.flag_threshold
  group by d.day
 ),
 cnt as (
  select d.day, count(g.id)::integer as n from days d cross join s
  left join sig g on g.day between d.day - s.window_days + 1 and d.day
  group by d.day
 )
 select d.day, round(o.score, 1), coalesce(o.indicators, '{}'), coalesce(fl.flags, '{}'), coalesce(cnt.n, 0)
 from days d
 left join overall o on o.day = d.day
 left join fl on fl.day = d.day
 left join cnt on cnt.day = d.day
$$;

-- Quem recebe os avisos de um cliente: os supervisores das equipes que o
-- atendem; sem nenhum, os administradores.
create function mavi_private.temperature_recipients(c uuid, p_client uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
 select coalesce(
  (select array_agg(distinct tm.user_id) from public.client_teams ct
   join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id and tm.supervisor
   join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
   where ct.company_id = c and ct.client_id = p_client),
  (select array_agg(m.user_id) from public.memberships m where m.company_id = c and m.active and m.role = 'admin'),
  '{}')
$$;

create function mavi_private.temperature_notify(c uuid, p_client uuid, p_title text, p_body text) returns void
language sql security definer set search_path = '' as $$
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select c, u, null, null, 'temperature', left(p_title, 300), left(p_body, 300), '/drive?termometro=' || p_client
 from unnest(mavi_private.temperature_recipients(c, p_client)) u
$$;

-- Recalcula um cliente a partir de refresh_from, atualiza o que ele mostra
-- hoje e decide o aviso e o texto da MAVI.
create function mavi_private.temperature_refresh_client(p_client uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.temperature_state; s public.temperature_settings; v_tz text; v_today date; v_first date;
 v_from date; t public.temperature_days; v_band integer; v_current jsonb; v_backlog boolean; v_alert_flags text[];
 v_new_flags text[]; v_name text; v_bname text; v_prev_name text; v_body text; begin
 select * into st from mavi_private.temperature_state where client_id = p_client for update;
 if not found then return; end if;
 perform mavi_private.temperature_seed(st.company_id);
 select * into s from public.temperature_settings where company_id = st.company_id;
 select timezone into v_tz from public.companies where id = st.company_id;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 select min(x.day) into v_first from public.temperature_signals x
 where x.client_id = p_client and x.status <> 'skipped' and x.answers <> '{}';
 if v_first is null then
  delete from public.temperature_days where client_id = p_client;
  update mavi_private.temperature_state set refresh_from = null, refreshing_until = null, score = null, band = null,
   current = null, refreshed_at = now()
  where client_id = p_client;
  return;
 end if;
 v_from := greatest(coalesce(st.refresh_from, v_today), v_first);
 -- Primeiro cálculo, ou dias sem cálculo até hoje: preenche desde o começo do buraco.
 v_from := least(v_from, coalesce((select max(d.day) + 1 from public.temperature_days d where d.client_id = p_client
  and d.day >= v_first), v_first));
 if v_from > v_today then v_from := v_today; end if;
 delete from public.temperature_days where client_id = p_client and (day >= v_from or day < v_first);
 insert into public.temperature_days(company_id, client_id, day, score, band, indicators, flags, signals)
 select st.company_id, p_client, x.day, x.score, mavi_private.temperature_band(s.bands, x.score), x.indicators,
  x.flags, x.signals
 from mavi_private.temperature_series(st.company_id, p_client, v_from, v_today) x;

 select * into t from public.temperature_days where client_id = p_client and day = v_today;
 v_band := t.band;
 v_current := jsonb_build_object('day', v_today, 'score', t.score, 'band', t.band, 'signals', t.signals,
  'score_d7', t.score - (select d.score from public.temperature_days d where d.client_id = p_client
    and d.day = v_today - 7),
  'score_d30', t.score - (select d.score from public.temperature_days d where d.client_id = p_client
    and d.day = v_today - 30),
  'indicators', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'name', i.name,
     'value', (t.indicators->>i.key)::numeric, 'weight', round(i.weight, 2),
     'd7', (t.indicators->>i.key)::numeric - (select (d.indicators->>i.key)::numeric from public.temperature_days d
       where d.client_id = p_client and d.day = v_today - 7),
     'd30', (t.indicators->>i.key)::numeric - (select (d.indicators->>i.key)::numeric from public.temperature_days d
       where d.client_id = p_client and d.day = v_today - 30))
    order by i.position, i.name)
   from mavi_private.temperature_client_indicators(st.company_id, p_client) i where i.kind = 'score'), '[]'),
  'flags', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'name', i.name, 'alert', i.alert,
     'p', f.p, 'at', f.at) order by f.at desc)
   from mavi_private.temperature_client_indicators(st.company_id, p_client) i
   join lateral (select max((g.flags->>i.key)::numeric) as p, max(g.occurred_at) as at
     from public.temperature_signals g
     where g.client_id = p_client and g.status <> 'skipped' and g.day between v_today - s.flag_days + 1 and v_today
      and g.flags->>i.key ~ '^[0-9.]+$' and (g.flags->>i.key)::numeric >= s.flag_threshold) f on f.p is not null
   where i.kind = 'flag'), '[]'),
  'reasons', coalesce((select jsonb_agg(jsonb_build_object('key', r.key, 'label', r.label, 'share', r.share)
     order by r.share desc)
   from (
    select q.key, q.label, round(100 * q.w / nullif(sum(q.w) over (), 0)) as share from (
     select o->>'key' as key, o->>'label' as label, coalesce((o->>'neutral')::boolean, false) as neutral,
      sum((case g.source_type when 'meeting' then s.meeting_weight else s.whatsapp_weight end)
       * power(0.5, (v_today - g.day)::numeric / s.half_life_days)
       * coalesce((g.reason->'p'->>(o->>'key'))::numeric, 0)) as w
     from jsonb_array_elements(s.reasons) o
     cross join public.temperature_signals g
     where g.client_id = p_client and g.status <> 'skipped' and g.reason is not null
      and g.day between v_today - s.window_days + 1 and v_today
     group by 1, 2, 3
    ) q where not q.neutral and q.w > 0
    order by q.w desc limit 3
   ) r), '[]'));

 -- Enquanto o histórico ainda está sendo lido, nada de aviso nem de texto.
 v_backlog := exists (select 1 from public.temperature_signals g where g.client_id = p_client
  and g.status = 'pending' and g.day < v_today - 3);
 select coalesce(array_agg(x->>'key' order by x->>'key'), '{}') into v_alert_flags
 from jsonb_array_elements(v_current->'flags') x where (x->>'alert')::boolean;

 if not v_backlog and st.ready and s.alerts then
  select name into v_name from public.clients where id = p_client;
  v_bname := case when v_band is not null then s.bands->v_band->>'name' end;
  if v_band is not null and coalesce((s.bands->v_band->>'alert')::boolean, false)
   and (st.alerted_band is null or v_band < st.alerted_band) then
   v_prev_name := case when st.alerted_band is not null then s.bands->st.alerted_band->>'name' end;
   v_body := coalesce((select string_agg(format('%s em %s', x->>'name', round((x->>'value')::numeric)), ' · ')
     from (select x from jsonb_array_elements(v_current->'indicators') x
      where x->>'value' is not null order by (x->>'value')::numeric limit 2) q), '');
   perform mavi_private.temperature_notify(st.company_id, p_client,
    format('Cliente %s esfriou: %s (%s)', v_name, v_bname, round(t.score)),
    concat_ws(' · ', case when v_prev_name is not null then 'Antes: ' || v_prev_name end, nullif(v_body, '')));
  end if;
  select coalesce(array_agg(f), '{}') into v_new_flags from unnest(v_alert_flags) f where not (f = any(st.alerted_flags));
  if cardinality(v_new_flags) > 0 then
   perform mavi_private.temperature_notify(st.company_id, p_client,
    format('Cliente %s: %s', v_name, (select string_agg(x->>'name', ', ') from jsonb_array_elements(v_current->'flags') x
      where x->>'key' = any(v_new_flags))),
    format('Temperatura: %s%s', coalesce(v_bname, 'sem nota'),
     case when t.score is not null then ' (' || round(t.score) || ')' else '' end));
  end if;
 end if;

 update mavi_private.temperature_state set refresh_from = null, refreshing_until = null, score = t.score,
  band = v_band, current = v_current, refreshed_at = now(),
  ready = not v_backlog,
  alerted_band = case when v_backlog then alerted_band else v_band end,
  alerted_flags = case when v_backlog then alerted_flags else v_alert_flags end,
  summary_pending = summary_pending or (not v_backlog and t.score is not null and (summary_at is null
   or v_band is distinct from summary_band or abs(t.score - coalesce(summary_score, -100)) >= 8
   or v_alert_flags is distinct from summary_flags)),
  summary_attempts = case when not v_backlog and v_band is distinct from summary_band then 0 else summary_attempts end
 where client_id = p_client;
end $$;

-- Todo dia: a idade das leituras muda a temperatura de quem tem leituras.
create function mavi_private.temperature_daily() returns void
language sql security definer set search_path = '' as $$
 update mavi_private.temperature_state st set refresh_from = least(coalesce(st.refresh_from, current_date), current_date)
 where st.score is not null or exists (select 1 from public.temperature_days d where d.client_id = st.client_id)
$$;

-- ------------------------------------------------------------ o material de uma leitura
-- Nome sem acento, em minúsculas e sem pontuação (para achar quem é do time
-- entre os falantes da reunião).
create function mavi_private.temperature_norm(p text) returns text
language sql immutable set search_path = '' as $$
 select btrim(regexp_replace(regexp_replace(lower(translate(coalesce(p, ''),
  'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ', 'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn')),
  '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

create function mavi_private.temperature_is_team(p_speaker text, p_names text[]) returns boolean
language sql immutable set search_path = '' as $$
 select exists (select 1 from unnest(p_names) n
  where n <> '' and mavi_private.temperature_norm(p_speaker) <> '' and (
   n = mavi_private.temperature_norm(p_speaker)
   or (strpos(mavi_private.temperature_norm(p_speaker), ' ') > 0
    and n like mavi_private.temperature_norm(p_speaker) || ' %')
   or (strpos(n, ' ') > 0 and mavi_private.temperature_norm(p_speaker) like n || ' %')
   or (strpos(n, ' ') > 0 and strpos(mavi_private.temperature_norm(p_speaker), ' ') > 0
    and split_part(n, ' ', 1) = split_part(mavi_private.temperature_norm(p_speaker), ' ', 1)
    and regexp_replace(n, '^.* ', '') = regexp_replace(mavi_private.temperature_norm(p_speaker), '^.* ', ''))))
$$;

-- O texto longo fica com o começo e o fim (o Jev lê até ~32 mil tokens).
create function mavi_private.temperature_clip(p text, p_max integer) returns text
language sql immutable set search_path = '' as $$
 select case when length(p) <= p_max then p
  else left(p, p_max / 3) || E'\n[… trecho do meio omitido …]\n' || right(p, p_max - p_max / 3) end
$$;

-- O "estado" que o Jev lê de uma leitura (e o trecho para a tela). Nulo:
-- não há o que ler; state nulo: não há fala do cliente.
create function mavi_private.temperature_material(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare g public.temperature_signals; r record; v_names text[]; v_keys text[]; v_lines text;
 v_client_lines integer; v_first uuid; v_excerpt text; v_summary text; v_team text[]; v_other text[];
 v_products text; v_from timestamptz; v_to timestamptz; begin
 select * into g from public.temperature_signals where id = p_id;
 if not found then return null; end if;
 select coalesce(string_agg(distinct pr.name, ', '), '') into v_products from public.contracts k
 join public.products pr on pr.company_id = k.company_id and pr.id = k.product_id
 where k.company_id = g.company_id and k.client_id = g.client_id and not k.archived;

 if g.source_type = 'meeting' then
  select mr.*, t.speakers as t_speakers, t.segments into r from public.meeting_recordings mr
  left join public.meeting_transcripts t on t.company_id = mr.company_id and t.recording_id = mr.id
  where mr.company_id = g.company_id and mr.id = g.source_id;
  if not found then return null; end if;
  -- Os nomes do time (e quem gravou).
  select coalesce(array_agg(distinct mavi_private.temperature_norm(x.name)), '{}') into v_names
  from public.memberships x where x.company_id = g.company_id;
  with seg as (
   select e.n, btrim(coalesce(e.s->>3, '')) as txt,
    coalesce(nullif(r.t_speakers[((e.s->>2)::integer) + 1], ''), 'Falante ' || (coalesce((e.s->>2)::integer, 0) + 1)) as who
   from jsonb_array_elements(coalesce(r.segments, '[]')) with ordinality e(s, n)
  ), roles as (
   select q.who, case when q.who ~ '^Falante \d+$' then 'não identificado'
    when mavi_private.temperature_is_team(q.who, v_names)
     or exists (select 1 from public.memberships x where x.company_id = g.company_id
      and lower(x.email) = lower(r.recorded_by_email)
      and mavi_private.temperature_is_team(q.who, array[mavi_private.temperature_norm(x.name)])) then 'time'
    else 'cliente' end as role
   from (select distinct seg.who from seg) q
  )
  select string_agg(format('[%s] %s: %s', ro.role, seg.who, seg.txt), E'\n' order by seg.n),
   count(*) filter (where ro.role <> 'time'),
   coalesce(array_agg(distinct seg.who) filter (where ro.role = 'time'), '{}'),
   coalesce(array_agg(distinct seg.who) filter (where ro.role = 'cliente'), '{}'),
   left(string_agg(seg.txt, ' ' order by seg.n) filter (where ro.role <> 'time'), 500)
  into v_lines, v_client_lines, v_team, v_other, v_excerpt
  from seg join roles ro on ro.who = seg.who;
  v_summary := concat_ws(E'\n',
   case when r.summary->>'overview' is not null then 'Resumo: ' || (r.summary->>'overview') end,
   (select string_agg('- ' || (nt->>'title') || ': ' || (nt->>'description'), E'\n')
     from jsonb_array_elements(coalesce(r.summary->'notes', '[]')) nt));
  if btrim(coalesce(v_lines, '')) = '' and btrim(coalesce(v_summary, '')) = '' then return null; end if;
  if nullif(r.summary->>'overview', '') is not null then v_excerpt := left(r.summary->>'overview', 500); end if;
  return jsonb_build_object('client_lines', greatest(coalesce(v_client_lines, 0),
    case when coalesce(v_summary, '') <> '' then 1 else 0 end),
   'message_id', null, 'excerpt', left(coalesce(v_excerpt, ''), 500),
   'state', jsonb_strip_nulls(jsonb_build_object(
    'fonte', 'Reunião gravada com o cliente (transcrição automática: nomes e palavras podem sair errados)',
    'cliente', (select name from public.clients where id = g.client_id),
    'produtos_contratados', nullif(v_products, ''),
    'data', to_char(r.recorded_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'),
    'titulo', coalesce(nullif(r.summary->>'title', ''), nullif(r.title, ''), 'Reunião'),
    'participantes_do_time', case when cardinality(v_team) > 0 then to_jsonb(v_team) end,
    'participantes_do_cliente', case when cardinality(v_other) > 0 then to_jsonb(v_other) end,
    'resumo', nullif(left(coalesce(v_summary, ''), 6000), ''),
    'legenda', 'Cada fala começa com [time] (a agência), [cliente] ou [não identificado]. Avalie o cliente.',
    'transcricao', nullif(mavi_private.temperature_clip(coalesce(v_lines, ''), 60000), ''))));
 end if;

 -- WhatsApp: as mensagens do dia do grupo, marcadas por quem mandou.
 select d.*, wg.title as group_title into r from mavi_private.whatsapp_ai_days d
 join public.whatsapp_groups wg on wg.company_id = d.company_id and wg.id = d.group_id
 where d.id = g.source_id;
 if not found then return null; end if;
 v_keys := mavi_private.team_phone_keys(g.company_id);
 v_from := r.day::timestamp at time zone 'America/Sao_Paulo';
 v_to := (r.day + 1)::timestamp at time zone 'America/Sao_Paulo';
 with msg as (
  select w.id, w.sent_at, w.kind, mavi_private.whatsapp_line(w) as line, mavi_private.whatsapp_sender(w) as who,
   case when w.from_me or mavi_private.phone_key(w.sender_phone) = any(v_keys) then 'time' else 'cliente' end as role
  from public.whatsapp_messages w
  where w.company_id = r.company_id and w.group_id = r.group_id and w.sent_at >= v_from and w.sent_at < v_to
 )
 select string_agg(format('%s [%s] %s: %s', to_char(msg.sent_at at time zone 'America/Sao_Paulo', 'HH24:MI'),
   msg.role, msg.who, msg.line), E'\n' order by msg.sent_at, msg.id),
  count(*) filter (where msg.role = 'cliente' and msg.kind <> 'reaction'),
  (array_agg(msg.id order by msg.sent_at, msg.id) filter (where msg.role = 'cliente' and msg.kind <> 'reaction'))[1],
  left(string_agg(left(msg.line, 300), ' · ' order by msg.sent_at, msg.id)
   filter (where msg.role = 'cliente' and msg.kind <> 'reaction'), 500)
 into v_lines, v_client_lines, v_first, v_excerpt
 from msg where coalesce(msg.line, '') <> '';
 if coalesce(v_client_lines, 0) = 0 then
  return jsonb_build_object('client_lines', 0, 'message_id', null, 'excerpt', '', 'state', null);
 end if;
 return jsonb_build_object('client_lines', v_client_lines, 'message_id', v_first, 'excerpt', coalesce(v_excerpt, ''),
  'state', jsonb_strip_nulls(jsonb_build_object(
   'fonte', 'Grupo de WhatsApp da agência com o cliente (áudios aparecem transcritos)',
   'cliente', (select name from public.clients where id = g.client_id),
   'produtos_contratados', nullif(v_products, ''),
   'grupo', r.group_title,
   'data', to_char(r.day, 'DD/MM/YYYY'),
   'legenda', 'Cada mensagem traz o horário e [time] (a agência) ou [cliente]. Avalie o cliente.',
   'conversa', case when length(v_lines) > 60000 then '[… mensagens anteriores omitidas …]' || E'\n' || right(v_lines, 60000)
    else v_lines end)));
end $$;

-- ------------------------------------------------------------ worker
-- O que o worker pergunta ao Jev numa empresa, e com qual chave.
create function public.ai_temperature_config(p_secret text, p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.temperature_seed(p_company);
 return jsonb_build_object('version', (select version from public.temperature_settings where company_id = p_company),
  'questions', mavi_private.temperature_questions(p_company), 'route', mavi_private.temperature_route(p_company));
end $$;

-- Leituras pendentes paradas há 20 min (o dia do grupo ainda recebe
-- mensagens), só de empresas com Jev. Dias sem fala do cliente saem aqui
-- mesmo, sem ir ao Jev.
create function public.ai_temperature_claim(p_secret text, p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g record; v_mat jsonb; v_out jsonb := '[]'; v_version integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for g in
  with due as (
   select x.id from public.temperature_signals x
   join public.clients k on k.id = x.client_id and not k.archived
   where x.status = 'pending' and x.dirty_at <= now() - interval '20 minutes'
    and (x.claimed_until is null or x.claimed_until < now())
    and x.company_id in (select co.id from public.companies co where mavi_private.temperature_route(co.id) is not null)
   order by x.occurred_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 60)
   for update of x skip locked
  )
  update public.temperature_signals x set claimed_at = now(), claimed_until = now() + interval '5 minutes'
  from due where x.id = due.id
  returning x.*
 loop
  v_mat := mavi_private.temperature_material(g.id);
  if v_mat is null or v_mat->'state' is null or jsonb_typeof(v_mat->'state') <> 'object' then
   update public.temperature_signals set status = 'skipped', answers = '{}', flags = '{}', reason = null,
    client_lines = 0, claimed_until = null, evaluated_at = now()
   where id = g.id;
   perform mavi_private.temperature_mark(g.company_id, g.client_id, g.day);
   continue;
  end if;
  perform mavi_private.temperature_seed(g.company_id);
  select version into v_version from public.temperature_settings where company_id = g.company_id;
  v_out := v_out || jsonb_build_object('id', g.id, 'company_id', g.company_id, 'client_id', g.client_id,
   'source_type', g.source_type, 'version', v_version, 'state', v_mat->'state',
   'excerpt', v_mat->>'excerpt', 'message_id', v_mat->'message_id', 'client_lines', v_mat->'client_lines');
 end loop;
 return v_out;
end $$;

-- As respostas do Jev: [{id, version, answers, flags, reason, excerpt,
-- message_id, client_lines, cost, model, provider_id, provider}]. Leitura com
-- versão velha (a configuração mudou no meio) fica pendente; material novo
-- durante a leitura também.
create function public.ai_temperature_store(p_secret text, p_results jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare r jsonb; g public.temperature_signals; v_version integer; v_n integer := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for r in select * from jsonb_array_elements(case when jsonb_typeof(p_results) = 'array' then p_results else '[]' end) loop
  continue when coalesce(r->>'id', '') !~* '^[0-9a-f-]{36}$';
  select * into g from public.temperature_signals where id = (r->>'id')::uuid for update;
  continue when not found;
  select version into v_version from public.temperature_settings where company_id = g.company_id;
  if (r->>'version')::integer is distinct from v_version then
   update public.temperature_signals set claimed_until = null where id = g.id;
   continue;
  end if;
  update public.temperature_signals set
   answers = case when jsonb_typeof(r->'answers') = 'object' then r->'answers' else '{}' end,
   flags = case when jsonb_typeof(r->'flags') = 'object' then r->'flags' else '{}' end,
   reason = case when jsonb_typeof(r->'reason') = 'object' then r->'reason' end,
   excerpt = left(coalesce(r->>'excerpt', ''), 500),
   message_id = case when r->>'message_id' ~* '^[0-9a-f-]{36}$' then (r->>'message_id')::uuid end,
   client_lines = greatest(coalesce((r->>'client_lines')::integer, 0), 0),
   cost_usd = least(greatest(coalesce((r->>'cost')::numeric, 0), 0), 10),
   version = v_version, evaluated_at = now(), attempts = 0, last_error = null, claimed_until = null,
   status = case when g.dirty_at > g.claimed_at then 'pending' else 'done' end
  where id = g.id;
  perform mavi_private.temperature_mark(g.company_id, g.client_id, g.day);
  v_n := v_n + 1;
 end loop;
 -- O custo, somado por cliente.
 insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, cost_usd, provider_id,
  provider_name)
 select gg.company_id, null, 'clients', 'temperature', gg.client_id, left(max(coalesce(rr->>'model', '')), 80),
  sum(greatest(coalesce((rr->>'input')::integer, 0), 0)), least(sum(least(greatest(coalesce((rr->>'cost')::numeric, 0), 0), 10)), 100),
  max(case when rr->>'provider_id' ~* '^[0-9a-f-]{36}$' then rr->>'provider_id' end)::uuid,
  left(max(coalesce(rr->>'provider', '')), 120)
 from jsonb_array_elements(case when jsonb_typeof(p_results) = 'array' then p_results else '[]' end) rr
 join public.temperature_signals gg on gg.id::text = rr->>'id'
 group by gg.company_id, gg.client_id;
 return v_n;
end $$;

-- Falhou: tenta de novo mais tarde (até 5 vezes).
create function public.ai_temperature_fail(p_secret text, p_id uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.temperature_signals set attempts = attempts + 1, last_error = left(coalesce(p_error, ''), 500),
  claimed_until = now() + (attempts + 1) * interval '10 minutes',
  status = case when attempts + 1 >= 5 then 'failed' else status end
 where id = p_id;
end $$;

-- Recalcula alguns clientes (os de leitura nova, os da mudança de
-- configuração e os do dia que virou). Enquanto o histórico do cliente ainda
-- está sendo lido, no máximo a cada 10 minutos (cada lote de leituras antigas
-- refaria o histórico inteiro).
create function mavi_private.temperature_refresh_due(st mavi_private.temperature_state) returns boolean
language sql stable security definer set search_path = '' as $$
 select st.refresh_from is not null and (st.refreshing_until is null or st.refreshing_until < now())
  and (st.refreshed_at is null or st.refreshed_at < now() - interval '10 minutes'
   or not exists (select 1 from public.temperature_signals g where g.client_id = st.client_id
    and g.status = 'pending' and g.day < current_date - 3))
$$;

create function public.ai_temperature_refresh(p_secret text, p_limit integer default 20) returns integer
language plpgsql security definer set search_path = '' as $$
declare v_client uuid; v_n integer := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for v_client in
  with due as (
   select st.client_id from mavi_private.temperature_state st
   where st.refresh_from is not null and mavi_private.temperature_refresh_due(st)
   order by st.refresh_from desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100)
   for update skip locked
  )
  update mavi_private.temperature_state st set refreshing_until = now() + interval '2 minutes'
  from due where st.client_id = due.client_id
  returning st.client_id
 loop
  perform mavi_private.temperature_refresh_client(v_client);
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

-- Os clientes que pedem o texto da MAVI, com o que ela precisa.
create function public.ai_temperature_summary_claim(p_secret text, p_limit integer default 6) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st record; s public.temperature_settings; v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for st in
  with due as (
   select x.client_id from mavi_private.temperature_state x
   join public.clients k on k.id = x.client_id and not k.archived
   where x.summary_pending and x.summary_attempts < 5 and x.refresh_from is null
    and (x.summary_until is null or x.summary_until < now())
   limit least(greatest(coalesce(p_limit, 6), 1), 20)
   for update of x skip locked
  )
  update mavi_private.temperature_state x set summary_until = now() + interval '4 minutes'
  from due where x.client_id = due.client_id
  returning x.*
 loop
  select * into s from public.temperature_settings where company_id = st.company_id;
  v_out := v_out || jsonb_build_object('client_id', st.client_id, 'company_id', st.company_id,
   'client_name', (select name from public.clients where id = st.client_id),
   'products', (select coalesce(string_agg(distinct p.name, ', '), '') from public.contracts k
     join public.products p on p.company_id = k.company_id and p.id = k.product_id
     where k.company_id = st.company_id and k.client_id = st.client_id and not k.archived),
   'current', st.current,
   'names', (select coalesce(jsonb_object_agg(i.key, i.name), '{}')
     from mavi_private.temperature_client_indicators(st.company_id, st.client_id) i),
   'band_name', s.bands->st.band->>'name',
   'bands', s.bands,
   'previous', case when st.summary_at is not null then jsonb_build_object('text', st.summary, 'at', st.summary_at,
     'score', st.summary_score, 'band_name', s.bands->st.summary_band->>'name') end,
   -- As leituras que mais pesaram na janela (a MAVI cita data e fonte).
   'evidence', coalesce((select jsonb_agg(jsonb_build_object('type', e.source_type, 'title', e.title,
      'date', e.occurred_at, 'excerpt', e.excerpt, 'answers', e.answers, 'flags', e.flags,
      'reason', e.reason->>'key') order by e.influence desc)
    from (
     select g.*, (case g.source_type when 'meeting' then s.meeting_weight else s.whatsapp_weight end)
       * power(0.5, (current_date - g.day)::numeric / s.half_life_days)
       * (select coalesce(max(coalesce((a.value->>'e')::numeric, 1) * abs((a.value->>'v')::numeric - 50)), 0)
          from jsonb_each(g.answers) a where jsonb_typeof(a.value->'v') = 'number') as influence
     from public.temperature_signals g
     where g.client_id = st.client_id and g.status <> 'skipped' and g.answers <> '{}'
      and g.day > current_date - s.window_days
     order by influence desc limit 8
    ) e), '[]'));
 end loop;
 return v_out;
end $$;

create function public.ai_temperature_summary_store(p_secret text, p_client uuid, p_text text, p_usage jsonb)
returns void
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.temperature_state; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into st from mavi_private.temperature_state where client_id = p_client for update;
 if not found then return; end if;
 update mavi_private.temperature_state set summary = left(btrim(coalesce(p_text, '')), 1200), summary_at = now(),
  summary_score = score, summary_band = band,
  summary_flags = coalesce((select array_agg(x->>'key' order by x->>'key') from jsonb_array_elements(current->'flags') x
   where (x->>'alert')::boolean), '{}'),
  summary_pending = false, summary_attempts = 0, summary_until = null, summary_error = null
 where client_id = p_client;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (st.company_id, null, 'clients', 'temperature_text', p_client, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
end $$;

create function public.ai_temperature_summary_fail(p_secret text, p_client uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update mavi_private.temperature_state set summary_attempts = summary_attempts + 1,
  summary_error = left(coalesce(p_error, ''), 500), summary_until = now() + (summary_attempts + 1) * interval '15 minutes'
 where client_id = p_client;
end $$;

-- pg_cron: acorda o worker só quando há o que fazer.
create function mavi_private.ai_temperature_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.temperature_signals x
   where x.status = 'pending' and x.dirty_at <= now() - interval '20 minutes'
    and (x.claimed_until is null or x.claimed_until < now())
    and x.company_id in (select co.id from public.companies co where mavi_private.temperature_route(co.id) is not null))
  and not exists (select 1 from mavi_private.temperature_state st where st.refresh_from is not null
   and mavi_private.temperature_refresh_due(st))
  and not exists (select 1 from mavi_private.temperature_state st where st.summary_pending and st.summary_attempts < 5
   and (st.summary_until is null or st.summary_until < now())) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-temperature"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- ------------------------------------------------------------ telas
create function mavi_private.temperature_settings_json(c uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select jsonb_build_object('bands', s.bands, 'window_days', s.window_days, 'half_life_days', s.half_life_days,
  'meeting_weight', s.meeting_weight, 'whatsapp_weight', s.whatsapp_weight, 'flag_threshold', s.flag_threshold,
  'flag_days', s.flag_days, 'reasons', s.reasons, 'reason_question', s.reason_question, 'alerts', s.alerts,
  'version', s.version, 'updated_at', s.updated_at, 'updated_by', s.updated_by)
 from public.temperature_settings s where s.company_id = c
$$;

-- A aba do cliente (Drive › cliente › Termômetro): hoje, o histórico, as
-- leituras e os indicadores que valem para ele.
create function public.client_temperature(p_company uuid, p_client uuid, p_days integer default 180,
 p_signals integer default 40) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st mavi_private.temperature_state; s public.temperature_settings; v_tz text; v_today date; begin
 if not mavi_private.dossier_reader(p_company, p_client) then
  raise exception 'Sem acesso a este cliente.' using errcode = '42501';
 end if;
 perform mavi_private.temperature_seed(p_company);
 select * into s from public.temperature_settings where company_id = p_company;
 select timezone into v_tz from public.companies where id = p_company;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 select * into st from mavi_private.temperature_state where client_id = p_client;
 -- Primeira vez (ou o dia virou sem recálculo): calcula agora.
 if exists (select 1 from public.temperature_signals where client_id = p_client and answers <> '{}')
  and (st.client_id is null or st.current is null or (st.current->>'day')::date < v_today) then
  perform mavi_private.temperature_mark(p_company, p_client, coalesce(st.refresh_from, v_today));
  perform mavi_private.temperature_refresh_client(p_client);
  select * into st from mavi_private.temperature_state where client_id = p_client;
 end if;
 return jsonb_build_object(
  'settings', mavi_private.temperature_settings_json(p_company),
  'indicators', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'kind', i.kind, 'name', i.name,
     'description', i.description, 'levels', i.levels, 'weight', round(i.weight, 2), 'alert', i.alert,
     'product_id', i.product_id) order by i.position, i.name)
    from mavi_private.temperature_client_indicators(p_company, p_client) i), '[]'),
  'current', st.current,
  'summary', case when st.summary is not null then jsonb_build_object('text', st.summary, 'at', st.summary_at,
    'score', st.summary_score) end,
  'refreshed_at', st.refreshed_at,
  'history', case when coalesce(p_days, 0) > 0 then coalesce((select jsonb_agg(jsonb_build_object('day', d.day,
     'score', d.score, 'band', d.band, 'flags', d.flags) order by d.day)
    from public.temperature_days d where d.client_id = p_client
     and d.day > v_today - least(greatest(p_days, 1), 730)), '[]') end,
  'signals', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'type', g.source_type, 'source_id', g.source_id,
     'group_id', g.group_id, 'message_id', g.message_id, 'title', g.title, 'date', g.occurred_at, 'day', g.day,
     'status', g.status, 'answers', g.answers, 'flags', g.flags, 'reason', g.reason->>'key', 'excerpt', g.excerpt)
    order by g.occurred_at desc)
   from (select * from public.temperature_signals g where g.client_id = p_client and g.status <> 'skipped'
     order by g.occurred_at desc limit least(greatest(coalesce(p_signals, 40), 0), 100)) g), '[]'),
  'pending', (select count(*) from public.temperature_signals g where g.client_id = p_client and g.status = 'pending'),
  'failed', (select count(*) from public.temperature_signals g where g.client_id = p_client and g.status = 'failed'),
  'jev', mavi_private.temperature_route(p_company) is not null,
  'can_configure', mavi_private.leader(p_company));
end $$;

-- A carteira: todos os clientes que a pessoa acessa, com a temperatura.
create function public.clients_temperature(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_leader boolean; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso' using errcode = '42501'; end if;
 v_leader := mavi_private.leader(p_company);
 return jsonb_build_object('settings', mavi_private.temperature_settings_json(p_company),
  'jev', mavi_private.temperature_route(p_company) is not null,
  'can_configure', v_leader,
  'clients', coalesce((select jsonb_agg(jsonb_build_object('client_id', k.id, 'name', k.name, 'color', k.color,
     'score', st.score, 'band', st.band, 'd7', st.current->'score_d7', 'd30', st.current->'score_d30',
     'flags', coalesce(st.current->'flags', '[]'), 'reasons', coalesce(st.current->'reasons', '[]'),
     'indicators', coalesce(st.current->'indicators', '[]'), 'signals', coalesce(st.current->'signals', '0'),
     'summary', st.summary, 'refreshed_at', st.refreshed_at,
     'pending', (select count(*) from public.temperature_signals g where g.client_id = k.id and g.status = 'pending'),
     'teams', (select coalesce(jsonb_agg(ct.team_id), '[]') from public.client_teams ct
       where ct.company_id = k.company_id and ct.client_id = k.id),
     'products', (select coalesce(jsonb_agg(distinct x.product_id), '[]') from public.contracts x
       where x.company_id = k.company_id and x.client_id = k.id and not x.archived))
    order by st.score nulls last, k.name)
   from public.clients k
   left join mavi_private.temperature_state st on st.client_id = k.id
   where k.company_id = p_company and not k.archived
    and (v_leader or mavi_private.drive_can_read(p_company, k.id))), '[]'));
end $$;

-- A configuração (Painel da MAVI › Termômetro), para administradores e gestores.
create function public.temperature_settings(p_company uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.temperature_seed(p_company);
 return jsonb_build_object('settings', mavi_private.temperature_settings_json(p_company),
  'indicators', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'product_id', i.product_id, 'key', i.key,
     'kind', i.kind, 'name', i.name, 'description', i.description, 'levels', i.levels, 'weight', i.weight,
     'sources', to_jsonb(i.sources), 'alert', i.alert, 'active', i.active) order by i.position, i.created_at)
    from public.temperature_indicators i where i.company_id = p_company), '[]'),
  'rules', coalesce((select jsonb_agg(jsonb_build_object('product_id', r.product_id, 'indicator_id', r.indicator_id,
     'active', r.active, 'weight', r.weight))
    from public.temperature_product_rules r where r.company_id = p_company), '[]'),
  'jev', (select jsonb_build_object('provider', x->>'provider', 'model', x->>'model')
    from (select mavi_private.temperature_route(p_company) as x) q where x is not null),
  'stats', (select jsonb_build_object('done', count(*) filter (where g.status = 'done'),
     'pending', count(*) filter (where g.status = 'pending'), 'failed', count(*) filter (where g.status = 'failed'),
     'skipped', count(*) filter (where g.status = 'skipped'))
    from public.temperature_signals g where g.company_id = p_company),
  'cost_30d', (select coalesce(sum(u.cost_usd), 0) from public.ai_usage u where u.company_id = p_company
    and u.module = 'clients' and u.created_at > now() - interval '30 days'));
end $$;

-- Salva tudo de uma vez (faixas, janela, pesos, assuntos, indicadores e
-- ajustes por produto). Mudou uma pergunta: o histórico é lido de novo.
create function public.save_temperature_settings(p_company uuid, p_config jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare b jsonb; v_prev numeric := -1; v_n integer := 0; x jsonb; v_keys text[] := '{}'; v_ids uuid[] := '{}';
 v_id uuid; v_key text; v_levels jsonb; v_sources text[]; v_hash text; v_old text; v_reasons jsonb := '[]';
 v_rkeys text[] := '{}'; v_pos integer := 0; v_kind text; v_base text; v_i integer; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.temperature_seed(p_company);
 if jsonb_typeof(p_config) <> 'object' then raise exception 'Configuração inválida.' using errcode = '22023'; end if;

 -- Faixas: de 2 a 7, a primeira em 0, crescentes.
 if jsonb_typeof(p_config->'bands') <> 'array' or jsonb_array_length(p_config->'bands') not between 2 and 7 then
  raise exception 'A escala tem de 2 a 7 faixas.' using errcode = '22023';
 end if;
 for b in select * from jsonb_array_elements(p_config->'bands') loop
  if jsonb_typeof(b->'min') <> 'number' or (b->>'min')::numeric < 0 or (b->>'min')::numeric >= 100
   or (v_n = 0 and (b->>'min')::numeric <> 0) or (v_n > 0 and (b->>'min')::numeric <= v_prev) then
   raise exception 'As faixas começam em 0 e sobem até menos de 100, sem repetir.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(b->>'name', ''))) not between 1 and 30 or coalesce(b->>'color', '') !~* '^#[0-9a-f]{6}$' then
   raise exception 'Cada faixa precisa de um nome (até 30 caracteres) e de uma cor.' using errcode = '22023';
  end if;
  v_prev := (b->>'min')::numeric; v_n := v_n + 1;
 end loop;

 -- Assuntos: de 2 a 20.
 if jsonb_typeof(p_config->'reasons') <> 'array' or jsonb_array_length(p_config->'reasons') not between 2 and 20 then
  raise exception 'Informe de 2 a 20 assuntos.' using errcode = '22023';
 end if;
 for x in select * from jsonb_array_elements(p_config->'reasons') loop
  v_key := coalesce(nullif(btrim(x->>'key'), ''), left(regexp_replace(mavi_private.temperature_norm(x->>'label'), ' ', '_', 'g'), 30));
  if v_key !~ '^[a-z][a-z0-9_]{1,39}$' then v_key := 'assunto_' || (jsonb_array_length(v_reasons) + 1); end if;
  if v_key = any(v_rkeys) then v_key := v_key || '_' || (jsonb_array_length(v_reasons) + 1); end if;
  if length(btrim(coalesce(x->>'label', ''))) not between 2 and 120 then
   raise exception 'Cada assunto precisa de um texto de 2 a 120 caracteres.' using errcode = '22023';
  end if;
  v_rkeys := v_rkeys || v_key;
  v_reasons := v_reasons || jsonb_build_object('key', v_key, 'label', btrim(x->>'label'),
   'neutral', coalesce((x->>'neutral')::boolean, false));
 end loop;

 update public.temperature_settings set bands = (select jsonb_agg(jsonb_build_object('name', btrim(bb->>'name'),
   'min', (bb->>'min')::numeric, 'color', lower(bb->>'color'), 'alert', coalesce((bb->>'alert')::boolean, false)))
   from jsonb_array_elements(p_config->'bands') bb),
  window_days = coalesce((p_config->>'window_days')::integer, window_days),
  half_life_days = coalesce((p_config->>'half_life_days')::integer, half_life_days),
  meeting_weight = coalesce((p_config->>'meeting_weight')::numeric, meeting_weight),
  whatsapp_weight = coalesce((p_config->>'whatsapp_weight')::numeric, whatsapp_weight),
  flag_threshold = coalesce((p_config->>'flag_threshold')::numeric, flag_threshold),
  flag_days = coalesce((p_config->>'flag_days')::integer, flag_days),
  reasons = v_reasons,
  reason_question = coalesce(nullif(btrim(p_config->>'reason_question'), ''), reason_question),
  alerts = coalesce((p_config->>'alerts')::boolean, alerts),
  updated_by = auth.uid(), updated_at = now()
 where company_id = p_company;

 -- Indicadores: os que vieram ficam (novos entram, os que faltam saem).
 if jsonb_typeof(p_config->'indicators') <> 'array' or jsonb_array_length(p_config->'indicators') > 40 then
  raise exception 'Informe até 40 indicadores.' using errcode = '22023';
 end if;
 for x in select * from jsonb_array_elements(p_config->'indicators') loop
  v_pos := v_pos + 1;
  v_kind := x->>'kind';
  if v_kind not in ('score', 'flag') then raise exception 'Tipo de indicador inválido.' using errcode = '22023'; end if;
  if length(btrim(coalesce(x->>'name', ''))) not between 2 and 80 then
   raise exception 'Cada indicador precisa de um nome de 2 a 80 caracteres.' using errcode = '22023';
  end if;
  if length(btrim(coalesce(x->>'description', ''))) not between 10 and 1000 then
   raise exception 'Explique o indicador "%" em 10 a 1000 caracteres: é o que o Jev lê.', btrim(x->>'name') using errcode = '22023';
  end if;
  v_levels := case when v_kind = 'score' then coalesce((select jsonb_agg(btrim(l)) from jsonb_array_elements_text(
    case when jsonb_typeof(x->'levels') = 'array' then x->'levels' else '[]' end) l where btrim(l) <> ''), '[]') else '[]' end;
  if v_kind = 'score' and jsonb_array_length(v_levels) not between 2 and 10 then
   raise exception 'O indicador "%" precisa de 2 a 10 níveis, do pior para o melhor.', btrim(x->>'name') using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_levels) l where length(l) > 300) then
   raise exception 'Cada nível tem até 300 caracteres.' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct s), '{}') into v_sources from jsonb_array_elements_text(
   case when jsonb_typeof(x->'sources') = 'array' then x->'sources' else '["meeting","whatsapp"]' end) s
  where s in ('meeting', 'whatsapp');
  if cardinality(v_sources) = 0 then raise exception 'Escolha ao menos uma fonte para cada indicador.' using errcode = '22023'; end if;
  if x->>'product_id' is not null and not exists (select 1 from public.products where company_id = p_company
   and id = (x->>'product_id')::uuid) then
   raise exception 'Produto não encontrado.' using errcode = 'P0002';
  end if;
  v_id := case when x->>'id' ~* '^[0-9a-f-]{36}$' then (x->>'id')::uuid end;
  if v_id is not null and exists (select 1 from public.temperature_indicators where id = v_id and company_id = p_company) then
   update public.temperature_indicators set product_id = (x->>'product_id')::uuid, kind = v_kind, name = btrim(x->>'name'),
    description = btrim(x->>'description'), levels = v_levels,
    weight = least(greatest(coalesce((x->>'weight')::numeric, weight), 0), 10), sources = v_sources,
    alert = v_kind = 'flag' and coalesce((x->>'alert')::boolean, false), active = coalesce((x->>'active')::boolean, true),
    position = v_pos, updated_at = now()
   where id = v_id;
  else
   v_base := left(coalesce(nullif(regexp_replace(mavi_private.temperature_norm(x->>'name'), ' ', '_', 'g'), ''), 'indicador'), 30);
   if v_base !~ '^[a-z]' then v_base := 'i_' || v_base; end if;
   v_base := left(v_base, 30);
   if length(v_base) < 2 then v_base := 'indicador'; end if;
   v_key := v_base; v_i := 1;
   while v_key = any(v_keys) or exists (select 1 from public.temperature_indicators where company_id = p_company
    and key = v_key and not (id = any(v_ids))) loop
    v_i := v_i + 1; v_key := v_base || '_' || v_i;
   end loop;
   insert into public.temperature_indicators(company_id, product_id, key, kind, name, description, levels, weight,
    sources, alert, active, position)
   values (p_company, (x->>'product_id')::uuid, v_key, v_kind, btrim(x->>'name'), btrim(x->>'description'), v_levels,
    least(greatest(coalesce((x->>'weight')::numeric, 1), 0), 10), v_sources,
    v_kind = 'flag' and coalesce((x->>'alert')::boolean, false), coalesce((x->>'active')::boolean, true), v_pos)
   returning id into v_id;
  end if;
  v_ids := v_ids || v_id;
  v_keys := v_keys || (select key from public.temperature_indicators where id = v_id);
 end loop;
 delete from public.temperature_indicators where company_id = p_company and not (id = any(v_ids));
 if not exists (select 1 from public.temperature_indicators where company_id = p_company and kind = 'score' and active) then
  raise exception 'Deixe ao menos um indicador de nota ligado: é dele que sai a temperatura.' using errcode = '22023';
 end if;

 -- Ajustes por produto (só de indicadores da empresa).
 delete from public.temperature_product_rules where company_id = p_company;
 insert into public.temperature_product_rules(company_id, product_id, indicator_id, active, weight)
 select p_company, (r->>'product_id')::uuid, (r->>'indicator_id')::uuid, coalesce((r->>'active')::boolean, true),
  case when jsonb_typeof(r->'weight') = 'number' then least(greatest((r->>'weight')::numeric, 0), 10) end
 from jsonb_array_elements(case when jsonb_typeof(p_config->'rules') = 'array' then p_config->'rules' else '[]' end) r
 where r->>'product_id' ~* '^[0-9a-f-]{36}$' and r->>'indicator_id' ~* '^[0-9a-f-]{36}$'
  and exists (select 1 from public.products p where p.company_id = p_company and p.id = (r->>'product_id')::uuid)
  and exists (select 1 from public.temperature_indicators i where i.company_id = p_company
   and i.id = (r->>'indicator_id')::uuid and i.product_id is null)
  and (not coalesce((r->>'active')::boolean, true) or jsonb_typeof(r->'weight') = 'number')
 on conflict (product_id, indicator_id) do nothing;

 -- Perguntas mudaram: nova versão e o histórico é lido de novo.
 v_hash := md5(mavi_private.temperature_questions(p_company)::text);
 select questions_hash into v_old from public.temperature_settings where company_id = p_company;
 if v_hash is distinct from v_old then
  update public.temperature_settings set version = version + 1, questions_hash = v_hash where company_id = p_company;
  update public.temperature_signals set status = 'pending', dirty_at = now() - interval '1 hour', attempts = 0,
   last_error = null
  where company_id = p_company and status in ('done', 'failed');
 end if;
 -- Tudo recalcula; os avisos voltam depois, com a nova base (sem aviso em massa).
 update mavi_private.temperature_state st set ready = false,
  refresh_from = (select min(g.day) from public.temperature_signals g where g.client_id = st.client_id)
 where st.company_id = p_company;
 return public.temperature_settings(p_company);
end $$;

-- ------------------------------------------------------------ avisos
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
 check (kind in ('mention', 'assigned', 'reply', 'social_leads', 'ai_share', 'success_case', 'notice',
  'notice_animation', 'temperature'));
alter table public.notifications drop constraint notifications_target_check;
alter table public.notifications add constraint notifications_target_check
 check ((kind in ('social_leads', 'ai_share', 'success_case', 'notice', 'notice_animation', 'temperature'))
   = (task_id is null)
  and (task_id is not null or (title is not null and link is not null))
  and ((kind = 'notice') = (notice_id is not null)));

-- ------------------------------------------------------------ dashboards
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
       ' where x.plan_id = p.id and x.decision = ''approved'') = 8) a join public.contracts k on k.id = a.contract_id';
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

create or replace function mavi_private.dashboard_check(c uuid, p_panels jsonb, p_variables jsonb) returns void
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; q jsonb; spec jsonb; ids text[] := '{}'; refs text[]; expr text; begin
  if jsonb_typeof(p_panels) <> 'array' or jsonb_array_length(p_panels) > 48 then
    raise exception 'Um dashboard tem até 48 painéis' using errcode = '22023';
  end if;
  if octet_length(p_panels::text) > 300000 then raise exception 'Dashboard grande demais' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'Variáveis inválidas' using errcode = '22023';
  end if;
  for p in select value from jsonb_array_elements(p_panels) loop
    if coalesce(p->>'id', '') !~ '^[a-z0-9-]{1,40}$' or p->>'id' = any(ids) then
      raise exception 'Painel com identificador inválido' using errcode = '22023';
    end if;
    ids := ids || (p->>'id');
    if length(coalesce(p->>'title', '')) > 120 then raise exception 'Título de painel longo demais' using errcode = '22023'; end if;
    if jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number'
     or jsonb_typeof(p->'w') <> 'number' or jsonb_typeof(p->'h') <> 'number'
     or (p->>'x')::int not between 0 and 11 or (p->>'w')::int not between 1 and 12
     or (p->>'x')::int + (p->>'w')::int > 12 or (p->>'y')::int not between 0 and 2000
     or (p->>'h')::int not between 1 and 24 then
      raise exception 'Posição de painel inválida' using errcode = '22023';
    end if;
    spec := p->'spec';
    if coalesce(spec->>'viz', '') not in ('stat', 'line', 'area', 'bar', 'hbar', 'donut', 'table') then
      raise exception 'Visualização inválida' using errcode = '22023';
    end if;
    if coalesce(spec->>'groupBy', 'none') not in
     ('none', 'time', 'client', 'product', 'project', 'team', 'person', 'creator', 'status', 'priority', 'stage',
      'executor', 'previous', 'validator', 'notice', 'level', 'band') then
      raise exception 'Agrupamento inválido' using errcode = '22023';
    end if;
    if coalesce(spec->>'interval', 'auto') not in ('auto', 'day', 'week', 'month') then
      raise exception 'Intervalo inválido' using errcode = '22023';
    end if;
    if jsonb_typeof(spec->'queries') <> 'array' or jsonb_array_length(spec->'queries') not between 1 and 5 then
      raise exception 'Cada painel tem de 1 a 5 consultas' using errcode = '22023';
    end if;
    expr := coalesce(spec->'formula'->>'expr', '');
    if length(expr) > 200 or expr !~ '^[A-E0-9+*/(). -]*$' then
      raise exception 'Fórmula inválida: use A a E, números, + - * / e parênteses' using errcode = '22023';
    end if;
    refs := '{}';
    for q in select value from jsonb_array_elements(spec->'queries') loop
      if coalesce(q->>'ref', '') !~ '^[A-E]$' or q->>'ref' = any(refs) then
        raise exception 'Consulta inválida' using errcode = '22023';
      end if;
      refs := refs || (q->>'ref');
      perform mavi_private.dashboard_sql(c, q, coalesce(spec->>'groupBy', 'none'), 'month',
       current_date, current_date, coalesce(p_variables->'filters', '{}'::jsonb), 10);
    end loop;
  end loop;
end $$;
revoke all on function mavi_private.dashboard_check(uuid, jsonb, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ histórico
-- Toda empresa nasce com a configuração inicial, e as reuniões e dias de
-- grupo que a MAVI já conhece viram leituras pendentes (o histórico todo).
select mavi_private.temperature_seed(id) from public.companies;
update public.temperature_settings s set questions_hash = md5(mavi_private.temperature_questions(s.company_id)::text);
insert into public.temperature_signals(company_id, client_id, source_type, source_id, group_id, title, occurred_at,
 day, status, dirty_at)
select d.company_id, d.client_id, d.source_type, d.source_id, w.group_id, left(d.title, 300),
 coalesce(d.occurred_at, d.indexed_at),
 coalesce(w.day, (coalesce(d.occurred_at, d.indexed_at) at time zone coalesce(co.timezone, 'America/Sao_Paulo'))::date),
 'pending', now() - interval '1 hour'
from public.ai_documents d
join public.companies co on co.id = d.company_id
join public.clients k on k.company_id = d.company_id and k.id = d.client_id
left join mavi_private.whatsapp_ai_days w on d.source_type = 'whatsapp' and w.id = d.source_id
where d.source_type in ('meeting', 'whatsapp') and d.client_id is not null
on conflict (company_id, source_type, source_id) do nothing;

-- ------------------------------------------------------------ permissões
revoke all on function mavi_private.jev_model(text), mavi_private.temperature_route(uuid),
 mavi_private.phone_key(text), mavi_private.team_phone_keys(uuid), mavi_private.temperature_seed(uuid),
 mavi_private.temperature_questions(uuid), mavi_private.temperature_mark(uuid, uuid, date),
 mavi_private.temperature_touch(), mavi_private.temperature_client_indicators(uuid, uuid),
 mavi_private.temperature_band(jsonb, numeric), mavi_private.temperature_series(uuid, uuid, date, date),
 mavi_private.temperature_recipients(uuid, uuid), mavi_private.temperature_notify(uuid, uuid, text, text),
 mavi_private.temperature_refresh_client(uuid), mavi_private.temperature_daily(),
 mavi_private.temperature_norm(text), mavi_private.temperature_is_team(text, text[]),
 mavi_private.temperature_clip(text, integer), mavi_private.temperature_material(uuid),
 mavi_private.ai_temperature_kick(), mavi_private.temperature_settings_json(uuid),
 mavi_private.temperature_refresh_due(mavi_private.temperature_state)
 from public, anon, authenticated;
revoke all on function public.member_phone(uuid, uuid), public.set_member_phone(uuid, uuid, text),
 public.client_temperature(uuid, uuid, integer, integer), public.clients_temperature(uuid),
 public.temperature_settings(uuid), public.save_temperature_settings(uuid, jsonb),
 public.ai_set_route(uuid, text, uuid, uuid, text, text)
 from public, anon;
grant execute on function public.member_phone(uuid, uuid), public.set_member_phone(uuid, uuid, text),
 public.client_temperature(uuid, uuid, integer, integer), public.clients_temperature(uuid),
 public.temperature_settings(uuid), public.save_temperature_settings(uuid, jsonb),
 public.ai_set_route(uuid, text, uuid, uuid, text, text)
 to authenticated;
-- O worker chama como anon + segredo.
revoke all on function public.ai_temperature_config(text, uuid), public.ai_temperature_claim(text, integer),
 public.ai_temperature_store(text, jsonb), public.ai_temperature_fail(text, uuid, text),
 public.ai_temperature_refresh(text, integer), public.ai_temperature_summary_claim(text, integer),
 public.ai_temperature_summary_store(text, uuid, text, jsonb), public.ai_temperature_summary_fail(text, uuid, text)
 from public, anon, authenticated;
grant execute on function public.ai_temperature_config(text, uuid), public.ai_temperature_claim(text, integer),
 public.ai_temperature_store(text, jsonb), public.ai_temperature_fail(text, uuid, text),
 public.ai_temperature_refresh(text, integer), public.ai_temperature_summary_claim(text, integer),
 public.ai_temperature_summary_store(text, uuid, text, jsonb), public.ai_temperature_summary_fail(text, uuid, text)
 to anon, authenticated;

commit;
