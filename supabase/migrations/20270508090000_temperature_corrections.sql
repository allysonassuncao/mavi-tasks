begin;

-- Termômetro do cliente · o time corrige e a MAVI aprende.
--
-- * Correções numa leitura: o assunto ("O que mais mexe"), os sinais de
--   alerta (tirar e pôr) e as notas dos indicadores (outro nível ou "a
--   leitura não fala disso"). O que o Jev disse fica em `jev`; as correções,
--   em `overrides`; answers/flags/reason são sempre jev + correções (um
--   gatilho refaz a conta quando o Jev lê de novo ou alguém corrige), então o
--   cálculo, os Dashboards e a MAVI não mudam.
-- * Retirar uma leitura inteira (reunião interna, grupo errado, conversa de
--   outro cliente), com motivo, e devolver depois. Retirada fica 'skipped'
--   (o mesmo que já sai do cálculo) e não volta à fila enquanto estiver
--   retirada. Tirar um sinal de alerta do cliente tira o sinal de todas as
--   leituras da janela de sinais.
-- * Quem corrige: administradores, gestores e supervisores das equipes do
--   cliente.
-- * Aprendizado: cada correção fica em temperature_feedback e vira exemplo
--   nas próximas leituras do Jev (do mesmo cliente primeiro). A MAVI junta as
--   correções em regras curtas por indicador, pelo assunto ("motivo") e
--   pelas leituras que não contam ("leitura"); elas entram em uso na hora,
--   nas perguntas ao Jev. Líderes editam, pausam, excluem e escrevem as
--   suas (Painel da MAVI › Termômetro); a MAVI não mexe no que uma pessoa
--   mexeu. Com regras de "leitura", o Jev também confere se a leitura conta;
--   a que não conta sai sozinha ("Retirada pela MAVI") e a pessoa devolve.
--   O texto das regras usa o modelo da funcionalidade
--   'client_temperature_text'.

-- ------------------------------------------------------------ leituras
alter table public.temperature_signals
 -- O que o Jev disse (answers, flags, reason), antes das correções.
 add column jev jsonb,
 -- {answers: {chave: {v, c, e}}, flags: {chave: 0|1}, reason: chave}.
 add column overrides jsonb not null default '{}' check (jsonb_typeof(overrides) = 'object'),
 add column corrected_by uuid,
 add column corrected_at timestamptz,
 add column removed_at timestamptz,
 -- Nulo com removed_auto: a MAVI retirou.
 add column removed_by uuid,
 add column removed_reason text,
 add column removed_auto boolean not null default false,
 -- Uma pessoa devolveu: a MAVI não retira de novo.
 add column kept boolean not null default false;

-- O resultado é sempre o do Jev com as correções por cima; retirada não sai
-- de 'skipped'.
create function mavi_private.temperature_signal_guard() returns trigger
language plpgsql set search_path = '' as $$ begin
 -- Mudou de cliente: as correções e a retirada eram do outro.
 -- (o que fica é o que o Jev disse; a leitura volta para a fila).
 if new.client_id is distinct from old.client_id then
  if old.jev is not null and new.evaluated_at is not distinct from old.evaluated_at then
   new.answers := coalesce(old.jev->'answers', '{}');
   new.flags := coalesce(old.jev->'flags', '{}');
   new.reason := nullif(old.jev->'reason', 'null'::jsonb);
  end if;
  new.overrides := '{}'; new.jev := null; new.corrected_by := null; new.corrected_at := null;
  if old.removed_at is not null and new.removed_at is not distinct from old.removed_at then
   new.status := 'pending'; new.dirty_at := now();
  end if;
  new.removed_at := null; new.removed_by := null; new.removed_reason := null; new.removed_auto := false;
  new.kept := false;
  return new;
 end if;
 if new.evaluated_at is distinct from old.evaluated_at then
  -- Leitura nova do Jev: guarda o que ele disse.
  new.jev := jsonb_build_object('answers', new.answers, 'flags', new.flags, 'reason', new.reason);
 elsif new.overrides is distinct from old.overrides and new.jev is null then
  new.jev := jsonb_build_object('answers', old.answers, 'flags', old.flags, 'reason', old.reason);
 end if;
 if new.jev is not null and (new.evaluated_at is distinct from old.evaluated_at
   or new.overrides is distinct from old.overrides) then
  new.answers := coalesce(new.jev->'answers', '{}') || coalesce(new.overrides->'answers', '{}');
  new.flags := coalesce(new.jev->'flags', '{}') || coalesce(new.overrides->'flags', '{}');
  new.reason := case when new.overrides ? 'reason' then jsonb_build_object('key', new.overrides->>'reason',
    'p', jsonb_build_object(new.overrides->>'reason', 1))
   else nullif(new.jev->'reason', 'null'::jsonb) end;
 end if;
 if new.removed_at is not null then
  new.status := 'skipped';
  new.claimed_until := null;
 end if;
 return new;
end $$;
revoke all on function mavi_private.temperature_signal_guard() from public, anon, authenticated;
create trigger temperature_signals_guard before update on public.temperature_signals
 for each row execute function mavi_private.temperature_signal_guard();

-- ------------------------------------------------------------ aprendizado
-- Cada correção do time (os exemplos do Jev e o material das regras).
create table public.temperature_feedback (
 id bigint generated always as identity primary key,
 company_id uuid not null,
 client_id uuid not null,
 signal_id uuid references public.temperature_signals(id) on delete set null,
 user_id uuid,
 -- reason: assunto · flag: sinal de alerta · score: nota · remove/restore: a leitura.
 kind text not null check (kind in ('reason', 'flag', 'score', 'remove', 'restore')),
 key text,
 before jsonb,
 after jsonb,
 note text not null default '',
 -- O material, para o exemplo continuar valendo se a leitura sumir.
 source_type text not null check (source_type in ('meeting', 'whatsapp')),
 day date not null,
 title text not null default '',
 excerpt text not null default '',
 learned_at timestamptz,
 created_at timestamptz not null default now(),
 foreign key (company_id, client_id) references public.clients(company_id, id) on delete cascade
);
create index temperature_feedback_company on public.temperature_feedback (company_id, created_at desc);
create index temperature_feedback_unlearned on public.temperature_feedback (company_id, created_at)
 where learned_at is null;
alter table public.temperature_feedback enable row level security;
revoke all on public.temperature_feedback from public, anon, authenticated;

-- As regras que a MAVI (ou um líder) escreveu, por indicador, pelo assunto
-- ('motivo') ou pelas leituras que não contam ('leitura').
create table public.temperature_lessons (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id) on delete cascade,
 key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
 text text not null check (length(btrim(text)) between 5 and 400),
 -- dismissed: excluída por um líder (a MAVI não escreve de novo).
 status text not null default 'active' check (status in ('active', 'paused', 'dismissed')),
 origin text not null default 'mavi' check (origin in ('mavi', 'person')),
 -- Uma pessoa mexeu: a MAVI não muda mais.
 locked boolean not null default false,
 -- Quantas correções sustentam a regra.
 feedback integer not null default 0,
 created_by uuid,
 updated_by uuid,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index temperature_lessons_company on public.temperature_lessons (company_id, key);
alter table public.temperature_lessons enable row level security;
revoke all on public.temperature_lessons from public, anon, authenticated;

alter table public.temperature_settings
 add column lessons_until timestamptz,
 add column lessons_attempts integer not null default 0,
 add column lessons_error text,
 add column lessons_at timestamptz;

-- ------------------------------------------------------------ quem corrige
create function mavi_private.temperature_corrector(c uuid, p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
 select mavi_private.leader(c) or exists (
  select 1 from public.client_teams ct
  join public.team_members tm on tm.company_id = ct.company_id and tm.team_id = ct.team_id and tm.supervisor
  join public.memberships m on m.company_id = tm.company_id and m.user_id = tm.user_id and m.active
  where ct.company_id = c and ct.client_id = p_client and tm.user_id = auth.uid())
$$;
revoke all on function mavi_private.temperature_corrector(uuid, uuid) from public, anon, authenticated;

-- A leitura que a pessoa corrige (da empresa, de um cliente que ela corrige).
create function mavi_private.temperature_signal_for(c uuid, p_signal uuid) returns public.temperature_signals
language plpgsql security definer set search_path = '' as $$
declare g public.temperature_signals; begin
 select * into g from public.temperature_signals where id = p_signal and company_id = c for update;
 if not found then raise exception 'Leitura não encontrada.' using errcode = 'P0002'; end if;
 if not mavi_private.temperature_corrector(c, g.client_id) then
  raise exception 'Só administradores, gestores e supervisores das equipes do cliente corrigem o termômetro.'
   using errcode = '42501';
 end if;
 return g;
end $$;
revoke all on function mavi_private.temperature_signal_for(uuid, uuid) from public, anon, authenticated;

create function mavi_private.temperature_feedback_add(g public.temperature_signals, p_kind text, p_key text,
 p_before jsonb, p_after jsonb, p_note text) returns void
language sql security definer set search_path = '' as $$
 insert into public.temperature_feedback(company_id, client_id, signal_id, user_id, kind, key, before, after, note,
  source_type, day, title, excerpt)
 values (g.company_id, g.client_id, g.id, auth.uid(), p_kind, p_key, p_before, p_after,
  left(btrim(coalesce(p_note, '')), 500), g.source_type, g.day, left(coalesce(g.title, ''), 300),
  left(coalesce(g.excerpt, ''), 500))
$$;
revoke all on function mavi_private.temperature_feedback_add(public.temperature_signals, text, text, jsonb, jsonb, text)
 from public, anon, authenticated;

-- Recalcula o cliente agora (a tela mostra o resultado da correção).
create function mavi_private.temperature_recalc(c uuid, p_client uuid, p_day date) returns void
language plpgsql security definer set search_path = '' as $$ begin
 perform mavi_private.temperature_mark(c, p_client, p_day);
 perform mavi_private.temperature_refresh_client(p_client);
end $$;
revoke all on function mavi_private.temperature_recalc(uuid, uuid, date) from public, anon, authenticated;

-- ------------------------------------------------------------ corrigir
-- p_changes: {reason: chave | null, flags: {chave: true | false | null},
-- answers: {chave: {v: 0–100} | {e: 0} | null}}. null desfaz a correção
-- (volta ao que o Jev disse).
create function public.correct_temperature_signal(p_company uuid, p_signal uuid, p_changes jsonb,
 p_note text default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.temperature_signals; s public.temperature_settings; v_raw jsonb; v_ov jsonb; v_flags jsonb;
 v_answers jsonb; r record; v_key text; v_before jsonb; v_after jsonb; v_n integer := 0; begin
 g := mavi_private.temperature_signal_for(p_company, p_signal);
 if g.removed_at is not null then raise exception 'Devolva a leitura antes de corrigir.' using errcode = '22023'; end if;
 if g.status not in ('done', 'pending') or g.evaluated_at is null then
  raise exception 'A MAVI ainda não leu esta reunião ou conversa.' using errcode = '22023';
 end if;
 if jsonb_typeof(p_changes) is distinct from 'object' then
  raise exception 'Nada para corrigir.' using errcode = '22023';
 end if;
 select * into s from public.temperature_settings where company_id = p_company;
 v_raw := coalesce(g.jev, jsonb_build_object('answers', g.answers, 'flags', g.flags, 'reason', g.reason));
 v_ov := g.overrides;
 v_flags := coalesce(v_ov->'flags', '{}');
 v_answers := coalesce(v_ov->'answers', '{}');

 -- O assunto.
 if p_changes ? 'reason' then
  v_key := p_changes->>'reason';
  if v_key is not null and not exists (select 1 from jsonb_array_elements(s.reasons) x where x->>'key' = v_key) then
   raise exception 'Assunto desconhecido.' using errcode = '22023';
  end if;
  v_before := to_jsonb(g.reason->>'key');
  if v_key is null or v_key = v_raw->'reason'->>'key' then v_ov := v_ov - 'reason';
  else v_ov := v_ov || jsonb_build_object('reason', v_key); end if;
  v_after := to_jsonb(coalesce(v_ov->>'reason', v_raw->'reason'->>'key'));
  if v_after is distinct from v_before then
   perform mavi_private.temperature_feedback_add(g, 'reason', null, v_before, v_after, p_note);
   v_n := v_n + 1;
  end if;
 end if;

 -- Os sinais de alerta.
 for r in select * from jsonb_each(case when jsonb_typeof(p_changes->'flags') = 'object' then p_changes->'flags'
   else '{}' end) loop
  if not exists (select 1 from public.temperature_indicators i where i.company_id = p_company and i.key = r.key
    and i.kind = 'flag') then
   raise exception 'Sinal de alerta desconhecido.' using errcode = '22023';
  end if;
  v_before := to_jsonb(coalesce((g.flags->>r.key)::numeric, 0) >= s.flag_threshold);
  if jsonb_typeof(r.value) = 'boolean' and (r.value::text = 'true')
    <> (coalesce((v_raw->'flags'->>r.key)::numeric, 0) >= s.flag_threshold) then
   v_flags := v_flags || jsonb_build_object(r.key, case when r.value::text = 'true' then 1 else 0 end);
  else
   v_flags := v_flags - r.key;
  end if;
  v_after := to_jsonb(coalesce((v_flags->>r.key)::numeric, (v_raw->'flags'->>r.key)::numeric, 0) >= s.flag_threshold);
  if v_after is distinct from v_before then
   perform mavi_private.temperature_feedback_add(g, 'flag', r.key, v_before, v_after, p_note);
   v_n := v_n + 1;
  end if;
 end loop;

 -- As notas: {v} outro nível; {e: 0} "não fala disso".
 for r in select * from jsonb_each(case when jsonb_typeof(p_changes->'answers') = 'object' then p_changes->'answers'
   else '{}' end) loop
  if not exists (select 1 from public.temperature_indicators i where i.company_id = p_company and i.key = r.key
    and i.kind = 'score') then
   raise exception 'Indicador desconhecido.' using errcode = '22023';
  end if;
  v_before := g.answers->r.key;
  if jsonb_typeof(r.value) = 'object' and jsonb_typeof(r.value->'v') = 'number' then
   v_answers := v_answers || jsonb_build_object(r.key, jsonb_build_object(
    'v', round(least(greatest((r.value->>'v')::numeric, 0), 100), 1), 'c', 1, 'e', 1));
  elsif jsonb_typeof(r.value) = 'object' and (r.value->>'e')::numeric = 0 then
   v_answers := v_answers || jsonb_build_object(r.key, jsonb_build_object(
    'v', coalesce((v_raw->'answers'->r.key->>'v')::numeric, 50), 'c', 1, 'e', 0));
  else
   v_answers := v_answers - r.key;
  end if;
  v_after := coalesce(v_answers->r.key, v_raw->'answers'->r.key);
  if v_after is distinct from v_before then
   perform mavi_private.temperature_feedback_add(g, 'score', r.key, v_before, v_after, p_note);
   v_n := v_n + 1;
  end if;
 end loop;

 v_ov := v_ov - 'flags' - 'answers';
 if v_flags <> '{}' then v_ov := v_ov || jsonb_build_object('flags', v_flags); end if;
 if v_answers <> '{}' then v_ov := v_ov || jsonb_build_object('answers', v_answers); end if;
 if v_n = 0 and v_ov = g.overrides then return jsonb_build_object('changes', 0); end if;
 update public.temperature_signals set overrides = v_ov, jev = v_raw,
  corrected_by = case when v_ov = '{}' then null else auth.uid() end,
  corrected_at = case when v_ov = '{}' then null else now() end
 where id = g.id;
 perform mavi_private.temperature_recalc(p_company, g.client_id, g.day);
 return jsonb_build_object('changes', v_n);
end $$;

-- Retirar uma leitura do cálculo (com motivo).
create function public.remove_temperature_signal(p_company uuid, p_signal uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.temperature_signals; begin
 g := mavi_private.temperature_signal_for(p_company, p_signal);
 if length(btrim(coalesce(p_reason, ''))) < 3 then
  raise exception 'Conte por que a leitura não conta (a MAVI aprende com isso).' using errcode = '22023';
 end if;
 if g.removed_at is not null then return; end if;
 update public.temperature_signals set removed_at = now(), removed_by = auth.uid(),
  removed_reason = left(btrim(p_reason), 500), removed_auto = false, kept = false
 where id = g.id;
 perform mavi_private.temperature_feedback_add(g, 'remove', null, null, null, p_reason);
 perform mavi_private.temperature_recalc(p_company, g.client_id, g.day);
end $$;

-- Devolver: a leitura volta ao cálculo (e a MAVI não a retira de novo).
create function public.restore_temperature_signal(p_company uuid, p_signal uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare g public.temperature_signals; begin
 g := mavi_private.temperature_signal_for(p_company, p_signal);
 if g.removed_at is null then return; end if;
 update public.temperature_signals set removed_at = null, removed_by = null, removed_reason = null,
  removed_auto = false, kept = true,
  status = case when g.evaluated_at is not null and g.answers <> '{}' then 'done' else 'pending' end,
  dirty_at = case when g.evaluated_at is not null and g.answers <> '{}' then dirty_at
   else now() - interval '20 minutes' end
 where id = g.id;
 perform mavi_private.temperature_feedback_add(g, 'restore', null,
  jsonb_build_object('auto', g.removed_auto, 'reason', g.removed_reason), null, p_note);
 perform mavi_private.temperature_recalc(p_company, g.client_id, g.day);
end $$;

-- Tirar um sinal de alerta do cliente: sai de todas as leituras da janela
-- de sinais em que aparece.
create function public.clear_temperature_flag(p_company uuid, p_client uuid, p_key text, p_note text)
returns integer
language plpgsql security definer set search_path = '' as $$
declare s public.temperature_settings; v_tz text; v_today date; g public.temperature_signals; v_n integer := 0;
 v_first date; begin
 if not mavi_private.temperature_corrector(p_company, p_client) then
  raise exception 'Só administradores, gestores e supervisores das equipes do cliente corrigem o termômetro.'
   using errcode = '42501';
 end if;
 if length(btrim(coalesce(p_note, ''))) < 3 then
  raise exception 'Conte por que o sinal não vale (a MAVI aprende com isso).' using errcode = '22023';
 end if;
 select * into s from public.temperature_settings where company_id = p_company;
 select timezone into v_tz from public.companies where id = p_company;
 v_today := (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date;
 for g in select * from public.temperature_signals x
  where x.company_id = p_company and x.client_id = p_client and x.status <> 'skipped'
   and x.day > v_today - s.flag_days and x.flags->>p_key ~ '^[0-9.]+$'
   and (x.flags->>p_key)::numeric >= s.flag_threshold
  for update
 loop
  update public.temperature_signals set
   overrides = overrides || jsonb_build_object('flags', coalesce(overrides->'flags', '{}') || jsonb_build_object(p_key, 0)),
   jev = coalesce(jev, jsonb_build_object('answers', answers, 'flags', flags, 'reason', reason)),
   corrected_by = auth.uid(), corrected_at = now()
  where id = g.id;
  perform mavi_private.temperature_feedback_add(g, 'flag', p_key, 'true', 'false', p_note);
  v_first := least(coalesce(v_first, g.day), g.day);
  v_n := v_n + 1;
 end loop;
 if v_n > 0 then perform mavi_private.temperature_recalc(p_company, p_client, v_first); end if;
 return v_n;
end $$;

revoke all on function public.correct_temperature_signal(uuid, uuid, jsonb, text),
 public.remove_temperature_signal(uuid, uuid, text), public.restore_temperature_signal(uuid, uuid, text),
 public.clear_temperature_flag(uuid, uuid, text, text) from public, anon;
grant execute on function public.correct_temperature_signal(uuid, uuid, jsonb, text),
 public.remove_temperature_signal(uuid, uuid, text), public.restore_temperature_signal(uuid, uuid, text),
 public.clear_temperature_flag(uuid, uuid, text, text) to authenticated;

-- ------------------------------------------------------------ a aba do cliente
-- A da migração 20270129090000, com as correções de cada leitura, as
-- leituras retiradas e quem pode corrigir.
create or replace function public.client_temperature(p_company uuid, p_client uuid, p_days integer default 180,
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
     'status', g.status, 'answers', g.answers, 'flags', g.flags, 'reason', g.reason->>'key', 'excerpt', g.excerpt,
     'client_lines', g.client_lines, 'group', wg.title,
     'corrected', case when g.overrides <> '{}' then jsonb_build_object('overrides', g.overrides,
       'jev', jsonb_build_object('answers', g.jev->'answers', 'flags', g.jev->'flags',
        'reason', g.jev->'reason'->>'key'),
       'at', g.corrected_at, 'by', (select m.name from public.memberships m
         where m.company_id = g.company_id and m.user_id = g.corrected_by)) end,
     'removed', case when g.removed_at is not null then jsonb_build_object('at', g.removed_at,
       'reason', g.removed_reason, 'auto', g.removed_auto, 'by', (select m.name from public.memberships m
         where m.company_id = g.company_id and m.user_id = g.removed_by)) end)
    order by g.occurred_at desc)
   from (select x.* from (select y.*, row_number() over (partition by y.source_type order by y.occurred_at desc) as n
      from public.temperature_signals y where y.client_id = p_client
       and (y.status <> 'skipped' or y.removed_at is not null)) x
     where x.n <= least(greatest(coalesce(p_signals, 40), 0), 100)) g
   left join public.whatsapp_groups wg on wg.company_id = g.company_id and wg.id = g.group_id), '[]'),
  'sources', (select jsonb_build_object(
    'meeting', jsonb_build_object('read', count(*) filter (where g.source_type = 'meeting' and g.status = 'done'),
     'pending', count(*) filter (where g.source_type = 'meeting' and g.status = 'pending'),
     'failed', count(*) filter (where g.source_type = 'meeting' and g.status = 'failed'),
     'skipped', count(*) filter (where g.source_type = 'meeting' and g.status = 'skipped' and g.removed_at is null),
     'removed', count(*) filter (where g.source_type = 'meeting' and g.removed_at is not null)),
    'whatsapp', jsonb_build_object('read', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'done'),
     'pending', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'pending'),
     'failed', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'failed'),
     'skipped', count(*) filter (where g.source_type = 'whatsapp' and g.status = 'skipped' and g.removed_at is null),
     'removed', count(*) filter (where g.source_type = 'whatsapp' and g.removed_at is not null),
     'groups', (select count(*) from public.whatsapp_groups w
       where w.company_id = p_company and w.client_id = p_client and not w.ignored)))
   from public.temperature_signals g where g.client_id = p_client),
  'pending', (select count(*) from public.temperature_signals g where g.client_id = p_client and g.status = 'pending'),
  'failed', (select count(*) from public.temperature_signals g where g.client_id = p_client and g.status = 'failed'),
  'jev', mavi_private.temperature_route(p_company) is not null,
  'can_configure', mavi_private.leader(p_company),
  'can_correct', mavi_private.temperature_corrector(p_company, p_client));
