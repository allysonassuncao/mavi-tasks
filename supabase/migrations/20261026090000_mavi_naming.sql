begin;

-- A inteligência do sistema se chama MAVI (no feminino: "a MAVI"). As
-- mensagens que o banco mostra deixam de dizer "IA": limites de gasto,
-- conversa compartilhada, custo do plano do Social Leads, regras de modelo e
-- o texto dos arquivos que a MAVI não lê. "Provedor de IA" continua, porque
-- fala do provedor do modelo.
--
-- Os valores guardados que o código compara (ex.: o motivo 'ajuste pedido à
-- IA' das versões do Social Leads) ficam como estão; a tela é que mostra
-- "MAVI".

create or replace function public.ai_check_limits(p_company uuid, p_client uuid, p_contract uuid, p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare l public.ai_limits; v_spent numeric; v_label text; v_start timestamptz := mavi_private.ai_month_start();
 blocked text; warnings jsonb := '[]'; begin
 if not mavi_private.member(p_company) then raise exception 'Sem acesso ao espaço' using errcode = '42501'; end if;
 for l in select * from public.ai_limits a where a.company_id = p_company and (
   a.scope_type = 'company'
   or (a.scope_type = 'user' and a.scope_id = auth.uid())
   or (a.scope_type = 'client' and a.scope_id = p_client)
   or (a.scope_type = 'contract' and a.scope_id = p_contract)
   or (a.scope_type = 'project' and a.scope_id = p_project))
 loop
  select coalesce(sum(u.cost_usd), 0) into v_spent from public.ai_usage u
  where u.company_id = p_company and u.created_at >= v_start and case l.scope_type
   when 'company' then true
   when 'user' then u.user_id = l.scope_id
   when 'client' then u.client_id = l.scope_id
   when 'contract' then u.contract_id = l.scope_id
   else u.project_id = l.scope_id end;
  v_label := case l.scope_type when 'company' then 'da empresa' when 'user' then 'para você'
   when 'client' then 'deste cliente' when 'contract' then 'deste produto' else 'deste projeto' end;
  if v_spent >= l.monthly_usd then
   blocked := coalesce(blocked, format('O limite mensal de uso da MAVI %s (US$ %s) foi atingido. Fale com um administrador ou gestor.',
    v_label, replace(to_char(l.monthly_usd, 'FM999990.00'), '.', ',')));
  elsif v_spent >= l.monthly_usd * 0.8 then
   warnings := warnings || to_jsonb(format('O uso da MAVI %s está em %s%% do limite do mês.', v_label,
    round(v_spent / l.monthly_usd * 100)));
  end if;
 end loop;
 return jsonb_build_object('blocked', blocked is not null, 'message', blocked, 'warnings', warnings);
end $$;

create or replace function public.ai_share_conversation(p_conversation uuid, p_users uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v public.ai_conversations; u uuid; s jsonb; refused jsonb := '[]'; shared uuid[] := '{}'; ok boolean; v_name text; begin
 select * into v from public.ai_conversations where id = p_conversation;
 if not found or v.owner_id <> auth.uid() or not mavi_private.member(v.company_id) then
  raise exception 'Só quem começou a conversa compartilha.' using errcode = '42501';
 end if;
 for u in select distinct x from unnest(coalesce(p_users, '{}')) x where x <> v.owner_id loop
  ok := exists (select 1 from public.memberships m where m.company_id = v.company_id and m.user_id = u and m.active);
  if ok then
   for s in select jsonb_array_elements(m.sources) from public.ai_messages m where m.conversation_id = v.id loop
    ok := case s->>'type'
      when 'task' then mavi_private.ai_user_sees_task(v.company_id, u, (s->>'id')::uuid)
      when 'social' then mavi_private.ai_user_sees_contract(v.company_id, u, nullif(s->>'contract_id', '')::uuid)
      when 'campaign' then mavi_private.ai_user_is_leader(v.company_id, u)
      else mavi_private.ai_user_sees_client(v.company_id, u, nullif(s->>'client_id', '')::uuid) end;
    exit when not ok;
   end loop;
   if not ok then
    refused := refused || jsonb_build_object('user', u, 'reason', 'não tem acesso a alguma fonte citada');
   else
    shared := shared || u;
   end if;
  else
   refused := refused || jsonb_build_object('user', u, 'reason', 'não está ativo na empresa');
  end if;
 end loop;
 delete from public.ai_conversation_shares where conversation_id = v.id and not (user_id = any(shared));
 select name into v_name from public.memberships where company_id = v.company_id and user_id = auth.uid();
 with added as (
  insert into public.ai_conversation_shares(company_id, conversation_id, user_id)
  select v.company_id, v.id, x from unnest(shared) x
  on conflict do nothing
  returning user_id)
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 select v.company_id, a.user_id, auth.uid(), null, 'ai_share',
  format('%s compartilhou uma conversa com a MAVI', coalesce(v_name, 'Alguém')), v.title,
  '/visao-geral?conversa=' || v.id
 from added a;
 return jsonb_build_object('shared', to_jsonb(shared), 'refused', refused);
end $$;

-- As notificações antigas de conversa compartilhada passam a dizer MAVI.
update public.notifications set title = replace(title, 'compartilhou uma conversa da IA',
 'compartilhou uma conversa com a MAVI')
where kind = 'ai_share' and title like '%compartilhou uma conversa da IA';

create or replace function public.social_leads_finish_job(p_job uuid, p_plan uuid, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare j public.social_leads_jobs; p public.social_leads_plans; client text; cost numeric; begin
 select * into j from public.social_leads_jobs where id = p_job for update;
 if not found or j.created_by <> auth.uid() then raise exception 'Geração não encontrada.' using errcode = 'P0002'; end if;
 if j.status <> 'running' then return; end if;
 update public.social_leads_jobs set status = case when p_error is null then 'done' else 'failed' end,
  error = left(p_error, 1000), plan_id = coalesce(p_plan, plan_id), finished_at = now()
 where id = p_job returning * into j;
 select coalesce(nullif(b.fields->>'clientName', ''), c.name) into client
 from public.contracts k join public.clients c on c.company_id = k.company_id and c.id = k.client_id
 left join public.social_leads_briefings b on b.company_id = k.company_id and b.contract_id = k.id
 where k.company_id = j.company_id and k.id = j.contract_id;
 select * into p from public.social_leads_plans where id = j.plan_id;
 select sum(cost_usd) into cost from public.social_leads_ai_usage where job_id = j.id;
 insert into public.notifications(company_id, user_id, actor_id, task_id, kind, title, body, link)
 values (j.company_id, j.created_by, null, null, 'social_leads',
  case when p_error is null then format('Plano do %s de %s pronto', coalesce(p.label, 'mês'), client)
   else format('A geração do plano de %s falhou', client) end,
  case when p_error is null
   then 'Revise os posts e envie para o cliente aprovar.'
    || coalesce(format(' Custo da MAVI: US$ %s.', replace(to_char(cost, 'FM9990.00'), '.', ',')), '')
   else left(p_error, 300) end,
  '/onboarding/social-leads?contrato=' || j.contract_id);
end $$;

update public.notifications set body = replace(body, ' Custo da IA: ', ' Custo da MAVI: ')
where kind = 'social_leads' and body like '% Custo da IA: %';

create or replace function public.ai_set_route(p_company uuid, p_type text, p_id uuid, p_provider uuid, p_model text) returns void
language plpgsql security definer set search_path = '' as $$ begin
 if not mavi_private.admin(p_company) then
  raise exception 'Só administradores escolhem qual modelo cada um usa.' using errcode = '42501';
 end if;
 if p_type not in ('company', 'user', 'client', 'contract', 'project') then raise exception 'Tipo inválido.' using errcode = '22023'; end if;
 if p_type <> 'company' and p_id is null then raise exception 'Escolha para quem vale a regra.' using errcode = '22023'; end if;
 if p_provider is null then
  delete from mavi_private.ai_routes where company_id = p_company and scope_type = p_type
   and scope_id is not distinct from case when p_type = 'company' then null else p_id end;
  return;
 end if;
 if not exists (select 1 from mavi_private.ai_providers p where p.id = p_provider and p.company_id = p_company
   and exists (select 1 from jsonb_array_elements(p.models) m where m->>'id' = p_model)) then
  raise exception 'Escolha um modelo cadastrado no provedor.' using errcode = '22023';
 end if;
 if p_type = 'user' and not exists (select 1 from public.memberships where company_id = p_company and user_id = p_id)
  or p_type = 'client' and not exists (select 1 from public.clients where company_id = p_company and id = p_id)
  or p_type = 'contract' and not exists (select 1 from public.contracts where company_id = p_company and id = p_id)
  or p_type = 'project' and not exists (select 1 from public.projects where company_id = p_company and id = p_id) then
  raise exception 'Não encontrado na empresa.' using errcode = 'P0002';
 end if;
 insert into mavi_private.ai_routes(company_id, scope_type, scope_id, provider_id, model)
 values (p_company, p_type, case when p_type = 'company' then null else p_id end, p_provider, p_model)
 on conflict (company_id, scope_type, scope_id) do update set provider_id = excluded.provider_id,
  model = excluded.model, updated_by = auth.uid(), updated_at = now();
end $$;

-- Só muda o texto dos arquivos que não são lidos; a fila refaz os que já
-- estão na base com esse texto.
create or replace function mavi_private.ai_build_drive_file(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare f record; t mavi_private.ai_file_texts; v_kind text; v_path text; v_header text; v_pieces jsonb := '[]';
 pg jsonb; n integer := 0; piece text; v_status text; v_size text; begin
 select x.*, cl.name as client_name, coalesce(nullif(p.name, ''), k.name) as product_name
  into f from public.drive_files x
  left join public.clients cl on cl.company_id = x.company_id and cl.id = x.client_id
  left join public.contracts k on k.company_id = x.company_id and k.id = x.contract_id
  left join public.products p on p.company_id = k.company_id and p.id = k.product_id
  where x.id = p_id;
 if not found or f.status <> 'ready' then
  perform mavi_private.ai_forget('drive_file', p_id);
  delete from mavi_private.ai_file_texts where file_id = p_id;
  return;
 end if;
 v_kind := mavi_private.ai_file_kind(f.content_type, f.name);
 select * into t from mavi_private.ai_file_texts where file_id = p_id;
 if not found then
  v_status := case when v_kind is null then 'unsupported' when f.size_bytes > 26214400 then 'too_large' else 'pending' end;
  insert into mavi_private.ai_file_texts(file_id, company_id, status) values (p_id, f.company_id, v_status)
  returning * into t;
 end if;
 with recursive chain as (
  select d.id, d.parent_id, d.name, 1 as depth from public.drive_folders d where d.id = f.folder_id
  union all
  select d.id, d.parent_id, d.name, c.depth + 1 from public.drive_folders d join chain c on d.id = c.parent_id
   where c.depth < 20)
 select string_agg(name, ' › ' order by depth desc) into v_path from chain;
 v_header := concat_ws(' · ', format('[Arquivo] "%s"', f.name),
  case when f.client_name is not null then 'cliente ' || f.client_name end,
  case when f.product_name is not null then 'produto ' || f.product_name end,
  case when v_path is not null then 'pasta ' || v_path end,
  'enviado em ' || to_char(f.created_at at time zone 'America/Sao_Paulo', 'DD/MM/YYYY'));
 if t.status = 'done' and jsonb_typeof(t.pages) = 'array' then
  for pg in select value from jsonb_array_elements(t.pages) loop
   n := n + 1;
   for piece in select mavi_private.ai_split(pg->>'text') loop
    v_pieces := v_pieces || jsonb_build_array(jsonb_build_object('text',
     case when pg->>'label' is not null then (pg->>'label') || E'\n' else '' end || piece,
     'meta', jsonb_strip_nulls(jsonb_build_object('kind', 'file', 'page', n, 'label', pg->>'label'))));
   end loop;
  end loop;
 end if;
 if jsonb_array_length(v_pieces) = 0 then
  v_size := case when f.size_bytes >= 1048576 then round(f.size_bytes / 1048576.0, 1) || ' MB'
   else greatest(1, round(f.size_bytes / 1024.0)) || ' KB' end;
  v_pieces := jsonb_build_array(jsonb_build_object('text', format('Arquivo %s (%s, %s). %s', f.name,
    coalesce(v_kind, f.content_type), v_size, case t.status
     when 'pending' then 'O conteúdo ainda está sendo lido.'
     when 'empty' then 'Sem texto legível (imagem ou PDF escaneado).'
     when 'unsupported' then 'O conteúdo deste tipo de arquivo não é lido pela MAVI.'
     when 'too_large' then 'Grande demais para a MAVI ler o conteúdo.'
     when 'error' then 'Não foi possível ler o conteúdo.'
     else '' end), 'meta', jsonb_build_object('kind', 'file_name')));
 end if;
 perform mavi_private.ai_save_document(f.company_id, 'drive_file', f.id, 'client', f.client_id, f.contract_id,
  null, null, f.name, f.created_at, v_header, v_pieces);
end $$;

select mavi_private.ai_enqueue('drive_file', coalesce(jsonb_agg(jsonb_build_object('id', t.file_id, 'company_id', t.company_id)), '[]'))
from mavi_private.ai_file_texts t where t.status in ('unsupported', 'too_large');

commit;
