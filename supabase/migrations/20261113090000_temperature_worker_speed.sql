begin;

-- Termômetro do cliente · o worker dentro do tempo do banco.
--
-- O worker fala com o banco pela API (anon + segredo), onde cada consulta
-- tem poucos segundos. ai_temperature_claim montava de uma vez o material
-- de 24 leituras (transcrições inteiras, dias inteiros de grupo) e estourava
-- o tempo: nada era reservado nem lido. Agora:
-- - ai_temperature_claim só reserva (sem material);
-- - ai_temperature_material monta uma leitura por chamada (o worker chama
--   várias em paralelo); sem fala do cliente, marca a leitura como pulada;
-- - o recálculo de cada dia em somas móveis (antes, cada leitura entrava uma
--   vez para cada dia da janela);
-- - quem é do time entre os falantes: decidido uma vez por falante (antes,
--   a consulta refazia a decisão para cada fala da transcrição) e com o nome
--   do falante normalizado uma vez só.

create or replace function mavi_private.temperature_is_team(p_speaker text, p_names text[]) returns boolean
language sql immutable set search_path = '' as $$
 select exists (
  select 1 from (select mavi_private.temperature_norm(p_speaker) as sp) s, unnest(p_names) n
  where n <> '' and s.sp <> '' and (
   n = s.sp
   or (strpos(s.sp, ' ') > 0 and n like s.sp || ' %')
   or (strpos(n, ' ') > 0 and s.sp like n || ' %')
   or (strpos(n, ' ') > 0 and strpos(s.sp, ' ') > 0 and split_part(n, ' ', 1) = split_part(s.sp, ' ', 1)
    and regexp_replace(n, '^.* ', '') = regexp_replace(s.sp, '^.* ', ''))))
$$;