end $$;

-- ------------------------------------------------------------ Painel da MAVI › Termômetro
-- As regras e as correções recentes (líderes).
create function public.temperature_learning(p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare s public.temperature_settings; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into s from public.temperature_settings where company_id = p_company;
 return jsonb_build_object(
  'lessons', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'key', l.key, 'text', l.text,
     'status', l.status, 'origin', l.origin, 'locked', l.locked, 'feedback', l.feedback,
     'updated_at', l.updated_at, 'updated_by', (select m.name from public.memberships m
       where m.company_id = l.company_id and m.user_id = coalesce(l.updated_by, l.created_by)))
    order by l.key, l.created_at)
   from public.temperature_lessons l where l.company_id = p_company and l.status <> 'dismissed'), '[]'),
  'feedback', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'key', f.key,
     'before', f.before, 'after', f.after, 'note', f.note, 'type', f.source_type, 'day', f.day, 'title', f.title,
     'client_id', f.client_id, 'client', k.name, 'by', m.name, 'at', f.created_at, 'learned', f.learned_at is not null)
    order by f.created_at desc)
   from (select * from public.temperature_feedback x where x.company_id = p_company
     order by x.created_at desc limit 60) f
   join public.clients k on k.id = f.client_id
   left join public.memberships m on m.company_id = f.company_id and m.user_id = f.user_id), '[]'),
  'pending', (select count(*) from public.temperature_feedback f where f.company_id = p_company
    and f.learned_at is null),
  'learned_at', s.lessons_at,
  'error', s.lessons_error);
