begin;

-- MAVI · Radar do cliente: "Últimos registros" ao vivo.
--
-- A aba Painel da MAVI › Tarefas do Radar lia os registros só ao abrir: uma
-- tarefa criada ou vinculada a partir de um item, um item fechado sem tarefa
-- ou uma sugestão recusada só apareciam depois de recarregar a página. Agora
-- cada lote de registros novos ou mudados (inclusive os desfeitos) avisa a
-- empresa pelo Realtime (kind 'radar_task_signals'), uma vez por comando, e a
-- aba se recarrega sozinha.

create function mavi_private.radar_task_signals_broadcast() returns trigger
language plpgsql security definer set search_path = '' as $$
declare c uuid; begin
 for c in select distinct company_id from changed loop
  perform mavi_private.broadcast(c, jsonb_build_object('kind', 'radar_task_signals'));
 end loop;
 return null;
end $$;
revoke all on function mavi_private.radar_task_signals_broadcast() from public, anon, authenticated;

create trigger radar_task_signals_live_insert after insert on public.radar_task_signals
 referencing new table as changed for each statement execute function mavi_private.radar_task_signals_broadcast();
create trigger radar_task_signals_live_update after update on public.radar_task_signals
 referencing new table as changed for each statement execute function mavi_private.radar_task_signals_broadcast();

commit;
