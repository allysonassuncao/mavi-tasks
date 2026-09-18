# MAVI — gestão de trabalho

Primeira entrega funcional da fundação de um SaaS para agências. React/TypeScript/Vite no frontend; PostgreSQL, Auth, Storage e funções no Supabase; configuração de publicação na Vercel.

## Estado atual

- Conteúdo central com largura total, skeletons para carregamento e ações assíncronas, componentes React reutilizáveis para campos e seletores/checkboxes Radix com navegação por teclado.
- Interface responsiva em português: painel, tarefas em lista/quadro/agenda, clientes, contratações, projetos, horas, relatórios iniciais e equipes.
- Cadastro de clientes, produtos, contratações, equipes, projetos, tarefas e subtarefas; edição de tarefas; busca e filtros por status, produto, cliente, projeto e responsável.
- Fluxo de devolução, validação, aprovação interna e registro manual da aprovação do cliente, com histórico e controle de concorrência.
- Cronômetro, horas manuais, comentários e integração de anexos privados de até 20 MB.
- Login e conclusão de convite/recuperação por definição de senha. Edge Function de convite preparada, ainda sem acionamento pela interface.
- Migrações com isolamento por empresa, RLS, integridade de vínculos e operações transacionais autorizadas.
- Dados demonstrativos locais **somente em memória**, identificados por uma faixa na interface. Recarregar descarta as alterações da demonstração. Nenhum registro demonstrativo é enviado ao Supabase.

**Conectado ao projeto Supabase MAVI (`zajlipvbotjafkowohmn`).** Cinco migrações aplicadas; agência Make Acelerador de Vendas cadastrada e administrador `allyson@makevendas.com.br` criado no Supabase Auth e vinculado à agência. A senha foi definida por solicitação do proprietário e o login real foi validado; nenhum e-mail foi enviado pelo agente. A publicação será feita pelo proprietário na Vercel, por integração com o GitHub. Consulte `STATUS_IMPLANTACAO.md` para verificações e pendências.

## Links compartilháveis

`/login` é a entrada pública. Abrir `/` ou uma página protegida sem sessão redireciona para o login. Após autenticar, o usuário retorna ao destino solicitado; quando não existe um destino, abre a visão geral. A demonstração depende de escolha explícita na tela de login, inclusive quando não há configuração do Supabase.

As URLs usam o nome da agência, por exemplo `/agencias/make-acelerador-de-vendas/clientes`. As páginas disponíveis são `visao-geral`, `tarefas`, `clientes`, `projetos`, `horas`, `relatorios` e `configuracoes`. Links antigos como `/clientes?empresa=UUID` continuam aceitos e são convertidos para a URL amigável após carregar as empresas autorizadas. O menu permite copiar links ou abrir em outra aba.

Busca, filtros, paginação, período e visualização de tarefas continuam na query string quando selecionados. Voltar, Avançar e recarregar restauram a URL. O destino pós-login aceita apenas rotas internas conhecidas e remove parâmetros de autenticação. Os dados continuam sujeitos às permissões RLS: compartilhar o endereço não concede acesso à agência. Empresas com nomes equivalentes recebem um sufixo para evitar ambiguidade; alterar o nome de uma agência altera sua URL legível. Endereços desconhecidos exibem página não encontrada. Formulários e detalhes em modal são estados temporários da página.

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

Conta identificada: `allysoncombr`. Nenhum deploy foi executado pelo agente. Não é necessário autenticar o CLI da Vercel para seguir pelo fluxo GitHub escolhido. Domínio final ainda não definido.

## Verificação realizada e critérios de homologação

Os testes de banco executam SQL real em PGlite, com papéis anônimo e autenticado, duas empresas e usuários com escopos diferentes. Cobrem isolamento, referências entre empresas, escrita direta bloqueada, autoelevação de papel, aprovação, reabertura, versões antigas, cronômetro idempotente, sobreposição de horas, políticas de arquivos e revogação de acesso. Auth e Storage são simulados apenas quanto às tabelas e identidade usadas pelas políticas.

Também existem testes de fuso, atraso em validação e cálculo de tempo. A navegação demonstrativa é verificada no navegador, incluindo criação, comentário, cronômetro e aprovação.

Antes da produção ainda são obrigatórios: teste dos serviços Supabase reais, revisão do plano e quotas, autenticação e convite por e-mail, tratamento operacional de convites parcialmente concluídos, testes de carga, monitoramento e ensaio de restauração do banco **e** dos objetos do Storage. Não há números de desempenho medidos nesta entrega.

## Limites e próximas etapas do escopo acordado

- Espaços/pastas/listas livres ainda não implementados. A fundação atual organiza tarefas por contratação e projeto.
- Modelos, recorrências, dependências, campos personalizados, cronograma e calendário mensal ainda pendentes. A agenda atual agrupa a seleção de tarefas por data.
- O quadro permite abrir a tarefa e mudar seu estado pelo fluxo validado; arrastar cartões ainda não implementado.
- Gestão completa de permissões, associação posterior de equipes e usuários, alteração de responsável, arquivamento e manutenção dos cadastros ainda pendentes. A versão atual permite os cadastros iniciais e edição do conteúdo/prazo da tarefa.
- A interface de convites ainda não está ativa; a Edge Function foi preparada, mas não implantada ou testada contra Auth hospedado. Convidar uma conta já existente requer um fluxo adicional de vínculo, que ainda será desenvolvido. Falha de vínculo após envio exige revisão administrativa.
- Catálogos auxiliares têm limite explícito de 1.000 registros por consulta; adicionar busca paginada para ultrapassar esse volume. Tarefas têm paginação de 50 itens; quadro e agenda representam a página filtrada. Horas exibem os 100 registros autorizados mais recentes; relatórios agregam no banco.
- Relatórios atuais: atrasos atuais, validações atuais, eventos de entrega no período, horas por cliente e carga estimada por pessoa. Detalhamentos por produto/projeto/equipe, estimado versus realizado e cumprimento de prazo original/renegociado ainda pendentes.
- Datas do período dos relatórios enviadas pela interface usam o fuso do navegador; normalizar os limites para o fuso cadastrado da empresa antes de operar empresas em fusos distintos.
- Sem remoção ou substituição de anexos nesta primeira etapa; uploads falhos tentam limpar metadados pendentes. Prever reconciliação para interrupções de rede.
- Em caso de revogação durante um cronômetro ativo, o usuário perde acesso à tarefa e precisa da intervenção administrativa para encerrar a sessão; adicionar fluxo auditado de resolução.
- Portal do cliente, integrações, automações configuráveis, cobrança de planos, pacotes de horas e SLA continuam fora desta fase, conforme o planejamento.

O escopo completo e as decisões de negócio estão em `PLANO_DO_SISTEMA.md`. Esta é uma entrega incremental, não o sistema completo pronto para produção.