end $$;

-- Criar (p_id nulo) ou mudar uma regra. Quem mexe trava a regra para a MAVI.
create function public.save_temperature_lesson(p_company uuid, p_id uuid, p_key text, p_text text,
 p_status text default 'active') returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if coalesce(p_status, '') not in ('active', 'paused') then raise exception 'Situação inválida.' using errcode = '22023'; end if;
 if length(btrim(coalesce(p_text, ''))) not between 5 and 400 then
  raise exception 'A regra precisa de 5 a 400 caracteres.' using errcode = '22023';
 end if;
 if p_key not in ('motivo', 'leitura') and not exists (select 1 from public.temperature_indicators i
   where i.company_id = p_company and i.key = p_key) then
  raise exception 'Escolha um indicador, o assunto ou as leituras.' using errcode = '22023';
 end if;
 if p_id is null then
  insert into public.temperature_lessons(company_id, key, text, status, origin, locked, created_by, updated_by)
  values (p_company, p_key, btrim(p_text), p_status, 'person', true, auth.uid(), auth.uid())
  returning id into v_id;
  return v_id;
 end if;
 update public.temperature_lessons set key = p_key, text = btrim(p_text), status = p_status, locked = true,
  updated_by = auth.uid(), updated_at = now()
 where id = p_id and company_id = p_company and status <> 'dismissed'
 returning id into v_id;
 if v_id is null then raise exception 'Regra não encontrada.' using errcode = 'P0002'; end if;
 return v_id;
