# MAVI — gestão de trabalho

Primeira entrega funcional da fundação de um SaaS para agências. React/TypeScript/Vite no frontend; PostgreSQL, Auth, Storage e funções no Supabase; configuração de publicação na Vercel.

## Estado atual

- Conteúdo central com largura total, skeletons para carregamento e ações assíncronas, componentes React reutilizáveis para campos e seletores/checkboxes Radix com navegação por teclado.
- Interface responsiva em português: painel, tarefas em lista/quadro/calendário/Gantt, clientes, contratações, projetos, horas, relatórios iniciais e equipes.
- Cadastro de clientes, produtos, contratações, equipes, projetos, tarefas e subtarefas; edição de tarefas; busca e filtros por status, produto, cliente, projeto e responsável.
- Fluxo de devolução, validação, aprovação interna e registro manual da aprovação do cliente, com histórico e controle de concorrência.
- Cronômetro, horas manuais, comentários e anexos privados de até 20 MB por arquivo, inclusive na criação da tarefa. Seleção múltipla, validação e reenvio dos pendentes sem recriar a tarefa; arquivos não são enviados na demonstração.
- Catálogo de produtos em `/agencias/NOME-DA-AGENCIA/produtos`, com cadastro para administradores e vínculo aos clientes.
- Descrição e comentários com editor Tiptap (negrito, itálico, listas e imagens), carregado sob demanda. Conteúdo estruturado com prefixo `mavi:richtext:v1:` no campo existente; renderização segura em React e compatibilidade com descrições antigas em texto simples.
- Campos React com ícones Lucide; busca de tarefas mantém o foco durante as consultas, com skeleton apenas nos resultados.
- Login e conclusão de convite/recuperação por definição de senha. Edge Function de convite preparada, ainda sem acionamento pela interface.
- Migrações com isolamento por empresa, RLS, integridade de vínculos e operações transacionais autorizadas.
- Dados demonstrativos locais **somente em memória**, identificados por uma faixa na interface. Recarregar descarta as alterações da demonstração. Nenhum registro demonstrativo é enviado ao Supabase.

**Conectado ao projeto Supabase MAVI (`zajlipvbotjafkowohmn`).** Seis migrações aplicadas; agência Make Acelerador de Vendas cadastrada e administrador `allyson@makevendas.com.br` criado no Supabase Auth e vinculado à agência. A senha foi definida por solicitação do proprietário e o login real foi validado; nenhum e-mail foi enviado pelo agente. A publicação será feita pelo proprietário na Vercel, por integração com o GitHub. Consulte `STATUS_IMPLANTACAO.md` para verificações e pendências.

## Links compartilháveis

`/login` é a entrada pública. Abrir `/` ou uma página protegida sem sessão redireciona para o login. Após autenticar, o usuário retorna ao destino solicitado; quando não existe um destino, abre a visão geral. A demonstração depende de escolha explícita na tela de login, inclusive quando não há configuração do Supabase.

As URLs usam o nome da agência, por exemplo `/agencias/make-acelerador-de-vendas/clientes`. As páginas disponíveis são `visao-geral`, `tarefas`, `clientes`, `produtos`, `produtos-contratados`, `projetos`, `horas`, `relatorios` e `configuracoes`. Links antigos como `/clientes?empresa=UUID` continuam aceitos e são convertidos para a URL amigável após carregar as empresas autorizadas. O menu permite copiar links ou abrir em outra aba.

Busca, filtros, paginação, período e visualização de tarefas continuam na query string quando selecionados. Voltar, Avançar e recarregar restauram a URL. O destino pós-login aceita apenas rotas internas conhecidas e remove parâmetros de autenticação. Os dados continuam sujeitos às permissões RLS: compartilhar o endereço não concede acesso à agência. Empresas com nomes equivalentes recebem um sufixo para evitar ambiguidade; alterar o nome de uma agência altera sua URL legível. Endereços desconhecidos exibem página não encontrada. Os detalhes da tarefa têm URL própria: `/agencias/NOME/tarefas/UUID/titulo-da-tarefa`. O UUID mantém o link válido mesmo após editar o título. Abrir, recarregar e usar Voltar/Avançar restaura o modal; tarefas fora da página ou dos filtros são consultadas diretamente por ID sob RLS. Formulários de criação continuam temporários.

