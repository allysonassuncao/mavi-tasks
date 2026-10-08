begin;

-- MAVI · Avaliação dinâmica: um teste não fica mais "Em andamento" para
-- sempre (pedido de 08/10/2026). Dois caminhos prendiam o teste:
-- 1. O worker caía no meio de um registro (a função da Vercel tem 300 s e o
--    teste roda depois das outras rotinas do aprendizado) sem marcar o erro.
--    Depois de 3 quedas o registro ficava "pendente" com 3 tentativas: a fila
--    não pegava mais (attempts < 3) e o teste não fechava (ainda havia
--    pendente). Os testes mais novos esperavam atrás dele.
-- 2. O fechamento (teto ou fila vazia) só rodava dentro do ai_eval_claim, e o
--    agendamento só acorda o worker quando há algo a fazer. Um teste que bateu
--    o teto não é "a fazer": só fechava se outra rotina acordasse o worker.
-- Agora a limpeza roda no próprio agendamento de 10 minutos, no banco.

-- Os registros que esgotaram as tentativas viram "sem resultado"; os testes no
-- teto ou sem pendentes (e sem registro rodando agora) fecham.
create or replace function mavi_private.ai_eval_sweep() returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; n integer := 0; begin
 update public.ai_eval_results x set status = 'error', claimed_until = null,
  last_error = left('não terminou em 3 tentativas' || coalesce(' (' || nullif(x.last_error, '') || ')', ''), 300)
 where x.status = 'pending' and x.attempts >= 3 and (x.claimed_until is null or x.claimed_until < now())
  and exists (select 1 from public.ai_eval_runs y where y.id = x.run_id and y.status = 'running');
 for r in select y.id from public.ai_eval_runs y where y.status = 'running' and (y.cost_usd >= y.cap_usd
   or not exists (select 1 from public.ai_eval_results z where z.run_id = y.id and z.status = 'pending'))
  and not exists (select 1 from public.ai_eval_results z where z.run_id = y.id and z.status = 'pending'
   and z.claimed_until > now())
 loop
  perform mavi_private.ai_eval_finish(r.id, 'done');
  n := n + 1;
 end loop;
 return n;
end $$;
revoke all on function mavi_private.ai_eval_sweep() from public, anon, authenticated;

-- A da migração 20270617090000, com a limpeza no lugar do fechamento próprio.
create or replace function public.ai_eval_claim(p_secret text, p_limit integer default 3) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare x public.ai_eval_results; r public.ai_eval_runs; s public.ai_samples; p mavi_private.ai_providers;
 v_out jsonb := '[]'; begin
 if not mavi_private.ai_secret_ok(p_secret) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 perform mavi_private.ai_eval_sweep();
 for x in select * from public.ai_eval_results y
  where y.run_id in (select d.run_id from mavi_private.ai_eval_due() d)
   and y.status = 'pending' and y.attempts < 3 and (y.claimed_until is null or y.claimed_until < now())
  order by y.id limit least(greatest(coalesce(p_limit, 3), 1), 6) for update skip locked
 loop
  update public.ai_eval_results set claimed_until = now() + interval '5 minutes', attempts = attempts + 1 where id = x.id;
  select * into r from public.ai_eval_runs where id = x.run_id;
  s := null;
  select * into s from public.ai_samples where id = x.sample_id;
  if s.id is null then
   update public.ai_eval_results set status = 'skipped', claimed_until = null, last_error = 'o registro saiu da fila'
   where id = x.id;
   continue;
  end if;
  p := null;
  if r.provider_id is not null then
   select * into p from mavi_private.ai_providers v where v.id = r.provider_id and v.active;
   if p.id is null then
    update public.ai_eval_results set status = 'error', claimed_until = null, last_error = 'provedor indisponível'
    where id = x.id;
    continue;
   end if;
  end if;
  v_out := v_out || jsonb_build_array(jsonb_build_object('id', x.id, 'run', r.id, 'company', r.company_id,
   'model', r.model,
   'sample', jsonb_build_object('id', s.id, 'feature', s.feature, 'request', s.request, 'answer', s.answer,
    'model', s.model),
   'provider', case when p.id is null then null else jsonb_build_object('provider_id', p.id, 'provider', p.name,
     'kind', p.kind, 'base_url', p.base_url, 'key_cipher', p.key_cipher,
     'price', (select m from jsonb_array_elements(p.models) m where m->>'id' = r.model limit 1)) end));
 end loop;
 return v_out;
end $$;

-- A da migração 20270601090000, com a limpeza antes de decidir se acorda o worker.
create or replace function mavi_private.ai_learning_kick() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg mavi_private.ai_config; begin
 perform mavi_private.ai_eval_sweep();
 select * into cfg from mavi_private.ai_config where id;
 if not found then return; end if;
 if not exists (select 1 from mavi_private.copilot_learning_due())
  and not exists (select 1 from mavi_private.mavi_learning_due())
  and not exists (select 1 from mavi_private.mavi_judge_due())
  and not exists (select 1 from mavi_private.mavi_person_due())
  and not exists (select 1 from mavi_private.ai_route_eval_due())
  and not exists (select 1 from mavi_private.ai_eval_due()) then return; end if;
 perform net.http_post(url := cfg.url, body := '{"action":"ai-learning"}'::jsonb,
  headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || cfg.secret),
  timeout_milliseconds := 60000);
end $$;

-- Os testes já presos fecham agora.
select mavi_private.ai_eval_sweep();

commit;
