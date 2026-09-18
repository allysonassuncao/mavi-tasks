# Sistema de gestão para agências — escopo e arquitetura

Documento de planejamento, atualizado em 18/09/2026. O escopo abaixo descreve o sistema completo. A primeira entrega incremental já tem código, interface demonstrativa e migrações locais; o estado implementado e as pendências estão no README.md. A infraestrutura remota ainda não foi configurada.

## 1. Definições confirmadas

- SaaS para várias empresas, com dados e usuários separados.
- Cadastro inicial de empresas e convite de usuários pelo operador do SaaS; sem venda de planos ou cadastro público nesta fase.
- Uso online em desktop e celular, com interface responsiva em português.
- Frontend na Vercel; todo o backend no Supabase do proprietário.
- Políticas RLS do Supabase obrigatórias nas regras do backend, com isolamento por empresa e autorização por recurso e operação.
- Volume inicial informado: 30 clientes e 20 usuários. Projeção para o SaaS inteiro: 500 clientes e 100 usuários em dois anos.
- Cada empresa possui catálogo de produtos/serviços. Exemplos da agência: Make Ads, Make CRM e Social Leads.
- Um cliente pode contratar vários produtos; cada contratação pode ter vários projetos.
- Toda tarefa pertence a uma contratação; o vínculo com um projeto é opcional.
- Organização livre dentro da contratação, com espaços, pastas e listas.
- Projetos sazonais e recorrentes, modelos com etapas e tarefas predefinidas.
- Um responsável por tarefa, com equipes e hierarquia de permissões.
- Cronômetro e lançamento manual de horas; sem pacote de horas contratado.
- Datas combinadas por tarefa; sem SLA contratual nesta fase.
- Documentos como arquivos anexados e organizados; sem editor de documentos.
- Portal do cliente, integrações externas e automações configuráveis adiados.

## 2. Arquitetura proposta

| Camada                    | Escolha                                 | Responsabilidade                                              |
| ------------------------- | --------------------------------------- | ------------------------------------------------------------- |
| Interface                 | React + TypeScript, compilação com Vite | Aplicação responsiva e navegação                              |
| Publicação                | Vercel                                  | Distribuição do frontend, domínio e previews                  |
| Identidade                | Supabase Auth                           | Login, recuperação de acesso e convites                       |
| Dados                     | PostgreSQL no Supabase                  | Registros, relacionamentos, integridade e relatórios          |
| Autorização               | Grants e Row Level Security (RLS)       | Restringir operações e registros por empresa, vínculo e papel |
| Operações transacionais   | Funções PostgreSQL chamadas por RPC     | Aprovar, entregar, iniciar/parar cronômetro e aplicar modelos |
| Operações administrativas | Supabase Edge Functions                 | Convites e operações que exigem credenciais de servidor       |
| Arquivos                  | Supabase Storage privado                | Anexos e acesso autorizado                                    |
| Recorrência               | Supabase Cron e funções de banco        | Gerar ocorrências de projetos de forma controlada             |