## Experiência das tarefas e cadastros

- Modal amplo e responsivo, com link compartilhável e botão de copiar endereço.
- **Iniciar / Parar** registra tempo por usuário. Iniciar outra tarefa encerra automaticamente a sessão anterior, em uma transação protegida por lock e índice único. O cronômetro também pode ser iniciado em tarefas entregues para leitura/revisão, sem alterar o status da entrega.
- A descrição fica oculta até o cronômetro pessoal desta tarefa estar ativo. O blur usa texto ilustrativo; o conteúdo real não é renderizado nessa área bloqueada. É um mecanismo de foco da interface, não uma restrição adicional de acesso à API. O estado do cronômetro sincroniza a cada 10 segundos e ao voltar à janela.
- Apenas criador ou administrador edita a tarefa; responsáveis/gestores continuam podendo atuar no fluxo de execução e validação. Editar uma tarefa entregue invalida as aprovações e volta a exigir validação.
- Cadastros e configurações administrativas são exibidos apenas para administradores. Clientes, produtos, projetos e produtos contratados têm edição. Projetos com tarefas mantêm o produto contratado para preservar a integridade dos vínculos.
- **Módulos visíveis por pessoa:** além das regras fixas do perfil de acesso, um administrador escolhe, em **Equipe e configurações → Editar usuário → Módulos visíveis**, quais módulos do menu cada pessoa vê. Só restringe: o que o perfil não permite continua fora (aparece desmarcado e bloqueado), e **Meu perfil** e **Equipe e configurações** seguem só o perfil. Um módulo escondido some do menu, e abrir o endereço dele leva à primeira página permitida. É uma escolha de interface: o acesso aos dados continua definido pelo perfil e pelas políticas do banco. A lista guarda os módulos escondidos (`memberships.hidden_pages`, função `set_member_pages`, só administradores; migração `20261007090000_member_modules`).
- **Campo Projeto por produto:** ao editar um produto (Produtos → Editar), gestores e administradores escolhem **Exibir o campo Projeto ao criar tarefas**. Ligado (o padrão, como era antes), o campo aparece na criação da tarefa quando o produto contratado tem projetos; desligado, não aparece para aquele produto em nenhum cliente (`products.task_project_field`, parâmetro `p_task_project_field` de `update_product`; migração `20261008090000_product_project_field`).
- **Erros de login em português:** as mensagens do Supabase Auth (credenciais inválidas, e-mail não confirmado, muitas tentativas, senha fraca, link expirado, sem conexão…) aparecem em português do Brasil na tela de login, na definição de senha e na troca de senha (`src/auth-errors.ts`).
- **Título da aba:** com avisos não lidos na **Caixa de entrada**, o título da aba mostra quantos são (`(3) Workspace — …`); quando chega um aviso novo com a aba em segundo plano, o título alterna com quem fez o quê (`🔔 Ana mencionou você`) até a pessoa voltar à aba.
- **Cliente → produto contratado → projeto opcional → tarefa**. Produto é o serviço do catálogo; produto contratado é o serviço ativo daquele cliente; projeto é um grupo de entregas. Uma tarefa pode ser avulsa, mas sempre pertence a um produto contratado.
- Calendário por prazo e Gantt por início planejado/prazo, navegáveis por mês, com filtros na URL. O período é carregado em lotes, independentemente da paginação da lista. Gantt sem arraste ou dependências nesta entrega.
- Datas usam calendário React DayPicker em popover Radix; dropdowns usam Radix. Lucide fornece os ícones desses componentes.
- Imagens PNG/JPG/WebP de até 5 MB podem ser inseridas, coladas ou arrastadas nos dois editores, inclusive na criação. Binários no bucket privado `mavi-inline-images`; o texto armazena somente IDs. Rascunhos pertencem exclusivamente ao autor e são vinculados atomicamente à tarefa ao salvar a descrição/comentário. A leitura usa download autenticado e URLs temporárias locais, sem links públicos persistidos.

## Executar

```sh
npm ci
npm run dev -- --port 5173
npm run build
npm test
npm run test:db
```

Sem as variáveis de ambiente, a aplicação abre a demonstração. Para acesso real, configure em `.env.local` as variáveis de `.env.example`:

- `VITE_SUPABASE_URL`: URL pública do projeto.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: chave pública do projeto (ou chave anon legada).

