begin;

-- Busca da MAVI: um parágrafo longo sem pontuação de fim de frase (lista,
-- tabela colada, links, conversa sem ponto) virava um trecho só, de qualquer
-- tamanho. A OpenAI recusa texto acima de 8192 tokens e o lote inteiro falhava
-- de novo a cada rodada (em 05/10/2026: "Invalid 'input[54]': maximum input
-- length is 8192 tokens"). Agora a frase longa demais se divide também nas
-- quebras de linha e, se ainda passar, em pedaços de p_size caracteres (no
-- último espaço antes do limite). Texto que já cabia sai igual: os trechos
-- existentes não mudam; os documentos são refeitos quando mudarem.
create or replace function mavi_private.ai_split(p_text text, p_size integer default 1500) returns setof text
language plpgsql immutable set search_path = '' as $$
declare part text; buf text := ''; piece text; line text; cut integer; begin
 for part in select unnest(regexp_split_to_array(coalesce(p_text, ''), E'\\n\\s*\\n')) loop
  part := btrim(part, E' \n\t\r');
  continue when part = '';
  if length(part) > p_size then
   for piece in select unnest(regexp_split_to_array(part, E'(?<=[.!?…])\\s+')) loop
    for line in select unnest(case when length(piece) > p_size then regexp_split_to_array(piece, E'\\s*\\n\\s*')
      else array[piece] end) loop
     while length(line) > p_size loop
      cut := p_size - coalesce(nullif(strpos(reverse(left(line, p_size)), ' '), 0), 1) + 1;
      if cut < p_size / 2 then cut := p_size; end if;
      if buf <> '' then return next buf; buf := ''; end if;
      return next btrim(left(line, cut), E' \n\t\r');
      line := btrim(substr(line, cut + 1), E' \n\t\r');
     end loop;
     continue when line = '';
     if length(buf) + length(line) + 1 > p_size and buf <> '' then return next buf; buf := ''; end if;
     buf := btrim(buf || ' ' || line, E' \n\t\r');
    end loop;
   end loop;
  else
   if length(buf) + length(part) + 2 > p_size and buf <> '' then return next buf; buf := ''; end if;
   buf := btrim(buf || E'\n\n' || part, E' \n\t\r');
  end if;
 end loop;
 if buf <> '' then return next buf; end if;
end $$;

commit;
