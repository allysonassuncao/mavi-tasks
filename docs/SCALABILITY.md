# Escalabilidade e manutenção

Supabase publicado em 21/09/2026 no projeto `zajlipvbotjafkowohmn`, após autorização do proprietário. Migration `20260921113148`, Edge Functions `invite-user` e `storage-reconcile` (versão 1), secrets, Vault e quatro jobs ativos. O frontend não foi publicado nesta etapa.

## Publicação verificada

- `APP_ORIGIN`: `https://mavi.maso.app.br`; origem adicional: `https://mavi-tasks.vercel.app`. CORS reflete apenas uma origem autorizada. O convite retorna a `/?setup=1` no domínio de origem da solicitação.
- Os dois retornos foram adicionados ao Auth. As demais configurações, incluindo Site URL existente na Vercel, foram preservadas.
- Segredo da manutenção gerado aleatoriamente, armazenado nos secrets das funções e no Vault; nenhum valor secreto versionado.
- Teste hospedado `supabase/tests/remote_smoke.sql`: RLS, aprovações, relatórios, RPC unificada e cota de convites aprovados. Fixtures e consumo da cota de teste revertidos por `ROLLBACK`.
- Preflight dos dois domínios: HTTP 204. Origem desconhecida/ausente: HTTP 403. POST sem autenticação nas duas funções: HTTP 401. Nenhum convite real enviado; entrega por e-mail não foi testada.
- Reconciliação autenticada: HTTP 200, um item pendente processado. Fila posterior vazia. Retenção e reconciliação também tiveram execuções agendadas bem-sucedidas; nenhum evento anterior a um mês permaneceu no momento da verificação.
- Advisors pós-publicação: nenhum aviso de segurança novo em RPC pública. Permanecem os avisos anteriores documentados ao final; as duas novas tabelas privadas acrescentam avisos informativos de RLS sem política, intencionais. Performance: somente índices ainda sem uso observado, informativos.

## Comportamento

- Auditoria: retenção de **um mês de calendário** (`now() - interval '1 month'`), conforme solicitado. O cron remove até 5.000 eventos a cada 10 minutos, usando índice temporal e `SKIP LOCKED`. Backlogs grandes podem levar mais de uma execução. O índice `(company_id, created_at)` já existia na migration de performance; a nova migration assegura sua presença sem duplicá-lo.
- A remoção é definitiva. O relatório de entregas conta eventos e, portanto, só terá histórico dentro dessa retenção. Tarefas e apontamentos de horas não são removidos. A interface informa o limite no cartão de entregas. Não foi necessário reconstruir a tabela como particionada para atender a essa retenção.
- Atrasos: índice parcial `(company_id, due_date, id) WHERE NOT archived AND status <> 'done'`, alinhado ao filtro e à paginação. O índice anterior com `status` antes do prazo permanece para consultas que filtram um status específico.
- RLS: listagens de tarefas e contratos usam conjuntos de empresas/vínculos calculados sem correlação com cada linha. Comentários, anexos e eventos consultam a política otimizada de tarefas. As funções de autorização pontual das mutações permanecem em vigor.
- Detalhes: `task_extras(p_task)` usa `SECURITY INVOKER`, respeita RLS e retorna `comments`, `attachments` e `events`, até 100 itens por coleção, ordenados por data e ID decrescentes, em uma chamada.
- Convites: somente `APP_ORIGIN` e as origens explicitamente listadas em `APP_ADDITIONAL_ORIGINS` são aceitas; origem ausente ou `null` é rejeitada. A origem não autentica: o JWT é validado por `getUser`, o vínculo de administrador ativo é consultado no banco e a RPC repete essa autorização. Limites atômicos por janela de hora: **10 tentativas por administrador/empresa e 50 por empresa**, compartilhados entre instâncias. Tentativas que falham no Auth também consomem cota. Resposta `429` inclui `Retry-After`; falha do banco bloqueia o envio com `503`.
- Storage: carência de **24 horas**. Imagens ainda sem vínculo, metadados de anexos sem upload e objetos sem metadados são reconciliados. Anexos com upload concluído e imagens vinculadas são preservados. Remover uma imagem do texto depois de vinculá-la não a torna elegível nesta rotina.
- A coleta de imagens trava e remove os metadados em transação, usando o mesmo bloqueio da vinculação. Assim, uma imagem já coletada não pode ser salva enquanto o blob está sendo apagado. A fila privada persiste nas falhas; o lease de 15 minutos permite retomada. Exclusões de blobs passam exclusivamente pela Storage API, nunca por `DELETE storage.objects`. Uploads que terminam após expirar o registro pendente são encontrados na reconciliação seguinte, após a carência.
- A Edge Function processa até 100 objetos a cada 15 minutos. Ela usa um segredo próprio do agendador, sem expor a chave `service_role`. Falhas retornam HTTP 500 e deixam itens para nova tentativa. A fila é esvaziada após sucesso; contadores de convite expiram após dois dias e histórico dos jobs após sete dias.
- Build: chunks independentes para React, Supabase, Tiptap/ProseMirror, Radix/Floating UI e calendário. Relatórios e calendário/Gantt usam `React.lazy`/`Suspense`. O Vite injeta `preconnect` no HTML a partir de `VITE_SUPABASE_URL`, inclusive domínio personalizado; quando a URL está ausente, não emite um link vazio.