Não colocar service role, chaves secretas ou senha de banco em variáveis com prefixo `VITE_`: elas são incorporadas ao frontend. O aplicativo não exige credenciais de servidor na Vercel.

## Supabase

1. Inspecionar o projeto existente antes de qualquer migração. Estas migrações usam nomes de tabelas em `public`; se já existirem tabelas homônimas, interromper e preparar uma migração de adaptação. Não sobrescrever dados existentes.
2. Aplicar primeiro em ambiente de desenvolvimento/homologação as migrações de `supabase/migrations`, na ordem do nome. O bucket `mavi-attachments` também deve estar disponível para criação; não reutilizar um bucket público existente.
3. Manter `mavi_private` fora dos schemas expostos pela Data API. As funções de autorização têm `search_path` vazio e referências qualificadas.
4. Desabilitar cadastro público e login anônimo em Auth. Configurar domínio, Site URL e redirects exatos para convite/recuperação; não aceitar destinos arbitrários.
5. Para MAVI, a empresa e o vínculo administrativo já existem: não repetir o bootstrap abaixo. O usuário foi criado pelo Admin Auth API; o provisionamento inicial foi consumido. A senha foi atualizada administrativamente por solicitação do proprietário, e o login real foi validado. Para outras empresas, provisionar administrativamente a empresa e seu vínculo. Não há endpoint público de criação de empresas.
6. Para convites, configurar SMTP e políticas de senha no Supabase, publicar `invite-user` e definir `APP_ORIGIN` como a origem HTTPS exata do frontend. A função valida o JWT e o vínculo administrativo no banco antes de usar service role. Não enviar convites reais durante testes sem instrução com destinatários.
7. Verificar os testes listados abaixo por API real antes de liberar produção.

Exemplo de bootstrap administrativo — substituir os valores antes de executar, exclusivamente no projeto correto:

```sql
begin;
with new_company as (
  insert into public.companies(name)
  values ('NOME_DA_EMPRESA') returning id
)
insert into public.memberships(company_id,user_id,name,role)
select id, 'UUID_DO_USUARIO_EXISTENTE'::uuid, 'NOME_DO_ADMINISTRADOR', 'admin'
from new_company;
commit;
```

Clientes autenticados têm somente `SELECT` nas tabelas operacionais, filtrado por RLS. A aplicação escreve por RPCs específicas, que validam autor, empresa, escopo e transição. Logo, RLS não é tratada como substituta para autorização dentro das funções `SECURITY DEFINER`. Não conceder `INSERT/UPDATE/DELETE` genéricos ao papel `authenticated` para contornar falhas de integração.

## Vercel

