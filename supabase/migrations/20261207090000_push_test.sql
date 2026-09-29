-- Notificações do navegador: "Enviar notificação de teste" (sino no topo).
-- O teste pelo servidor manda um push para os navegadores da própria pessoa,
-- pelo mesmo caminho dos avisos de verdade (pg_net → /api/push). A resposta
-- diz em que ponto a entrega pararia: sem push_config no banco ou sem nenhum
-- navegador registrado para a pessoa.
create function public.test_push() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.push_config; subs jsonb; n integer; me uuid := auth.uid(); begin
 if me is null then raise exception 'Faça login para testar as notificações.'; end if;
 select * into cfg from mavi_private.push_config where id;
 select count(*)::integer, jsonb_agg(jsonb_build_object('endpoint', s.endpoint,
  'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
  into n, subs
  from (select * from public.push_subscriptions where user_id = me
        order by seen_at desc limit 50) s;
 if cfg.url is null or n = 0 then
  return jsonb_build_object('configured', cfg.url is not null, 'browsers', n, 'sent', false);
 end if;
 perform net.http_post(
  url := cfg.url,
  body := jsonb_build_object('subscriptions', subs, 'message', jsonb_build_object(
   'title', 'Teste de notificação',
   'body', 'Chegou pelo servidor: os avisos também chegam com o app fechado.',
   'tag', 'mavi-test-push', 'url', '/')),
  headers := jsonb_build_object('Content-Type', 'application/json',
   'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 8000);
 return jsonb_build_object('configured', true, 'browsers', n, 'sent', true);
end $$;
revoke all on function public.test_push() from public, anon;
grant execute on function public.test_push() to authenticated;