A escolha de React/Vite é uma proposta para uma aplicação autenticada cuja lógica de servidor estará no Supabase. A Vercel documenta o suporte a Vite e a configuração de rotas para aplicações SPA. [Referência](https://vercel.com/docs/frameworks/frontend/vite).

A interface acessará dados com a identidade do usuário. As regras críticas serão executadas no backend, inclusive quando a requisição chegar fora da interface. O Supabase oferece políticas no banco e funções de servidor para esses limites. [Segurança de dados](https://supabase.com/docs/guides/database/secure-data).

Não serão criados backend paralelo na Vercel, banco externo ou armazenamento de dados de negócio no navegador. Cache de interface será temporário e separado por empresa e usuário.

## 3. Modelo de negócio e organização

```text
Empresa do SaaS
├── Usuários, vínculos, equipes e permissões
├── Catálogo de produtos/serviços
└── Clientes
    └── Produtos contratados
        ├── Espaços → Pastas → Listas
        ├── Projetos e suas etapas
        ├── Tarefas com projeto
        └── Tarefas sem projeto
            └── Subtarefas
```

Espaços, pastas e listas organizam o trabalho. Projetos representam entregas com escopo e período. São dimensões relacionadas, evitando que mover uma tarefa entre listas altere o cliente ou o produto ao qual ela pertence.

Proposta inicial: cada tarefa tem uma lista principal dentro da contratação e, opcionalmente, um projeto da mesma contratação. A interface oferece uma lista inicial para não obrigar a criação manual de toda a estrutura. Pastas são opcionais. Visões consolidadas consultam as mesmas tarefas, sem duplicá-las.

Entidades previstas:

- Empresas, perfis, vínculos de usuários, equipes e membros de equipes.
- Clientes, catálogo de produtos e contratações de produtos.
- Espaços, pastas, listas, projetos e etapas.
- Tarefas, relações entre subtarefas e dependências.
- Definições e valores de campos personalizados.
- Comentários, anexos e registros de atividade.
- Apontamentos de horas, revisões e aprovações.
- Modelos de projetos, regras de recorrência e ocorrências geradas.

Todos os registros de negócio carregarão o identificador da empresa. Vínculos deverão garantir também a consistência da contratação: uma tarefa não poderá usar projeto, lista, pai ou dependência de outra contratação. Dependências entre contratações ficam fora do comportamento inicial proposto.

## 4. Permissões propostas

| Perfil                   | Alcance inicial                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Operador do SaaS         | Criar empresas e convidar administradores; sem acesso automático ao conteúdo operacional de todas as empresas |
| Administrador da empresa | Administrar usuários, equipes, catálogo, clientes e organização da própria empresa                            |
| Gestor                   | Gerir o trabalho das equipes e contratações às quais possui acesso                                            |
| Colaborador              | Acessar trabalho compartilhado com suas equipes; executar tarefas, comentar e apontar horas                   |
| Cliente externo          | Reservado para a segunda fase, sem acesso nesta versão                                                        |

A aprovação interna cabe ao criador da tarefa ou ao gestor da equipe vinculada à tarefa, desde que mantenha acesso ativo. O papel de administrador, isoladamente, não acrescenta uma exceção à regra de aprovação acordada.

Premissas ajustáveis: cada tarefa tem uma equipe principal; criador e responsável mantêm acesso explícito enquanto seus vínculos estiverem ativos. A modelagem admite uma pessoa em mais de uma empresa, com papéis separados e troca explícita de contexto.

## 5. Fluxo de execução e aprovação

Status confirmados: **Aberto → Em andamento → Em validação → Entregue**, além de **Devolvida**.

- Devolver exige uma explicação e registra uma pendência para o criador, mantendo o responsável.
- Reprovação na validação retorna para Em andamento, com motivo e histórico.
- Aprovação interna é sempre obrigatória para entregar.
- Cada tarefa indica se exige aprovação do cliente.
- Sem portal, um usuário interno autorizado registra a decisão do cliente, com data, identificação de quem aprovou e comentário ou anexo de evidência.
- Proposta: quando houver aprovação do cliente, ela é registrada pelo criador ou gestor; a tarefa permanece Em validação até concluir as duas aprovações.
- Alterações relevantes no conteúdo submetido ou reabertura criam uma nova revisão e exigem nova aprovação; decisões anteriores permanecem no histórico.
- Alterar diretamente o status na API não poderá contornar essas regras.
- Datas originais, mudanças de prazo e datas de entrega serão preservadas para os relatórios.

Criador e responsável podem coincidir; a regra informada permite aprovação pelo próprio criador nesse caso. Não será acrescentada separação obrigatória entre executor e aprovador sem uma nova definição de negócio.

## 6. Horas, recorrência e relatórios

Cronômetro e lançamento manual geram apontamentos persistidos. Fechar ou recarregar o navegador não perde o início de uma sessão. Proposta: permitir apenas um cronômetro ativo por usuário, inclusive ao trocar de empresa, sem expor detalhes da outra empresa. Parar o cronômetro deve ser uma operação atômica e segura contra repetição.

Apontamentos terão autor, tarefa, início/fim ou duração, observação e histórico de ajustes. Estimativas são registradas separadamente; o sistema impedirá duração negativa e alertará sobre sobreposição de períodos.

Modelos poderão gerar projetos com tarefas e prazos relativos. Recorrências terão periodicidade, fuso, início e término opcional. Cada ocorrência terá uma chave única para evitar duplicação se um processamento for repetido. Recorrência prevista no produto não equivale ao construtor de automações adiado. O Supabase Cron pode executar funções de banco ou invocar Edge Functions. [Referência](https://supabase.com/docs/guides/cron).

Relatórios iniciais:

| Relatório                 | Definição inicial proposta                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Tarefas atrasadas         | Prazo vencido e status diferente de Entregue, incluindo tarefas em validação                                         |
| Entregas por período      | Eventos de entrega no intervalo, com identificação de reentregas                                                     |
| Carga por pessoa/equipe   | Tarefas abertas, prazos e horas estimadas restantes; sem assumir capacidade disponível sem cadastro dessa capacidade |
| Horas trabalhadas         | Soma de apontamentos por cliente, produto, contratação, projeto e pessoa; tarefas sem projeto têm grupo próprio      |
| Estimado versus realizado | Estimativas comparadas a apontamentos, evitando somar novamente o agregado de subtarefas                             |
| Cumprimento de datas      | Entrega comparada ao prazo, com histórico para diferenciar prazo original e renegociado                              |

Filtros por período, cliente, produto, projeto, equipe e responsável conforme o relatório. Horas por período devem considerar apenas a parcela do apontamento dentro do intervalo. Comparações de datas usarão o fuso da empresa. Sugestão inicial para a agência: America/Sao_Paulo.

Consumo de horas contratadas e SLA ficam adiados, conforme confirmado.

## 7. Segurança e integridade

- RLS e permissões por operação em todas as tabelas expostas; acesso negado sem vínculo ativo e escopo correspondente. Políticas também precisam considerar as colunas sensíveis, como empresa, papéis e aprovação. [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).
- Restrições e chaves compostas impedem relacionar dados de empresas diferentes.
- Operações críticas executadas em transações, com autorização do autor e validação da versão do registro.
- Funções com privilégios elevados restritas, com escopo validado, permissões mínimas e caminho de busca explícito.
- Chaves secretas e service role apenas no servidor. Nenhuma credencial privilegiada no frontend ou nos arquivos versionados.
- Convites vinculados à empresa, ao destinatário e ao papel permitido; não aceitar papel administrativo enviado livremente pelo navegador.
- Anexos em buckets privados. A autorização verifica a empresa e o recurso associado, tanto no upload quanto na leitura. O Storage utiliza políticas RLS. [Referência](https://supabase.com/docs/guides/storage/security/access-control).
- Registrar mudanças de responsável, prazo, status, permissões, horas e decisões de aprovação.
- Comentários e nomes de arquivos tratados como conteúdo não confiável; limites de tamanho e tipos de upload configurados.
- Ambientes de desenvolvimento/homologação separados de produção, com migrações versionadas e sem testes destrutivos nos dados reais.
- Definir retenção, backup e procedimento de restauração antes da produção. Backup do banco não inclui o conteúdo dos arquivos do Storage; ambos precisam de uma estratégia. [Backups do Supabase](https://supabase.com/docs/guides/platform/backups).

### 7.1. Políticas RLS obrigatórias no backend

Esta seção especifica as políticas a implementar junto das migrações do banco. Ainda não há SQL aplicado ao projeto Supabase.

**Regra comum:** qualquer acesso de usuário a um registro de negócio exige identidade autenticada, vínculo ativo com a empresa do registro e permissão para aquele recurso e operação. Informar um identificador de empresa na requisição não concede acesso. Papéis serão consultados em vínculos controlados pelo backend, nunca em metadados editáveis pelo usuário.

| Recurso                                     | Leitura permitida                                                                                                      | Escrita permitida                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Empresas, vínculos e equipes                | Própria empresa; somente informações de pessoas necessárias ao trabalho autorizado                                     | Administração da própria empresa; criação de empresas e primeiro administrador pelo fluxo restrito do operador            |
| Clientes e produtos contratados             | Administrador ou usuário com acesso à contratação; acesso ao cadastro do cliente não libera todas as suas contratações | Administrador; gestor apenas no escopo delegado                                                                           |
| Catálogo de produtos                        | Membros ativos da empresa                                                                                              | Administrador da empresa                                                                                                  |
| Espaços, pastas, listas, projetos e modelos | Acesso ao escopo organizacional correspondente dentro da empresa                                                       | Administrador ou gestor do escopo; demais alterações somente com permissão explícita                                      |
| Tarefas e subtarefas                        | Administrador, equipe autorizada, criador ou responsável, sempre com vínculo ativo                                     | Criar no escopo autorizado; editar conforme papel, autoria ou responsabilidade; transições críticas por função de backend |
| Dependências e campos personalizados        | Acesso aos recursos relacionados                                                                                       | Exigir permissão nos recursos envolvidos e consistência de empresa e contratação                                          |
| Comentários                                 | Mesma autorização da tarefa                                                                                            | Autor pode criar e editar seus comentários enquanto mantiver acesso; identidade do autor validada no backend              |
| Apontamentos de horas                       | Autor com acesso ativo à tarefa, gestor do escopo ou administrador                                                     | Autor registra suas horas; correções gerenciais somente por operação autorizada e auditada                                |
| Aprovações e histórico                      | Usuários autorizados a consultar a tarefa                                                                              | Sem escrita direta pelo cliente da API; funções de backend registram decisões e eventos                                   |
| Anexos e objetos do Storage                 | Acesso ao recurso associado                                                                                            | Upload e remoção exigem permissão específica no recurso; conhecer o caminho do arquivo não concede acesso                 |
| Recorrências                                | Administrador ou gestor autorizado no escopo                                                                           | Configuração por administrador/gestor; execução por rotina interna com escopo validado                                    |

Os detalhes de escrita da matriz são a proposta inicial de menor privilégio; as regras de aprovação seguem exatamente o fluxo acordado. Exclusão física não será liberada implicitamente por uma permissão de edição. A política inicial é arquivar registros operacionais e preservar horas, decisões e histórico.

**Implementação das políticas:**

- Habilitar RLS e definir grants mínimos na mesma migração de cada tabela exposta. O papel `anon` não terá acesso a dados de negócio.
- Definir `SELECT`, `INSERT`, `UPDATE` e `DELETE` separadamente quando autorizados. Usar `USING` para registros existentes e `WITH CHECK` para novos valores, conforme a operação. Evitar políticas permissivas que ampliem acesso ao serem combinadas.
- Proteger também tabelas de associação e valores de campos personalizados. Funções auxiliares de autorização não poderão gerar recursão entre políticas.
- Alterações de vínculo passam a valer nas próximas consultas ao banco, sem depender exclusivamente de papéis contidos em tokens antigos.
- Relatórios devem respeitar o mesmo escopo dos registros de origem. Views expostas utilizarão `security_invoker` quando suportado; agregados privados serão acessados por funções com autorização explícita. Contagens e totais não podem revelar dados de outro escopo.

Esses mecanismos combinam permissões de operação e filtragem por registro. [Referência de RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

**Controles complementares:** RLS controla registros, não substitui restrições de colunas ou validação de transições. Empresa, autoria, papéis, aprovações e datas de entrega não poderão ser alterados livremente. Usar grants de coluna e funções transacionais para mudanças sensíveis, inclusive conferência de criador/gestor e revisão da tarefa. [Segurança por coluna](https://supabase.com/docs/guides/database/postgres/column-level-security).

Edge Functions devem preservar a identidade do usuário nas operações comuns. Uso excepcional de `service_role`, que pode contornar RLS, exige autorização explícita no servidor antes da operação; a chave nunca será enviada ao navegador.

**Arquivos:** políticas em `storage.objects` validarão bucket privado, empresa e vínculo com o recurso associado em cada operação. Upload, substituição, movimentação e exclusão não podem alterar o escopo para escapar da autorização. Preferir downloads autenticados; se houver URLs assinadas, terão validade curta e poderão continuar válidas até expirar após a revogação do vínculo. [Controle de acesso do Storage](https://supabase.com/docs/guides/storage/security/access-control).

**Critério de entrega:** cada migração de autorização terá testes positivos e negativos com duas empresas, equipes com escopos diferentes, usuário sem vínculo, vínculo revogado e cada perfil. Cobrir leitura, inserção, alteração, exclusão, troca indevida de empresa, elevação de papel, aprovações, relatórios e arquivos por acesso direto à API. Os testes serão executados com identidades reais de aplicação, sem privilégios administrativos que contornem RLS.

## 8. Desempenho e critérios de validação

O número de usuários sozinho não dimensiona a carga. Quantidade de tarefas, comentários, apontamentos, arquivos e acessos simultâneos ainda será medida. Não há garantia de desempenho ou custo antes dessa medição e da confirmação do plano contratado.

Diretrizes de implementação:

- Paginação, filtros e ordenação no servidor; nenhuma tela carregará todos os dados da empresa para filtrá-los no navegador.
- Índices orientados pelas consultas reais, incluindo empresa, contratação, responsável, status e prazo; medir planos de execução.
- Calendário e cronograma consultados por intervalo; Kanban carregado em páginas por coluna.
- Interface dividida por rotas e tabelas extensas com renderização limitada à região visível quando necessário.
- Cache separado por empresa e usuário, limpo na saída e troca de contexto.
- Relatórios agregados no banco; consolidações adicionais somente se a medição demonstrar necessidade.
- Monitorar erros, duração de consultas, armazenamento e tráfego.

Metas propostas para homologação, não resultados obtidos: consultas comuns com p95 de até 500 ms e relatórios iniciais com p95 de até 2 s, medidos separadamente da renderização e documentando rede, plano e volume. Cenário sintético inicial: 100 usuários cadastrados, 500 clientes, 100 mil tarefas históricas e 20 usuários simultâneos, com ensaio adicional de pico. Os volumes de tarefas e concorrência são premissas de teste, não informação fornecida pelo usuário.

Testes necessários antes de produção:

1. Usuário de uma empresa não lê ou altera dados e arquivos de outra, inclusive por API direta e IDs conhecidos.
2. Colaborador não eleva papel, troca a empresa de um registro ou entrega sem aprovação.
3. Remoção de vínculo revoga consultas e mutações mesmo com sessão ainda existente.
4. Repetir uma requisição de cronômetro ou recorrência não duplica registros.
5. Duas edições concorrentes não sobrescrevem silenciosamente dados críticos.
6. Fluxo real de cliente → contratação → projeto/tarefa → horas → validação → entrega → relatório.
7. Navegação e ações principais em desktop, celular e teclado, incluindo estados vazios, erros e carregamento.
8. Restauração de dados e arquivos ensaiada e documentada.

## 9. Etapas de implementação da primeira versão

| Etapa                  | Entrega                                                                                 | Critério de conclusão                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1. Fundação            | Modelo de dados, autenticação, empresas, equipes, políticas RLS e navegação responsiva  | Testes de autorização por operação e isolamento entre empresas aprovados; convites validados |
| 2. Operação            | Clientes, catálogo, contratações, espaços/pastas/listas, projetos, tarefas e subtarefas | Fluxo operacional persistido, com lista e Kanban                                             |
| 3. Execução            | Horas, comentários, anexos, devolução e aprovações                                      | Entrega controlada e histórico completo                                                      |
| 4. Planejamento        | Campos personalizados, calendário, cronograma, dependências, modelos e recorrência      | Organização avançada e geração sem duplicação                                                |
| 5. Gestão e publicação | Relatórios, ensaios de carga, revisão de acesso, homologação e deploy                   | Critérios funcionais e operacionais verificados                                              |

Essas etapas dividem o trabalho, sem retirar da primeira versão os recursos acordados. Não há estimativa de prazo fechada nesta fase.

## 10. Preparação para conexão e publicação

A pasta do projeto estava vazia na inspeção inicial. Após o planejamento, foram criados o frontend, as migrações e os testes da fundação. O Supabase MAVI foi inspecionado, estava vazio e recebeu cinco migrações; a agência Make Acelerador de Vendas foi cadastrada. O repositório escolhido é `allysonassuncao/mavi-tasks`; o proprietário fará manualmente a integração GitHub–Vercel. Consulte README.md e STATUS_IMPLANTACAO.md para distinguir a implementação atual do escopo completo.

Para conectar a implementação serão necessários: identificação do projeto Supabase existente, verificação de seu conteúdo e plano, acesso autorizado às contas/projetos Supabase e Vercel, destino do repositório e domínio de publicação. Usar conexão autenticada ou configuração local de ambiente; não solicitar senhas ou chaves secretas em mensagens.

Antes de aplicar migrações, inspecionar o banco existente e preservar seus dados. O envio de convites reais só ocorrerá com destinatários e instrução explícita do usuário. Validar configuração de entrega de e-mail e recuperação de conta na preparação para produção.

Nome comercial, logo e paleta podem ser definidos durante a interface. A proposta visual inicial é uma área de trabalho sóbria, legível, com navegação por cliente/produto, filtros próximos das tarefas e ações adaptadas ao celular.
