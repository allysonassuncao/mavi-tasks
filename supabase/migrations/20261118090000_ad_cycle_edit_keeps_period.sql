begin;

-- Editar um ciclo sem mexer no período (só o M, a verba, os vínculos...) não
-- revalida a sobreposição: ciclos importados do MASO podem dividir o dia de
-- virada com o anterior, e isso travava qualquer edição. Criar um ciclo ou
-- mudar o início/término continua checando o conflito.
create or replace function mavi_private.ad_cycle_checks(c uuid, p_campaign uuid, p_cycle uuid, p_start date, p_end date,
 p_objective text, p_goal integer, p_budget numeric, p_destination text, p_landing_pages text[]) returns void
language plpgsql stable security definer set search_path = '' as $$
declare other public.ad_cycles; begin
 if p_start is null or p_end is null or p_end < p_start then
  raise exception 'O término precisa ser igual ou posterior ao início' using errcode = '22023';
 end if;
 if p_end - p_start >= 366 then
  raise exception 'Um ciclo não pode passar de um ano' using errcode = '22023';
 end if;
 if p_objective is null or p_objective not in ('lead','sale','message','traffic','engagement','custom','video') then
  raise exception 'Objetivo inválido' using errcode = '22023';
 end if;
 if p_goal is null or p_goal < 0 then
  raise exception 'Informe a quantidade de resultados esperada' using errcode = '22023';
 end if;
 if p_budget is null or p_budget < 0 then
  raise exception 'Informe a verba do ciclo' using errcode = '22023';
 end if;
 if p_destination is null or p_destination not in ('lead_form','external_page','make_landing_page') then
  raise exception 'Destino inválido' using errcode = '22023';
 end if;
 if p_destination = 'make_landing_page' and coalesce(cardinality(p_landing_pages), 0) = 0 then
  raise exception 'Informe ao menos uma página de captura da Make' using errcode = '22023';
 end if;
 if p_cycle is not null and exists (select 1 from public.ad_cycles where company_id = c and id = p_cycle
  and start_date = p_start and end_date = p_end) then
  return;
 end if;
 select * into other from public.ad_cycles where company_id = c and campaign_id = p_campaign
  and id is distinct from p_cycle and start_date <= p_end and end_date >= p_start
 order by start_date limit 1;
 if found then
  raise exception 'O período conflita com o ciclo de % a % desta campanha',
   to_char(other.start_date, 'DD/MM/YYYY'), to_char(other.end_date, 'DD/MM/YYYY') using errcode = '23P01';
 end if;
end $$;
revoke all on function mavi_private.ad_cycle_checks(uuid, uuid, uuid, date, date, text, integer, numeric, text, text[])
 from public, anon, authenticated;

commit;