-- O "estado" que o Jev lê de uma leitura (e o trecho para a tela). Nulo:
-- não há o que ler; state nulo: não há fala do cliente.
create or replace function mavi_private.temperature_material(p_id uuid) returns jsonb
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
  -- Os nomes do time, já normalizados (quem gravou também é membro).
  select coalesce(array_agg(distinct mavi_private.temperature_norm(x.name)), '{}') into v_names
  from public.memberships x where x.company_id = g.company_id;
  -- Materializadas: os papéis são decididos uma vez por falante, não por fala.
  with seg as materialized (
   select e.n, btrim(coalesce(e.s->>3, '')) as txt,
    coalesce(nullif(r.t_speakers[((e.s->>2)::integer) + 1], ''), 'Falante ' || (coalesce((e.s->>2)::integer, 0) + 1)) as who
   from jsonb_array_elements(coalesce(r.segments, '[]')) with ordinality e(s, n)
  ), roles as materialized (
   select q.who, case when q.who ~ '^Falante \d+$' then 'não identificado'
    when mavi_private.temperature_is_team(q.who, v_names) then 'time'
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

-- A temperatura de cada dia, com o mesmo resultado de antes, mas em somas
-- móveis: o peso pela idade é 2^((dia da leitura − dia)/meia-vida), então a
-- média de cada dia é Σ(peso × nota) / Σ(peso) das leituras da janela, e o
-- fator do dia se cancela. Cada leitura entra uma vez (no dia dela) em vez de
-- uma vez para cada dia da janela: um cliente com 400 dias de histórico
-- recalcula em uma fração do tempo.
create or replace function mavi_private.temperature_series(c uuid, p_client uuid, p_from date, p_to date)
returns table(day date, score numeric, indicators jsonb, flags text[], signals integer)
language plpgsql stable security definer set search_path = '' as $$
declare st public.temperature_settings; v_win integer; v_fd integer; v_h float8; v_o date; begin
 select * into st from public.temperature_settings where company_id = c;
 if not found or p_to < p_from then return; end if;
 v_win := st.window_days;
 v_fd := st.flag_days;
 v_h := st.half_life_days;
 v_o := p_from - greatest(v_win, v_fd);
 return query
 with ind as (select * from mavi_private.temperature_client_indicators(c, p_client)),
 sig as (
  select x.day as sday, x.answers, x.flags as fl,
   (case x.source_type when 'meeting' then st.meeting_weight else st.whatsapp_weight end)::float8 as w
  from public.temperature_signals x
  where x.client_id = p_client and x.status <> 'skipped' and x.answers <> '{}' and x.day > v_o and x.day <= p_to
 ),
 grid as (select gs::date as gday from generate_series(v_o + 1, p_to, interval '1 day') gs),
 skeys as (select ind.key from ind where ind.kind = 'score'),
 fkeys as (select ind.key from ind where ind.kind = 'flag'),
 per as (
  select sig.sday, a.key,
   sum(sig.w * q.e * q.conf * q.v * q.f) as sa, sum(sig.w * q.e * q.conf * q.f) as sb, sum(sig.w * q.e * q.f) as se
  from sig
  cross join lateral jsonb_each(sig.answers) a
  cross join lateral (select (a.value->>'v')::float8 as v,
    least(greatest(coalesce((a.value->>'e')::float8, 1), 0), 1) as e,
    least(greatest(coalesce((a.value->>'c')::float8, 1), 0.05), 1) as conf,
    power(2::float8, (sig.sday - v_o)::float8 / v_h) as f) q
  where jsonb_typeof(a.value->'v') = 'number' and q.e >= 0.15 and a.key in (select skeys.key from skeys)
  group by 1, 2
 ),
 roll as (
  select g.gday, k.key,
   sum(coalesce(p.sa, 0)) over w as sa, sum(coalesce(p.sb, 0)) over w as sb, sum(coalesce(p.se, 0)) over w as se
  from grid g cross join skeys k left join per p on p.sday = g.gday and p.key = k.key
  window w as (partition by k.key order by g.gday rows between v_win - 1 preceding and current row)
 ),
 ok as (
  select r.gday, r.key, r.sa / r.sb as val from roll r
  where r.gday >= p_from and r.sb > 0 and r.se * power(2::float8, -((r.gday - v_o)::float8 / v_h)) >= 0.3
 ),
 overall as (
  select ok.gday, sum(ind.weight::float8 * ok.val) / nullif(sum(ind.weight::float8), 0) as sc,
   jsonb_object_agg(ok.key, round(ok.val::numeric, 1)) as inds
  from ok join ind on ind.key = ok.key
  group by ok.gday
 ),
 fper as (
  select sig.sday, f.key, max(f.value::float8) as p
  from sig cross join lateral jsonb_each_text(sig.fl) f
  where f.value ~ '^[0-9.]+$' and f.key in (select fkeys.key from fkeys)
  group by 1, 2
 ),
 froll as (
  select g.gday, k.key,
   max(p.p) over (partition by k.key order by g.gday rows between v_fd - 1 preceding and current row) as p
  from grid g cross join fkeys k left join fper p on p.sday = g.gday and p.key = k.key
 ),
 fls as (
  select froll.gday, array_agg(froll.key order by froll.key) as fs from froll
  where froll.gday >= p_from and froll.p >= st.flag_threshold
  group by froll.gday
 ),
 cper as (select sig.sday, count(*) as n from sig group by sig.sday),
 croll as (
  select g.gday, sum(coalesce(cp.n, 0)) over (order by g.gday rows between v_win - 1 preceding and current row) as n
  from grid g left join cper cp on cp.sday = g.gday
 )
 select g.gday, round(o.sc::numeric, 1), coalesce(o.inds, '{}'::jsonb), coalesce(fls.fs, '{}'::text[]),
  coalesce(cr.n, 0)::integer
 from grid g
 left join overall o on o.gday = g.gday
 left join fls on fls.gday = g.gday
 left join croll cr on cr.gday = g.gday
 where g.gday >= p_from;
end $$;

-- Só reserva as leituras (o material vem por ai_temperature_material).
create or replace function public.ai_temperature_claim(p_secret text, p_limit integer default 30) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_out jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 with ready as (
  select co.id from public.companies co where mavi_private.temperature_route(co.id) is not null
 ), due as (
  select x.id from public.temperature_signals x
  join public.clients k on k.id = x.client_id and not k.archived
  where x.status = 'pending' and x.dirty_at <= now() - interval '20 minutes'
   and (x.claimed_until is null or x.claimed_until < now())
   and x.company_id in (select id from ready)
  order by x.occurred_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 60)
  for update of x skip locked
 ), claimed as (
  update public.temperature_signals x set claimed_at = now(), claimed_until = now() + interval '5 minutes'
  from due where x.id = due.id
  returning x.id, x.company_id, x.client_id, x.source_type, x.occurred_at
 )
 select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'company_id', c.company_id, 'client_id', c.client_id,
   'source_type', c.source_type, 'version', s.version) order by c.occurred_at desc), '[]') into v_out
 from claimed c left join public.temperature_settings s on s.company_id = c.company_id;
 return v_out;
end $$;

-- O material de uma leitura reservada: {state, excerpt, message_id,
-- client_lines}. Sem fala do cliente: a leitura é pulada e volta nulo.
create function public.ai_temperature_material(p_secret text, p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare g public.temperature_signals; v_mat jsonb; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 select * into g from public.temperature_signals where id = p_id;
 if not found then return null; end if;
 v_mat := mavi_private.temperature_material(g.id);
 if v_mat is null or jsonb_typeof(v_mat->'state') is distinct from 'object' then
  update public.temperature_signals set status = 'skipped', answers = '{}', flags = '{}', reason = null,
   client_lines = 0, claimed_until = null, evaluated_at = now()
  where id = g.id;
  perform mavi_private.temperature_mark(g.company_id, g.client_id, g.day);
  return null;
 end if;
 return v_mat;
end $$;

revoke all on function mavi_private.temperature_is_team(text, text[]), mavi_private.temperature_material(uuid),
 mavi_private.temperature_series(uuid, uuid, date, date) from public, anon, authenticated;
revoke all on function public.ai_temperature_material(text, uuid) from public, anon, authenticated;
grant execute on function public.ai_temperature_material(text, uuid) to anon, authenticated;

commit;