## Validação reproduzível

```sh
npm test
npm run test:db
npm run build
npm run benchmark:rls
npx --yes deno check supabase/functions/invite-user/index.ts supabase/functions/storage-reconcile/index.ts
```

O teste de banco executa todas as migrations em PostgreSQL embarcado (PGlite), com tabelas de Auth/Storage simuladas. As extensões `pg_cron`, `pg_net`, o envio de e-mail e a remoção física de blobs precisam de validação no Supabase implantado. Testes dos handlers exercitam autenticação, CORS, rate limit e a ordem entre remoção no Storage e confirmação da fila, sem enviar convites reais.

Resultado da validação: **36 testes de frontend/handlers e 61 verificações de banco aprovados**, build e verificação de tipos Deno aprovados. No navegador, a prévia de produção abriu a demonstração, os relatórios e o Gantt sem erros JavaScript; o registro de recursos confirmou que os chunks de relatório e cronograma só são baixados ao abrir essas telas. O HTML gerado contém o preconnect e não antecipa o editor.

O benchmark usa duas empresas, 200 contratos, **50.000 tarefas e 100.000 eventos**, executando `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` como `authenticated`, com aquecimento. Compara a política antiga e a nova sobre os mesmos índices e dados. Também verifica que os resultados de ambas são idênticos para administrador, membro de equipe e membro isolado.

| Consulta de tarefas atrasadas     |       Antes |   Depois |
| --------------------------------- | ----------: | -------: |
| Administrador, primeira página    |    13,43 ms |  0,16 ms |
| Administrador, contagem           | 3.805,62 ms | 16,27 ms |
| Membro de equipe, primeira página |   504,92 ms |  1,38 ms |
| Membro de equipe, contagem        | 3.837,85 ms |  9,70 ms |
| Membro isolado, primeira página   | 3.843,59 ms |  7,42 ms |
| Membro isolado, contagem          | 4.215,69 ms |  9,14 ms |

Essas medidas são locais, sintéticas e de uma execução aquecida; não representam latência de rede nem teste de carga do Supabase hospedado. Planos completos estão em [rls-benchmark.json](rls-benchmark.json). As listagens usam `tasks_late_due`; o planejador pode escolher varredura sequencial para contagens pouco seletivas.

O bundle principal passou de 746 kB para aproximadamente 115 kB (minificado, antes de gzip). Isso é a redução do chunk de código da aplicação, não uma redução equivalente do total de JavaScript inicial: as bibliotecas compartilhadas ainda são carregadas, mas podem ser reaproveitadas do cache entre versões. O editor continua fora do carregamento inicial. Relatórios e cronograma geram chunks próprios.

## Ativação no Supabase

