begin;

-- O campo "Projeto" na criação de tarefas passa a ser escolha de cada
-- produto: gestores e administradores decidem, ao editar o produto, se ele
-- aparece. Ligado (o padrão, como era antes), o campo aparece quando o
-- produto contratado tem projetos; desligado, não aparece para aquele
-- produto em nenhum cliente.
alter table public.products add column task_project_field boolean not null default true;

-- Without p_task_project_field (or p_color) that setting stays as it is.
drop function public.update_product(uuid, text, text);
create function public.update_product(p_product uuid, p_name text, p_color text default null,
 p_task_project_field boolean default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; begin
  select * into p from public.products where id = p_product for update;
  if not found or not mavi_private.leader(p.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Cor inválida: use o formato #RRGGBB.' using errcode = '22023';
  end if;
  update public.products set name = trim(p_name), color = coalesce(lower(p_color), color),
   task_project_field = coalesce(p_task_project_field, task_project_field)
  where id = p_product;
end $$;
revoke all on function public.update_product(uuid, text, text, boolean) from public, anon;
grant execute on function public.update_product(uuid, text, text, boolean) to authenticated;

commit;
