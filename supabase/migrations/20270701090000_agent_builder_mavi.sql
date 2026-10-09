begin;

-- Agentes MAVI › a MAVI monta o agente (api/_agent-builder-mavi.ts).
--
-- "Quem usa qual modelo" ganha a funcionalidade 'agent_builder': o modelo da
-- conversa ao lado do construtor de agentes, que entrevista a pessoa, lê o
-- site, os arquivos e o prompt do n8n e propõe os campos e os itens da base
-- de conhecimento. Nada novo é gravado aqui: a proposta fica na tela até a
-- pessoa aplicar; o custo entra em ai_usage (módulo 'agents').

do $$ declare v text[]; begin
 v := array(select distinct x from unnest(mavi_private.ai_route_features() || array['agent_builder']) x order by x);
 alter table mavi_private.ai_routes drop constraint ai_routes_feature_check;
 execute format('alter table mavi_private.ai_routes add constraint ai_routes_feature_check check ('
  '(scope_type = ''feature'') = (feature is not null) and (feature is null or feature in (%s)))',
  (select string_agg(quote_literal(x), ',') from unnest(v) x));
end $$;

commit;