end $$;

-- Excluir: some da lista e a MAVI não escreve a mesma regra de novo.
create function public.delete_temperature_lesson(p_company uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.leader(p_company) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.temperature_lessons set status = 'dismissed', locked = true, updated_by = auth.uid(), updated_at = now()
 where id = p_id and company_id = p_company;
end $$;

revoke all on function public.temperature_learning(uuid), public.save_temperature_lesson(uuid, uuid, text, text, text),
 public.delete_temperature_lesson(uuid, uuid) from public, anon;
grant execute on function public.temperature_learning(uuid), public.save_temperature_lesson(uuid, uuid, text, text, text),
 public.delete_temperature_lesson(uuid, uuid) to authenticated;

-- ------------------------------------------------------------ o worker
-- O que entra nas perguntas ao Jev: as regras em uso por chave e as
-- correções recentes (o worker escolhe os exemplos de cada leitura).
create function public.ai_temperature_learning(p_secret text, p_company uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$ begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 return jsonb_build_object(
  'lessons', coalesce((select jsonb_object_agg(q.key, q.texts) from (
    select l.key, jsonb_agg(l.text order by l.created_at) as texts from public.temperature_lessons l
    where l.company_id = p_company and l.status = 'active' group by l.key) q), '{}'),
  'examples', coalesce((select jsonb_agg(jsonb_build_object('client_id', f.client_id, 'client', k.name,
     'signal_id', f.signal_id, 'kind', f.kind, 'key', f.key, 'before', f.before, 'after', f.after, 'note', f.note,
     'type', f.source_type, 'day', f.day, 'excerpt', f.excerpt) order by f.created_at desc)
   from (select * from public.temperature_feedback x where x.company_id = p_company and x.kind <> 'restore'
     order by x.created_at desc limit 80) f
   join public.clients k on k.id = f.client_id), '[]'));
end $$;

-- A MAVI retira as leituras que, pelas regras do time, não contam.
create function public.ai_temperature_irrelevant(p_secret text, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = '' as $$
declare g public.temperature_signals; v_n integer := 0; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for g in select * from public.temperature_signals where id = any(coalesce(p_ids, '{}')) and removed_at is null
  and not kept for update
 loop
  update public.temperature_signals set removed_at = now(), removed_by = null, removed_auto = true,
   removed_reason = 'Pelas regras que o time ensinou, a MAVI entendeu que esta leitura não conta.'
  where id = g.id;
  perform mavi_private.temperature_mark(g.company_id, g.client_id, g.day);
  v_n := v_n + 1;
 end loop;
 return v_n;
end $$;

-- Uma empresa com correções novas (paradas há 10 minutos: quem corrige
-- várias de uma vez entra num lote só), com o que a MAVI precisa.
create function public.ai_temperature_lessons_claim(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s public.temperature_settings; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into s from public.temperature_settings x
 where (x.lessons_until is null or x.lessons_until < now())
  and exists (select 1 from public.temperature_feedback f where f.company_id = x.company_id and f.learned_at is null)
  and not exists (select 1 from public.temperature_feedback f where f.company_id = x.company_id and f.learned_at is null
   and f.created_at > now() - interval '10 minutes')
 order by x.lessons_at nulls first
 limit 1
 for update skip locked;
 if not found then return null; end if;
 update public.temperature_settings set lessons_until = now() + interval '5 minutes' where company_id = s.company_id;
 return jsonb_build_object('company', s.company_id,
  'indicators', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'kind', i.kind, 'name', i.name,
     'description', i.description) order by i.position, i.name)
   from public.temperature_indicators i where i.company_id = s.company_id and i.active), '[]'),
  'reasons', (select jsonb_agg(jsonb_build_object('key', r->>'key', 'label', r->>'label'))
   from jsonb_array_elements(s.reasons) r),
  'lessons', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'key', l.key, 'text', l.text,
     'status', l.status, 'origin', l.origin, 'locked', l.locked) order by l.key, l.created_at)
   from public.temperature_lessons l where l.company_id = s.company_id), '[]'),
  'feedback', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'key', f.key,
     'before', f.before, 'after', f.after, 'note', f.note, 'type', f.source_type, 'day', f.day, 'title', f.title,
     'excerpt', f.excerpt, 'client', k.name) order by f.created_at)
   from (select * from public.temperature_feedback x where x.company_id = s.company_id and x.learned_at is null
     order by x.created_at limit 40) f
   join public.clients k on k.id = f.client_id), '[]'));
