-- Qual função do banco passa do tempo? Desde o main c899f36, a resposta do
-- worker traz o nome dela entre parênteses no fim da mensagem. Só leitura.

select to_char(created, 'DD/MM HH24:MI:SS') as quando, status_code,
 substring(content from 'statement timeout \(([a-z0-9_]+)\)') as funcao,
 left(content, 200) as resposta
from net._http_response
where content ilike '%statement timeout%'
order by created desc;