O proprietário fará a integração manual com [allysonassuncao/mavi-tasks](https://github.com/allysonassuncao/mavi-tasks). Na Vercel, importar esse repositório, usar a raiz como diretório do projeto, preset **Vite**, instalação `npm ci`, build `npm run build` e saída `dist`.

Antes do primeiro deploy, configurar `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` com os valores de `.env.local`, disponível somente na máquina local. Sem essas variáveis o frontend abre em modo demonstração. Configurá-las separadamente em Preview e Production; cada ambiente deve apontar ao Supabase correspondente. Nunca usar uma chave `service_role` ou secreta nessas variáveis.

`vercel.json` inclui fallback de rotas e cabeçalhos de segurança. Se usar domínio personalizado para a API do Supabase, revisar `connect-src` da CSP antes da publicação. Depois de publicar, configurar no Supabase Auth a Site URL e os redirects exatos `https://workspace.maso.app.br/?setup=1` e `https://workspace.maso.app.br/?reset=1`.

### Variáveis de servidor

| Variável                                           | Uso                                                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GCS_CREDENTIALS`                                  | JSON da conta de serviço do Google Cloud Storage (anexos, Drive, fotos)                                                                                               |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`            | Par de chaves das notificações push (`npx web-push generate-vapid-keys`)                                                                                              |
| `VAPID_SUBJECT`                                    | Contato do remetente das notificações, ex.: `mailto:suporte@empresa.com.br`                                                                                           |
| `PUSH_SECRET`                                      | Segredo aleatório (32+ caracteres) que o banco usa para chamar `/api/push`                                                                                            |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`         | Cliente OAuth do app no Google Cloud (Agenda)                                                                                                                         |
| `GOOGLE_TOKEN_KEY`                                 | Chave de 32 bytes em base64 que criptografa os tokens do Google no banco (`openssl rand -base64 32`). Trocar a chave desconecta todo mundo                            |
| `GOOGLE_REDIRECT_URI`                              | Opcional. Padrão: `<APP_ORIGIN>/api/google-callback`; em desenvolvimento, `http://localhost:5173/api/google-callback`                                                 |
| `META_APP_ID`, `META_APP_SECRET`                   | App da Meta (Facebook) usado em Campanhas para listar contas e campanhas de anúncio                                                                                   |
| `GOOGLE_CLIENT_ID_ADS`, `GOOGLE_CLIENT_SECRET_ADS` | Cliente OAuth do Google Cloud usado em Campanhas (Google Ads), separado do da Agenda                                                                                  |
| `GOOGLE_TOKEN_KEY_ADS`                             | Chave de 32 bytes em base64 (`openssl rand -base64 32`) que criptografa os tokens de Campanhas (Meta e Google Ads) no banco. Trocar a chave desconecta as plataformas |
| `GOOGLE_ADS_DEVELOPER_TOKEN`                       | Developer token da MCC da agência (Campanhas → Google Ads)                                                                                                            |
| `META_GRAPH_VERSION`, `GOOGLE_ADS_API_VERSION`     | Opcionais. Padrões: `v23.0` e `v25` (a v21 do Google Ads, usada pelo MASO, foi desligada em 05/08/2026)                                                               |
| `ADS_REDIRECT_URI`                                 | Opcional. Padrão: `<APP_ORIGIN>/api/ads-callback`; em desenvolvimento, `http://localhost:5173/api/ads-callback`                                                       |
| `ADS_SYNC_SECRET`                                  | Segredo aleatório (32+ caracteres) com que o banco chama `/api/ads-sync` (sincronização diária de Campanhas)                                                          |

### Agenda (Google Agenda)

Cada pessoa conecta o próprio Google Agenda em **Agenda**; os eventos são lidos e gravados ao vivo no Google por `/api/google` (nada da agenda é copiado para o banco). A migração `20260930160000_google_calendar` guarda só a conexão, com os tokens criptografados pelo servidor (AES-256-GCM com `GOOGLE_TOKEN_KEY`).

No Google Cloud, no cliente OAuth do app (tipo "Aplicativo da Web"):

1. Em **URIs de redirecionamento autorizados**, cadastrar `https://workspace.maso.app.br/api/google-callback` (e `http://localhost:5173/api/google-callback` para desenvolvimento).
2. Na tela de consentimento, o escopo `https://www.googleapis.com/auth/calendar`. Enquanto o app estiver em modo de teste, só os usuários de teste cadastrados conseguem conectar.
3. Configurar `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_TOKEN_KEY` na Vercel e fazer redeploy.

### Campanhas: contas e campanhas do Meta e do Google Ads

O módulo **Campanhas** é de administradores e gestores (colaboradores não o veem); o banco repete a regra em todas as funções e políticas do módulo (migração `20261009090000_ad_campaigns_leaders`, que revê a decisão D-47 da especificação).

No cadastro e na edição de um ciclo, a seção **Vínculos na plataforma** lista, ao vivo, as contas de anúncio e as campanhas de cada conta, para marcar as do ciclo (como o MASO fazia). A conexão segue o MASO: no **Facebook**, a conexão é **por cliente**: cada cliente tem a sua conta de anúncio, acessada pelo perfil do Facebook dele; depois do login o administrador ou gestor marca as contas do cliente e o token de longa duração (~60 dias) fica guardado em cada conta, ligada ao cliente (uma conta pertence a um cliente só). Na campanha, a lista de contas mostra só as do cliente dela; no **Google Ads**, uma única conexão da agência, com uma conta que tenha acesso à MCC (renovada sozinha). Os tokens são criptografados pelo servidor com `GOOGLE_TOKEN_KEY_ADS` (migração `20261001090000_ad_platform_connections`) e nunca chegam ao navegador; só administradores e gestores alcançam as conexões. Em **Campanhas → Conexões** eles conectam, reconectam e desconectam.

Meta (developers.facebook.com, no app da agência — pode ser o mesmo do MASO):

1. Produto **Login do Facebook** → **URIs de redirecionamento do OAuth válidos**: `https://workspace.maso.app.br/api/ads-callback` (e `http://localhost:5173/api/ads-callback` para desenvolvimento).
2. Permissões `ads_read` e `business_management` (quem conecta precisa ter acesso às contas no Business Manager).
3. Configurar `META_APP_ID`, `META_APP_SECRET` e `GOOGLE_TOKEN_KEY_ADS` (a mesma chave do Google Ads) na Vercel e fazer redeploy.

Google Ads (cliente OAuth próprio de Campanhas, separado do da Agenda):

1. No Google Cloud, criar um cliente OAuth "Aplicativo da Web" e cadastrar `https://workspace.maso.app.br/api/ads-callback` (e `http://localhost:5173/api/ads-callback` para desenvolvimento) nos **URIs de redirecionamento autorizados**.
2. Ativar a **Google Ads API** no projeto e incluir o escopo `https://www.googleapis.com/auth/adwords` na tela de consentimento.
3. Configurar `GOOGLE_CLIENT_ID_ADS`, `GOOGLE_CLIENT_SECRET_ADS`, `GOOGLE_TOKEN_KEY_ADS` e `GOOGLE_ADS_DEVELOPER_TOKEN` (Central de API da MCC) na Vercel e fazer redeploy.

Sem essas variáveis, a tela avisa que a conexão não está configurada e os IDs continuam podendo ser digitados.

### Campanhas: dia a dia da campanha (números dos ciclos)

O detalhe da campanha mostra, para o ciclo escolhido, o cabeçalho do MASO (mídia total e restante, meta, conversões diárias ideais, atual, orçamento diário, taxa de melhoramento, dia da campanha, score e o alerta de ritmo), a aba **Dia a Dia** (período e gráficos de consumo, conversões, etapas de venda, CTR, CPC, alcance, cliques e frequência) e a **Linha do tempo** (acumulados do ciclo, registros diários com a conferência "LIVE" e a visão da Minha Máquina do cliente). O M do ciclo fica no topo do detalhe, com a chave **Com M aplicado / Sem M**: ela alterna tudo (cabeçalho, Dia a Dia, Linha do tempo e Minha Máquina) entre os valores reais (sem M) e os do cliente (com M). O detalhe ocupa a página toda (sem o título da página). Nas sub-abas **MASO** e **Dia a dia** da Linha do tempo cada registro tem **Editar** (lápis): no acumulado, a data final, as métricas e o status Bom/Ruim (escolhido ou recalculado pela meta); no dia, as métricas e o M do dia. Os valores em dinheiro são digitados sem M. O registro editado passa a ser manual, a sincronização diária não o sobrescreve, e a alteração entra no histórico da campanha (migração `20261006090000_ad_record_edits`).

Os números vêm de uma sincronização diária (migração `20261002090000_ad_metrics`): o banco chama `/api/ads-sync` com `ADS_SYNC_SECRET` (pg_cron + pg_net, como as notificações push), e a função lê o Meta e o Google Ads com as conexões acima, grava os dias (reprocessando os últimos 7) e o acumulado do ciclo até ontem. Um administrador ou gestor também pode sincronizar uma campanha na hora (**Sincronizar**). Para ligar:

1. Gerar um segredo (`openssl rand -base64 32`), configurar `ADS_SYNC_SECRET` na Vercel e fazer redeploy.
2. No SQL Editor do Supabase: `insert into mavi_private.ad_sync_config(url, secret) values ('https://workspace.maso.app.br/api/ads-sync', '<o mesmo segredo>');`
3. Rodar `supabase/operations/schedule-ads-sync.sql` (a cada 20 minutos entre 06:00 e 09:40, horário de Brasília; cada chamada sincroniza os ciclos que ainda não foram sincronizados no dia).

### Campanhas: perfis do Facebook e conferência da sincronização

Em **Campanhas → Conexões e sincronização**:

- **Facebook (por cliente):** a lista traz os clientes com campanha ativa no Meta ou com contas conectadas — primeiro os sem conexão e os com acesso vencendo em até 7 dias —, com as contas de cada um e o perfil que as conectou. Para conectar um cliente, entre no facebook.com com o perfil dele neste navegador e clique em **Conectar** (ou **Renovar**); na volta, a janela **Contas de anúncio do cliente** mostra as contas que o perfil enxerga: a única já vem marcada, as de outro cliente ficam bloqueadas ("já é do cliente X"), e **Ligar ao cliente** salva. **Remover** apaga só as contas daquele cliente. O mesmo **Conectar o Facebook do cliente** aparece no cabeçalho da campanha (junto das contas de anúncio, com o status do acesso) e nos vínculos do ciclo, quando o cliente ainda não tem conta conectada; do formulário do ciclo o Facebook abre em outra aba, e ao voltar as contas são lidas de novo (migração `20261005090000_ad_client_connections`).
- **Sincronização diária:** agendamento (job `mavi-ads-sync` do pg_cron e a última execução), última sincronização automática, ciclos do dia (sincronizados, com erro, pendentes), quantos estão com os números de ontem e a lista dos que falharam ou ficaram para trás, com atalho para a campanha.

Pelo SQL, a mesma conferência: `select * from cron.job where jobname = 'mavi-ads-sync';`, `select status, start_time, return_message from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'mavi-ads-sync') order by start_time desc limit 10;` e `select public.ad_sync_overview('<empresa>');` (como administrador) ou a tabela `public.ad_sync_runs`.

### Campanhas: importação do histórico do MASO

`scripts/import-maso-campaigns.mjs` gera o SQL (idempotente) com campanhas, ciclos, vínculos, registros diários e acumulados (`tipo = 0`) do MASO, a partir das exportações do phpMyAdmin em **SQL** (padrão) ou JSON:

1. Exportar as tabelas `maso_acompanhamento`, `maso_acompanhamento_ciclo`, `maso_acompanhamento_registro` e `maso_acompanhamento_registro_diario`, e só `id, nome` de `nichomercado` e `usuarios_maso` (sem senhas).
2. Gerar os arquivos:

   ```
   node --max-old-space-size=8192 scripts/import-maso-campaigns.mjs --input <cada .sql> \
     --company <uuid da empresa> --author <uuid de um administrador> --mapping mapa.csv \
     --products 1,2 --clients "Make Ads" --out import.sql --parts 4
   ```

   - `--mapping`: CSV `id_cliente;contract_id` para clientes que já estão no MAVI (`--template mapa.csv` gera o modelo).
   - `--products 1,2`: só tráfego pago (Setup e Setup Premium); Social Media, SEO e Site ficam de fora.
   - `--clients "Make Ads"`: cria os clientes que faltam (nome = id do MASO) com um produto contratado Make Ads; sem campanha ativa, entram arquivados.
   - `--parts 4`: divide em arquivos de até 4 MB para o SQL Editor (`import-01.sql` primeiro; os demais em qualquer ordem).

3. Rodar os arquivos no SQL Editor do Supabase, na ordem. Cada um é uma transação; rodar de novo não duplica nada.

### Notificações push (com o app fechado)

Uma tarefa nova para outra pessoa, ou uma menção, vira uma linha em `notifications` (caixa de entrada). A migração `20260929100000_web_push` entrega cada linha, com os navegadores registrados da pessoa, a `/api/push` via `pg_net`; a função assina com VAPID e envia. Para ligar, depois de aplicar a migração e configurar as variáveis acima na Vercel (e fazer redeploy), registrar no SQL Editor do Supabase:

```sql
insert into mavi_private.push_config(url, secret)
values ('https://SEU-DOMINIO/api/push', '<o mesmo PUSH_SECRET da Vercel>');
```

Cada pessoa ativa as notificações no sino do topo; no iPhone, só com o app instalado na tela de início (iOS 16.4+). Sem essa configuração o app continua avisando enquanto está aberto.

Conta identificada: `allysoncombr`. Nenhum deploy foi executado pelo agente. Não é necessário autenticar o CLI da Vercel para seguir pelo fluxo GitHub escolhido.

Domínio oficial: `https://workspace.maso.app.br` (definido em `api/_origin.ts`; a variável `APP_ORIGIN` na Vercel o substitui). É o endereço dos links enviados por e-mail (convite e redefinição de senha) e precisa constar em `APP_ORIGIN` / `APP_ADDITIONAL_ORIGINS` das funções do Supabase.

## Verificação realizada e critérios de homologação

Os testes de banco executam SQL real em PGlite, com papéis anônimo e autenticado, duas empresas e usuários com escopos diferentes. Cobrem isolamento, referências entre empresas, escrita direta bloqueada, autoelevação de papel, aprovação, reabertura, versões antigas, cronômetro idempotente, sobreposição de horas, políticas de arquivos e revogação de acesso. Auth e Storage são simulados apenas quanto às tabelas e identidade usadas pelas políticas.

Também existem testes de fuso, atraso em validação e cálculo de tempo. A navegação demonstrativa é verificada no navegador, incluindo criação, comentário, cronômetro e aprovação.

Antes da produção ainda são obrigatórios: teste dos serviços Supabase reais, revisão do plano e quotas, autenticação e convite por e-mail, tratamento operacional de convites parcialmente concluídos, testes de carga, monitoramento e ensaio de restauração do banco **e** dos objetos do Storage. O benchmark local de RLS com 50 mil tarefas e 100 mil eventos, seus limites e os planos completos estão em `docs/SCALABILITY.md`.

## Limites e próximas etapas do escopo acordado

- Espaços/pastas/listas livres ainda não implementados. A fundação atual organiza tarefas por contratação e projeto.
- Modelos, recorrências, dependências e campos personalizados ainda pendentes. Calendário mensal e Gantt básico já disponíveis.
- O quadro permite abrir a tarefa e mudar seu estado pelo fluxo validado; arrastar cartões ainda não implementado.
- Gestão completa de permissões, associação posterior de equipes e usuários, alteração de responsável e arquivamento ainda pendentes. Cadastros e edição de cliente, produto, produto contratado e projeto estão disponíveis para administradores.
- A interface de convites ainda não está ativa; a Edge Function foi implantada com autenticação, CORS e rate limit verificados. O envio real por e-mail ainda não foi testado. Convidar uma conta já existente requer um fluxo adicional de vínculo, que ainda será desenvolvido. Falha de vínculo após envio exige revisão administrativa.
- Catálogos auxiliares têm limite explícito de 1.000 registros por consulta; adicionar busca paginada para ultrapassar esse volume. Tarefas têm paginação de 50 itens; o quadro representa a página filtrada; calendário e Gantt carregam todo o período selecionado em lotes de 500. Horas exibem os 100 registros autorizados mais recentes; relatórios agregam no banco.
- Relatórios atuais: atrasos atuais, validações atuais, eventos de entrega no período, horas por cliente e carga estimada por pessoa. Detalhamentos por produto/projeto/equipe, estimado versus realizado e cumprimento de prazo original/renegociado ainda pendentes.
- Datas do período dos relatórios enviadas pela interface usam o fuso do navegador; normalizar os limites para o fuso cadastrado da empresa antes de operar empresas em fusos distintos.
- Sem remoção ou substituição de anexos pela interface nesta primeira etapa. A reconciliação automática de pendências e objetos órfãos está implantada e agendada, com carência de 24 horas; operação descrita em `docs/SCALABILITY.md`. Anexos cujo upload já terminou são preservados, mesmo quando a resposta ao navegador foi perdida.
- Imagens enviadas e abandonadas antes de salvar são coletadas após 24 horas pela rotina de reconciliação implantada e agendada. Imagens já vinculadas a tarefas/comentários são preservadas.
- A RPC de encerramento permite parar a própria sessão mesmo após revogação da tarefa. Iniciar outra tarefa autorizada também encerra a anterior; sem nenhuma tarefa acessível, a interface de resolução administrativa ainda precisa ser completada.
- Portal do cliente, integrações, automações configuráveis, cobrança de planos, pacotes de horas e SLA continuam fora desta fase, conforme o planejamento.

O escopo completo e as decisões de negócio estão em `PLANO_DO_SISTEMA.md`. Esta é uma entrega incremental, não o sistema completo pronto para produção.

## Escalabilidade e manutenção

Retenção da auditoria por um mês, limpeza de arquivos órfãos, RPC unificada de detalhes, RLS otimizada, cotas de convite e divisão do build estão documentadas em [docs/SCALABILITY.md](docs/SCALABILITY.md), incluindo testes e ordem de ativação no Supabase. Execute `npm run benchmark:rls` para reproduzir a comparação dos planos de consulta.