end $$;

-- As mudanças da MAVI: [{op: add, key, text, feedback} | {op: update, id,
-- text, feedback} | {op: retire, id}]. O que uma pessoa mexeu fica como está.
create function public.ai_temperature_lessons_store(p_secret text, p_company uuid, p_ops jsonb, p_learned bigint[],
 p_usage jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare o jsonb; v_n integer := 0; v_text text; v_key text; v_count integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 for o in select * from jsonb_array_elements(case when jsonb_typeof(p_ops) = 'array' then p_ops else '[]' end) loop
  v_text := left(btrim(regexp_replace(coalesce(o->>'text', ''), '\s+', ' ', 'g')), 400);
  v_key := o->>'key';
  v_count := case when jsonb_typeof(o->'feedback') = 'array' then jsonb_array_length(o->'feedback') else 0 end;
  if o->>'op' = 'add' and length(v_text) >= 5 and (v_key in ('motivo', 'leitura') or exists (
    select 1 from public.temperature_indicators i where i.company_id = p_company and i.key = v_key)) then
   insert into public.temperature_lessons(company_id, key, text, feedback) values (p_company, v_key, v_text, v_count);
   v_n := v_n + 1;
  elsif o->>'op' = 'update' and length(v_text) >= 5 and o->>'id' ~* '^[0-9a-f-]{36}$' then
   update public.temperature_lessons set text = v_text, feedback = feedback + v_count, updated_at = now()
   where id = (o->>'id')::uuid and company_id = p_company and origin = 'mavi' and not locked and status = 'active';
   v_n := v_n + case when found then 1 else 0 end;
  elsif o->>'op' = 'retire' and o->>'id' ~* '^[0-9a-f-]{36}$' then
   delete from public.temperature_lessons
   where id = (o->>'id')::uuid and company_id = p_company and origin = 'mavi' and not locked;
   v_n := v_n + case when found then 1 else 0 end;
  end if;
 end loop;
 update public.temperature_feedback set learned_at = now()
 where company_id = p_company and id = any(coalesce(p_learned, '{}'));
 update public.temperature_settings set lessons_until = null, lessons_attempts = 0, lessons_error = null,
  lessons_at = now()
 where company_id = p_company;
 if p_usage is not null and jsonb_typeof(p_usage) = 'object' then
  insert into public.ai_usage(company_id, user_id, module, kind, client_id, model, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, cost_usd, provider_id, provider_name)
  values (p_company, null, 'clients', 'temperature_learning', null, left(coalesce(p_usage->>'model', ''), 80),
   greatest(coalesce((p_usage->>'input')::integer, 0), 0), greatest(coalesce((p_usage->>'output')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_read')::integer, 0), 0),
   greatest(coalesce((p_usage->>'cache_write')::integer, 0), 0),
   least(greatest(coalesce((p_usage->>'cost')::numeric, 0), 0), 100),
   case when p_usage->>'provider_id' ~* '^[0-9a-f-]{36}$' then (p_usage->>'provider_id')::uuid end,
   left(coalesce(p_usage->>'provider', ''), 120));
 end if;
 return v_n;
end $$;

-- Falhou: tenta de novo mais tarde; depois de 5 vezes, o lote conta como lido.
create function public.ai_temperature_lessons_fail(p_secret text, p_company uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_attempts integer; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 update public.temperature_settings set lessons_attempts = lessons_attempts + 1,
  lessons_error = left(coalesce(p_error, ''), 500),
  lessons_until = now() + (lessons_attempts + 1) * interval '15 minutes'
 where company_id = p_company
 returning lessons_attempts into v_attempts;
 if v_attempts >= 5 then
  update public.temperature_feedback set learned_at = now() where company_id = p_company and learned_at is null;
  update public.temperature_settings set lessons_attempts = 0, lessons_until = null where company_id = p_company;
 end if;
end $$;

revoke all on function public.ai_temperature_learning(text, uuid), public.ai_temperature_irrelevant(text, uuid[]),
 public.ai_temperature_lessons_claim(text), public.ai_temperature_lessons_store(text, uuid, jsonb, bigint[], jsonb),
 public.ai_temperature_lessons_fail(text, uuid, text) from public, anon, authenticated;
-- O worker chama como anon + segredo.
grant execute on function public.ai_temperature_learning(text, uuid), public.ai_temperature_irrelevant(text, uuid[]),
 public.ai_temperature_lessons_claim(text), public.ai_temperature_lessons_store(text, uuid, jsonb, bigint[], jsonb),
 public.ai_temperature_lessons_fail(text, uuid, text) to anon, authenticated;

-- A da migração 20270410090000, acordando também para escrever as regras.
create or replace function mavi_private.ai_temperature_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from public.temperature_signals x
   join public.clients k on k.id = x.client_id and not k.archived
   where x.status = 'pending' and x.dirty_at <= now() - interval '20 minutes'
    and (x.claimed_until is null or x.claimed_until < now())
    and x.company_id in (select co.id from public.companies co where mavi_private.temperature_route(co.id) is not null))
  and not exists (select 1 from mavi_private.temperature_state st where st.refresh_from is not null
   and mavi_private.temperature_refresh_due(st))
  and not exists (select 1 from mavi_private.temperature_state st
   join public.clients k on k.id = st.client_id and not k.archived
   where st.summary_pending and st.summary_attempts < 5
   and (st.summary_until is null or st.summary_until < now()))
  and not exists (select 1 from public.temperature_settings s
   where (s.lessons_until is null or s.lessons_until < now())
    and exists (select 1 from public.temperature_feedback f where f.company_id = s.company_id and f.learned_at is null)
    and not exists (select 1 from public.temperature_feedback f where f.company_id = s.company_id
     and f.learned_at is null and f.created_at > now() - interval '10 minutes')) then
  return;
 end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-temperature"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;
revoke all on function mavi_private.ai_temperature_kick() from public, anon, authenticated;

commit;
