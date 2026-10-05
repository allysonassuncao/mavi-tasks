begin;

-- Grupos do Whatsapp e Avisos de falhas saíram de Equipe e configurações
-- para o Painel da MAVI (/mavi#whatsapp, /mavi#avisos): os avisos novos das
-- rotinas do WhatsApp apontam para lá. Os já enviados (/configuracoes#config-…)
-- continuam abrindo a aba nova pelo redirecionamento do app.
create or replace function mavi_private.job_catalog()
returns table(job text, sort integer, label text, noun text, nouns text, fails boolean, stale_ok boolean,
 fail_after integer, stale_hours integer, link text)
language sql immutable set search_path = '' as $$
 values
  ('whatsapp_sweep', 1, 'Varredura do WhatsApp', null::text, null::text, true, true, 3, 6,
   '/mavi#whatsapp'),
  ('whatsapp_groups', 2, 'Leitura dos grupos do WhatsApp', 'grupo', 'grupos', true, false, 3, null::integer,
   '/mavi#whatsapp'),
  ('ads_sync', 3, 'Sincronização diária das campanhas', 'campanha', 'campanhas', true, true, 1, 30, '/campanhas'),
  ('ads_today', 4, 'Resultados de hoje das campanhas', 'campanha', 'campanhas', true, true, 4, null, '/campanhas'),
  ('campaign_insights', 5, 'Insights da MAVI nas campanhas', 'campanha', 'campanhas', true, false, 1, null,
   '/campanhas'),
  ('campaign_daily', 6, 'Leitura do dia da MAVI', 'campanha', 'campanhas', true, true, 1, null, '/campanhas'),
  ('make_leads', 7, 'Leads da página de captura da Make', null, null, false, true, null, 24, '/campanhas'),
  ('agent_sync', 8, 'Leitura do Agente Conversacional (n8n)', 'servidor', 'servidores', true, true, 2, 3,
   '/agente-conversacional'),
  ('social_media', 9, 'Publicação automática do Social Media', null, null, true, false, 1, null,
   '/planejamento/social-media'),
  ('radar', 10, 'Leituras do Radar do cliente', null, null, true, true, 3, null, '/radar'),
  ('temperature', 11, 'Leituras do Termômetro', null, null, true, true, 3, null, '/termometro'),
  ('task_recurrences', 12, 'Repetição de tarefas', 'tarefa', 'tarefas', true, false, 1, null, '/tarefas')
$$;
revoke all on function mavi_private.job_catalog() from public, anon, authenticated;

commit;
