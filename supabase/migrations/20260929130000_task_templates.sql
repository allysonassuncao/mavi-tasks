begin;

-- Task templates: extra fields a task must (or may) carry, set up by
-- leaders for a catalog product, a team, or both.
--
-- * A template applies to a new task when its product is the task's
--   (contracted) product and its team is one of the assignee's teams; an
--   empty product or team means "any". Every template that applies adds its
--   fields (grouped under the template's name).
-- * When the task is created its fields are copied into it together with
--   the values (tasks.custom_fields): later changes to a template only
--   affect new tasks.
-- * Values are checked here — types, options, required fields — so no
--   client can skip them. Whoever may edit the task may change them later,
--   without the side effects of editing its content (approvals and status
--   stay as they are).

create table public.task_templates (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references public.companies(id),
 name text not null check (length(trim(name)) between 2 and 80),
 product_id uuid,
 team_id uuid,
 fields jsonb not null default '[]',
 active boolean not null default true,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (company_id, id),
 foreign key (company_id, product_id) references public.products(company_id, id),
 foreign key (company_id, team_id) references public.teams(company_id, id),
 check (product_id is not null or team_id is not null)
);
create index task_templates_company on public.task_templates(company_id) where active;
alter table public.task_templates enable row level security;
revoke all on public.task_templates from public, anon, authenticated;
grant select on public.task_templates to authenticated;
-- Everyone creating tasks needs them; changes go through the functions below.
create policy task_templates_read on public.task_templates for select to authenticated
 using (mavi_private.member(company_id));

alter table public.tasks add column custom_fields jsonb not null default '[]';

-- Field types and their values:
--   text (≤ 500) · textarea (≤ 5000) · url (http/https) · number · date
--   select (one of the options) · multiselect (some of them) · checkbox (yes/no)
create function mavi_private.template_fields_valid(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
 select coalesce(jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 40
  and (select count(distinct f->>'id') = count(*) from jsonb_array_elements(p) f)
  -- coalesce: a missing attribute makes a check null, which must count as invalid.
  and not exists (select 1 from jsonb_array_elements(p) f where not coalesce((
   jsonb_typeof(f) = 'object'
   and coalesce(f->>'id', '') ~ '^[a-z0-9_-]{1,40}$'
   and length(trim(coalesce(f->>'label', ''))) between 1 and 120
   and f->>'type' in ('text', 'textarea', 'url', 'number', 'date', 'select', 'multiselect', 'checkbox')
   and jsonb_typeof(coalesce(f->'required', 'false'::jsonb)) = 'boolean'
   and length(coalesce(f->>'help', '')) <= 300
   and (case when f->>'type' in ('select', 'multiselect') then
     jsonb_typeof(f->'options') = 'array' and jsonb_array_length(f->'options') between 1 and 50
     and not exists (select 1 from jsonb_array_elements(f->'options') o
      where jsonb_typeof(o) <> 'string' or length(trim(o #>> '{}')) not between 1 and 120)
    else true end)), false)), false)
$$;
revoke all on function mavi_private.template_fields_valid(jsonb) from public, anon, authenticated;
alter table public.task_templates add constraint task_templates_fields_valid
 check (mavi_private.template_fields_valid(fields));

-- The templates that apply to a task of this contract for this assignee.
create function mavi_private.matching_templates(c uuid, p_contract uuid, p_assignee uuid)
 returns setof public.task_templates
language sql stable security definer set search_path = '' as $$
 select t.* from public.task_templates t
 where t.company_id = c and t.active
  and (t.product_id is null or t.product_id = (select k.product_id from public.contracts k
   where k.company_id = c and k.id = p_contract))
  and (t.team_id is null or exists (select 1 from public.team_members tm
   where tm.company_id = c and tm.team_id = t.team_id and tm.user_id = p_assignee))
 order by t.name, t.id
$$;
revoke all on function mavi_private.matching_templates(uuid, uuid, uuid) from public, anon, authenticated;

-- A value as stored for its field type; null when empty. Raises on values
-- the type doesn't accept.
create function mavi_private.custom_value(f jsonb, v jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare label text := f->>'label'; t text := f->>'type'; s text; begin
 if v is null or v = 'null'::jsonb or v = '""'::jsonb or v = '[]'::jsonb then return null; end if;
 case t
 when 'checkbox' then
  if jsonb_typeof(v) <> 'boolean' then raise exception 'Valor inválido em "%"', label; end if;
  return case when v = 'true'::jsonb then v else null end;
 when 'number' then
  s := v #>> '{}';
  if s !~ '^-?\d+([.,]\d+)?$' then raise exception 'Informe um número em "%"', label; end if;
  return to_jsonb(replace(s, ',', '.')::numeric);
 when 'date' then
  s := v #>> '{}';
  if s !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'Informe uma data em "%"', label; end if;
  perform s::date;
  return to_jsonb(s);
 when 'multiselect' then
  if jsonb_typeof(v) <> 'array' or exists (select 1 from jsonb_array_elements(v) o
   where not f->'options' @> jsonb_build_array(o)) then
   raise exception 'Escolha opções da lista em "%"', label; end if;
  return (select jsonb_agg(distinct o) from jsonb_array_elements(v) o);
 else
  if jsonb_typeof(v) <> 'string' then raise exception 'Valor inválido em "%"', label; end if;
  s := trim(v #>> '{}');
  if s = '' then return null; end if;
  if t = 'select' and not f->'options' @> jsonb_build_array(s) then
   raise exception 'Escolha uma opção da lista em "%"', label; end if;
  if t = 'url' and s !~* '^https?://\S+$' then raise exception 'Informe um link (http:// ou https://) em "%"', label; end if;
  if length(s) > (case t when 'textarea' then 5000 when 'url' then 2000 else 500 end) then
   raise exception 'Texto longo demais em "%"', label; end if;
  return to_jsonb(s);
 end case;
exception when invalid_datetime_format or datetime_field_overflow then
 raise exception 'Informe uma data válida em "%"', label;
end $$;
revoke all on function mavi_private.custom_value(jsonb, jsonb) from public, anon, authenticated;

-- Fields plus values, keyed "<template id>.<field id>" in p_values; checks
-- required fields. The result is what the task stores.
create function mavi_private.fill_custom_fields(p_fields jsonb, p_values jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare f jsonb; v jsonb; out jsonb := '[]'; begin
 for f in select * from jsonb_array_elements(coalesce(p_fields, '[]')) loop
  v := mavi_private.custom_value(f, coalesce(p_values, '{}') -> ((f->>'template_id') || '.' || (f->>'id')));
  if v is null and coalesce((f->>'required')::boolean, false) then
   raise exception 'Preencha o campo obrigatório "%"', f->>'label';
  end if;
  out := out || jsonb_build_array(f || jsonb_build_object('value', v));
 end loop;
 return out;
end $$;
revoke all on function mavi_private.fill_custom_fields(jsonb, jsonb) from public, anon, authenticated;

-- The fields of the templates that apply, flattened (each tagged with its
-- template), as a new task will store them.
create function mavi_private.template_fields_for(c uuid, p_contract uuid, p_assignee uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
 select coalesce(jsonb_agg(f || jsonb_build_object('template_id', t.id, 'template_name', t.name)
  order by t.name, t.id, n), '[]')
 from mavi_private.matching_templates(c, p_contract, p_assignee) t,
  jsonb_array_elements(t.fields) with ordinality as x(f, n)
$$;
revoke all on function mavi_private.template_fields_for(uuid, uuid, uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ tasks
drop function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date);
create function public.create_task(p_company uuid,p_contract uuid,p_title text,p_assignee uuid,p_due date,
 p_project uuid default null,p_team uuid default null,p_description text default '',p_priority text default 'normal',
 p_estimated integer default 0,p_client_approval boolean default false,p_parent uuid default null,p_start date default null,
 p_custom jsonb default '{}') returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; custom jsonb; begin
 if not mavi_private.contract_access(p_company,p_contract) then raise exception 'Sem acesso ao produto contratado' using errcode='42501'; end if;
 if not exists(select 1 from public.memberships where company_id=p_company and user_id=p_assignee and active) then raise exception 'Responsável inválido'; end if;
 if p_team is not null and not exists(
  select 1 from public.contracts k join public.client_teams ct on ct.company_id=k.company_id and ct.client_id=k.client_id
  where k.company_id=p_company and k.id=p_contract and ct.team_id=p_team) then raise exception 'Equipe não atende este cliente'; end if;
 if p_parent is not null and not mavi_private.can_edit(p_company,p_parent) then raise exception 'Sem acesso à tarefa principal' using errcode='42501'; end if;
 custom := mavi_private.fill_custom_fields(mavi_private.template_fields_for(p_company,p_contract,p_assignee), p_custom);
 insert into public.tasks(company_id,contract_id,title,assignee_id,due_date,original_due_date,project_id,team_id,description,priority,estimated_minutes,requires_client_approval,parent_id,start_date,custom_fields)
 values(p_company,p_contract,trim(p_title),p_assignee,p_due,p_due,p_project,p_team,p_description,p_priority,p_estimated,p_client_approval,p_parent,p_start,custom) returning id into result;
 insert into public.task_events(company_id,task_id,actor_id,action) values(p_company,result,auth.uid(),'created'); return result;
end $$;
revoke all on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb) from public, anon;
grant execute on function public.create_task(uuid,uuid,text,uuid,date,uuid,uuid,text,text,integer,boolean,uuid,date,jsonb) to authenticated;

-- Changes the values of the fields the task already carries (its own copy).
create function public.set_task_custom_fields(p_task uuid, p_version integer, p_values jsonb) returns public.tasks
language plpgsql security definer set search_path = '' as $$ declare t public.tasks; filled jsonb; begin
 select * into t from public.tasks where id = p_task for update;
 if not found or not mavi_private.can_edit(t.company_id, t.id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 if t.version <> p_version then raise exception 'A tarefa mudou. Atualize antes de continuar.' using errcode = '40001'; end if;
 filled := mavi_private.fill_custom_fields(
  (select coalesce(jsonb_agg(f - 'value' order by n), '[]') from jsonb_array_elements(t.custom_fields) with ordinality x(f, n)),
  p_values);
 update public.tasks set custom_fields = filled, version = version + 1 where id = t.id returning * into t;
 insert into public.task_events(company_id, task_id, actor_id, action) values (t.company_id, t.id, auth.uid(), 'fields_edited');
 return t;
end $$;
revoke all on function public.set_task_custom_fields(uuid, integer, jsonb) from public, anon;
grant execute on function public.set_task_custom_fields(uuid, integer, jsonb) to authenticated;

-- ------------------------------------------------------------ builder
create function public.save_task_template(p_company uuid, p_id uuid, p_name text, p_product uuid,
 p_team uuid, p_fields jsonb, p_active boolean default true) returns uuid
language plpgsql security definer set search_path = '' as $$ declare result uuid; begin
 if not mavi_private.leader(p_company) then
  raise exception 'Somente administradores e gestores configuram templates' using errcode = '42501';
 end if;
 if p_product is null and p_team is null then raise exception 'Escolha um produto, uma equipe ou os dois.'; end if;
 if not mavi_private.template_fields_valid(p_fields) then
  raise exception 'Revise os campos: cada um precisa de nome e tipo; listas precisam de opções.';
 end if;
 if p_id is null then
  insert into public.task_templates(company_id, name, product_id, team_id, fields, active)
  values (p_company, trim(p_name), p_product, p_team, p_fields, coalesce(p_active, true)) returning id into result;
 else
  update public.task_templates set name = trim(p_name), product_id = p_product, team_id = p_team,
   fields = p_fields, active = coalesce(p_active, true), updated_at = now()
  where company_id = p_company and id = p_id returning id into result;
  if result is null then raise exception 'Template não encontrado'; end if;
 end if;
 return result;
end $$;
revoke all on function public.save_task_template(uuid, uuid, text, uuid, uuid, jsonb, boolean) from public, anon;
grant execute on function public.save_task_template(uuid, uuid, text, uuid, uuid, jsonb, boolean) to authenticated;

-- Tasks keep their copy of the fields, so a template can always be removed.
create function public.delete_task_template(p_template uuid) returns void
language plpgsql security definer set search_path = '' as $$ declare c uuid; begin
 select company_id into c from public.task_templates where id = p_template;
 if c is null or not mavi_private.leader(c) then raise exception 'Sem permissão' using errcode = '42501'; end if;
 delete from public.task_templates where id = p_template;
end $$;
revoke all on function public.delete_task_template(uuid) from public, anon;
grant execute on function public.delete_task_template(uuid) to authenticated;

-- Open apps reload their catalogs (and so the templates) when one changes.
create trigger broadcast_lookup after insert or update or delete on public.task_templates
 for each row execute function mavi_private.broadcast_lookup();

commit;