1. Aplicar a migration antes de publicar o frontend que chama `task_extras`. A migration de performance existente está versionada como `20260921120000`, posterior ao timestamp que o CLI gerou nesta sessão; por isso usar `--include-all`. A nova migration funciona antes ou depois da de performance.

   ```sh
   npx supabase db push --linked --include-all --skip-vault --dry-run
   npx supabase db push --linked --include-all --skip-vault
   ```

   No Supabase hospedado, a migration ativa `pg_cron` e os jobs de retenção e expiração das cotas. **A retenção começa no próximo ciclo do cron**, incluindo eventos antigos já existentes. Em ambientes sem `pg_cron`, a migration emite um aviso e a retenção precisa de um agendador equivalente.

2. Configurar nos secrets das Edge Functions `APP_ORIGIN` com a origem exata da aplicação (sem barra final), `APP_ADDITIONAL_ORIGINS` com outras origens exatas separadas por vírgula, se necessário, e `MAINTENANCE_SECRET` com um valor aleatório de pelo menos 32 caracteres. Manter a URL de retorno de convite na allowlist do Auth. Não colocar esses segredos em variáveis `VITE_*`.

3. Salvar no Supabase Vault `mavi_supabase_url` (a URL HTTPS do projeto) e `mavi_maintenance_secret` (exatamente o mesmo valor de `MAINTENANCE_SECRET`). Usar o painel de secrets/Vault para evitar credenciais no histórico do shell.

4. Publicar as duas funções. A configuração de `storage-reconcile` desliga a verificação JWT do gateway porque o próprio handler exige o segredo do agendador. `invite-user` continua exigindo JWT.

   ```sh
   npx supabase functions deploy invite-user storage-reconcile --use-api
   npx supabase db query --linked --file supabase/operations/schedule-storage-reconcile.sql
   ```

   O SQL de agendamento falha se os secrets do Vault estiverem ausentes. Reexecutá-lo atualiza os jobs pelo nome, sem duplicação. A chamada HTTP segue a [documentação de cron/pg_net/Vault](https://supabase.com/docs/guides/functions/schedule-functions); a remoção física segue a [Storage API](https://supabase.com/docs/guides/storage/management/delete-objects).

5. Publicar o frontend após confirmar `task_extras` no banco. Verificar uma tarefa autorizada e uma não autorizada; testar a limpeza com um arquivo descartável elegível. Nenhum convite real foi enviado nesta entrega.

## Operação e observabilidade

```sql
-- Execuções SQL (o sucesso de net.http_post indica enfileiramento, não HTTP 200).
select j.jobname, d.status, d.return_message, d.start_time, d.end_time
from cron.job j join cron.job_run_details d using (jobid)
where j.jobname like 'mavi-%' order by d.start_time desc limit 30;

-- Conferir status HTTP da reconciliação e os logs da Edge Function.
select id, status_code, timed_out, error_msg, created
from net._http_response order by created desc limit 30;

-- Pendências persistentes indicam erro de Storage ou capacidade insuficiente.
select bucket_id, count(*), max(attempts) as max_attempts,
       min(next_attempt_at) as next_attempt
from mavi_private.storage_cleanup group by bucket_id;

-- Deve ser zero após escoar eventual backlog da retenção.
select count(*) from public.task_events
where created_at < now() - interval '1 month';
```

Para pausar as exclusões: `select cron.unschedule('mavi-task-event-retention');` e `select cron.unschedule('mavi-storage-reconcile');`. Isso não recupera objetos/eventos já removidos. Os nomes e segredos do job não contêm a chave administrativa.

O Advisor remoto foi consultado antes de qualquer implantação: ainda aponta `pg_trgm` no schema público, RPCs de mutação existentes com `SECURITY DEFINER` e proteção de senhas vazadas desabilitada. São características anteriores a esta mudança; as novas RPCs públicas são `SECURITY INVOKER`, com helpers privados e permissões testadas. O aviso de RLS sem política em tabelas privadas é intencional para acesso exclusivo por funções privilegiadas. Referências: [extensões](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public), [RPCs privilegiadas](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [senhas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
