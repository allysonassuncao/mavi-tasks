begin;

-- Campanhas: os leads das páginas de captura da Make ficam no MAVI. A
-- sincronização perguntava ao servidor da Make (api/capture/mavi-leads.php)
-- os leads distintos de cada página, e a consulta em dados_capture (milhões
-- de linhas, MyISAM, sem índice na página nem na data) passava do tempo:
-- "Make: The operation was aborted due to timeout". Agora a Make envia os
-- leads (o script de cadastro, na hora, e um envio agendado que segue o id
-- de dados_capture e garante que nada fica para trás), e a sincronização
-- conta aqui, com a mesma regra do MASO: os id_lead distintos e visíveis de
-- cada página no período.

-- Um lead por página e dia (dados_capture tem uma linha por campo do
-- formulário: todas do mesmo lead e dia viram uma). Só o necessário para
-- contar: nenhum dado pessoal do lead.
create table mavi_private.make_capture_leads (
 squeeze text not null check (squeeze ~ '^[0-9A-Za-z_-]{1,60}$' and squeeze <> '0'),
 day date not null,
 lead text not null check (length(lead) between 1 and 100),
 primary key (squeeze, day, lead)
);
alter table mavi_private.make_capture_leads enable row level security;
revoke all on mavi_private.make_capture_leads from public, anon, authenticated;

-- Até onde o envio agendado da Make chegou: o último id de dados_capture
-- lido e quando ele chegou ao fim da tabela pela última vez (a contagem só
-- vale para os dias antes disso).
create table mavi_private.make_capture_state (
 id boolean primary key default true check (id),
 cursor bigint not null default 0,
 caught_up_at timestamptz,
 seen_at timestamptz
);
alter table mavi_private.make_capture_state enable row level security;
revoke all on mavi_private.make_capture_state from public, anon, authenticated;
insert into mavi_private.make_capture_state default values;

-- Recebe um lote (api/make-leads, com ADS_SYNC_SECRET): [{squeeze, lead,
-- day}], já conferidos pelo servidor. Repetidos não duplicam. O envio
-- agendado manda também até onde leu (p_cursor) e se chegou ao fim (p_done);
-- o script de cadastro manda só o lead.
create function public.make_leads_ingest(p_secret text, p_leads jsonb,
 p_cursor bigint default null, p_done boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_inserted integer; v_state mavi_private.make_capture_state; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 if jsonb_typeof(p_leads) is distinct from 'array' or jsonb_array_length(p_leads) > 20000 then
  raise exception 'Envie de 0 a 20000 leads.' using errcode = '22023';
 end if;
 insert into mavi_private.make_capture_leads(squeeze, day, lead)
 select distinct x.squeeze, x.day, x.lead
  from jsonb_to_recordset(p_leads) as x(squeeze text, lead text, day date)
 on conflict do nothing;
 get diagnostics v_inserted = row_count;
 update mavi_private.make_capture_state set
  cursor = greatest(cursor, coalesce(p_cursor, cursor)),
  seen_at = case when p_cursor is null then seen_at else now() end,
  -- Um minuto antes: o que foi gravado na Make enquanto o lote viajava
  -- fica para o próximo envio.
  caught_up_at = case when p_cursor is not null and p_done
   then now() - interval '1 minute' else caught_up_at end
 where id
 returning * into v_state;
 return jsonb_build_object('inserted', v_inserted, 'cursor', v_state.cursor);
end $$;

-- Onde o envio agendado continua (o último id lido).
create function public.make_leads_status(p_secret text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_state mavi_private.make_capture_state; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select * into v_state from mavi_private.make_capture_state where id;
 return jsonb_build_object('cursor', v_state.cursor,
  'caught_up_at', v_state.caught_up_at, 'seen_at', v_state.seen_at);
end $$;

-- A contagem que o mavi-leads.php fazia, com a mesma resposta:
--  days: por dia, a soma (entre as páginas) dos leads distintos do dia;
--  total: a soma, por página, dos leads distintos do período;
--  firsts: por dia, a soma dos leads que apareceram pela primeira vez no
--  período naquele dia.
-- Nula enquanto o envio agendado não chegou ao fim da tabela depois do
-- último dia do período (horário de Brasília): a sincronização pergunta à
-- Make, como antes, em vez de contar leads que ainda não chegaram.
create function public.make_leads_count(p_secret text, p_squeezes text[],
 p_since date, p_until date)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_caught timestamptz; result jsonb; begin
 if not mavi_private.ad_sync_allowed(p_secret, null) then
  raise exception 'Sem permissão' using errcode = '42501';
 end if;
 select caught_up_at into v_caught from mavi_private.make_capture_state where id;
 if v_caught is null
  or v_caught < ((p_until + 1)::timestamp at time zone 'America/Sao_Paulo') then
  return null;
 end if;
 with rows as (
  select l.squeeze, l.lead, l.day from mavi_private.make_capture_leads l
  where l.squeeze = any(p_squeezes) and l.day between p_since and p_until
 ), firsts as (
  select min(r.day) as day from rows r group by r.squeeze, r.lead
 )
 select jsonb_build_object(
  'days', coalesce((select jsonb_object_agg(d.day, d.n) from
   (select r.day, count(*) as n from rows r group by r.day) d), '{}'),
  'total', (select count(*) from firsts),
  'firsts', coalesce((select jsonb_object_agg(f.day, f.n) from
   (select f.day, count(*) as n from firsts f group by f.day) f), '{}')
 ) into result;
 return result;
end $$;

revoke all on function public.make_leads_ingest(text, jsonb, bigint, boolean),
 public.make_leads_status(text),
 public.make_leads_count(text, text[], date, date) from public, anon, authenticated;
-- anon: o servidor do MAVI, com o segredo.
grant execute on function public.make_leads_ingest(text, jsonb, bigint, boolean),
 public.make_leads_status(text),
 public.make_leads_count(text, text[], date, date) to anon, authenticated;

commit;
