begin;

-- Leaders can change a product's color (its dot and label across the app)
-- when editing it. Without p_color the color stays as it is.
drop function public.update_product(uuid, text);
create function public.update_product(p_product uuid, p_name text, p_color text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare p public.products; begin
  select * into p from public.products where id = p_product for update;
  if not found or not mavi_private.leader(p.company_id) then raise exception 'Sem permissão' using errcode = '42501'; end if;
  if p_color is not null and p_color !~ '^#[0-9A-Fa-f]{6}$' then
    raise exception 'Cor inválida: use o formato #RRGGBB.' using errcode = '22023';
  end if;
  update public.products set name = trim(p_name), color = coalesce(lower(p_color), color) where id = p_product;
end $$;
revoke all on function public.update_product(uuid, text, text) from public, anon;
grant execute on function public.update_product(uuid, text, text) to authenticated;

commit;
