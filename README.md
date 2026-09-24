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

`vercel.json` inclui fallback de rotas e cabeçalhos de segurança. Se usar domínio personalizado para a API do Supabase, revisar `connect-src` da CSP antes da publicação. Depois de publicar, configurar no Supabase Auth a Site URL e o redirect exato `https://SEU-DOMINIO/?setup=1`.

### Variáveis de servidor

| Variável | Uso |
| --- | --- |
| `GCS_CREDENTIALS` | JSON da conta de serviço do Google Cloud Storage (anexos, Drive, fotos) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Par de chaves das notificações push (`npx web-push generate-vapid-keys`) |
| `VAPID_SUBJECT` | Contato do remetente das notificações, ex.: `mailto:suporte@empresa.com.br` |
| `PUSH_SECRET` | Segredo aleatório (32+ caracteres) que o banco usa para chamar `/api/push` |

### Notificações push (com o app fechado)

Uma tarefa nova para outra pessoa, ou uma menção, vira uma linha em `notifications` (caixa de entrada). A migração `20260929100000_web_push` entrega cada linha, com os navegadores registrados da pessoa, a `/api/push` via `pg_net`; a função assina com VAPID e envia. Para ligar, depois de aplicar a migração e configurar as variáveis acima na Vercel (e fazer redeploy), registrar no SQL Editor do Supabase:

```sql
insert into mavi_private.push_config(url, secret)
values ('https://SEU-DOMINIO/api/push', '<o mesmo PUSH_SECRET da Vercel>');
```

Cada pessoa ativa as notificações no sino do topo; no iPhone, só com o app instalado na tela de início (iOS 16.4+). Sem essa configuração o app continua avisando enquanto está aberto.

Conta identificada: `allysoncombr`. Nenhum deploy foi executado pelo agente. Não é necessário autenticar o CLI da Vercel para seguir pelo fluxo GitHub escolhido. Domínio final ainda não definido.

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
