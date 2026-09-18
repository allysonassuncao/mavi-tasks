# Estado da implantação — 18/09/2026

## Supabase

- Projeto: MAVI, referência `zajlipvbotjafkowohmn`, região `us-east-2`, plano Free.
- Seis migrações versionadas aplicadas, nomes locais sincronizados com o histórico remoto.
- 15 tabelas operacionais com RLS, funções de escrita com autorização explícita, índices para vínculos e buckets privados `mavi-attachments` e `mavi-inline-images`.
- Agência: **Make Acelerador de Vendas**. Fuso: `America/Sao_Paulo`.
- Administrador **allyson@makevendas.com.br** criado pela Admin Auth API e vinculado à agência com papel `admin` e vínculo ativo. Provisionamento interno consumido após esse vínculo administrativo autorizado. Senha atualizada pela Admin Auth API a pedido do proprietário. O Auth retornou e-mail confirmado e o login foi validado no navegador; credenciais não são versionadas.
- Nenhum convite ou e-mail enviado. Nenhum dado demonstrativo no banco remoto. Após o cadastro administrativo: uma empresa, zero tarefas, um vínculo e um usuário Auth.
- Frontend local usa somente URL e chave publicável. Credenciais em `.env.local`, ignorado pelo Git; nenhuma chave privilegiada no navegador.

## Verificações concluídas

- Build de produção aprovado. 22 testes de frontend passaram. Entrada sem sessão redireciona para `/login`; login retorna ao destino compartilhado. URLs com nome da agência substituem o UUID; links legados são normalizados. Navegação e recarga verificadas no navegador.
- Conteúdo central verificado em monitor amplo: 1.937 px disponíveis e 1.937 px ocupados pelo `main`. Formulário mobile validado; criação de tarefa demonstrativa preservou prioridade e aprovação do cliente usando os novos componentes React.
- 22 testes de frontend (domínio, rotas, descrições, calendário/Gantt e reenvio de anexos) e 46 verificações de banco aprovadas no PostgreSQL embarcado, incluindo isolamento, aprovações, horas, anexos, revogação e provisionamento do administrador.
- `supabase/tests/remote_smoke.sql` executado no PostgreSQL hospedado: isolamento de empresas, leitura de relatórios, bloqueio de escrita direta, aprovação e bloqueio anônimo. Fixtures revertidas na mesma transação.
- `node scripts/check-supabase.mjs`: Auth acessível; acesso anônimo negado a empresas, vínculos, tarefas e anexos pela API real.
- Login real do administrador validado localmente. Catálogo, busca sem perda de foco, editor e seleção/remoção de arquivos verificados no navegador. Upload e download autenticados de imagem e anexo foram validados nos buckets reais com conta e empresa temporárias isoladas; comentário e criação de tarefa com imagem passaram, assim como o bloqueio de leitura anônima. Conta, empresa, registros e objetos de teste foram removidos. Nenhum e-mail enviado. Os testes locais cobrem falhas e reenvio sem duplicar tarefas.
- Migração `20260918194425_task_workspace_experience.sql` aplicada e histórico sincronizado. Teste transacional no banco real validou edição, alternância atômica dos cronômetros e criação de rascunhos de imagem; alterações revertidas ao final.
- Navegador: URL/Voltar/Avançar das tarefas, blur/Iniciar/Parar/troca de tarefa, comentários e descrições com imagens, datas React, calendário, Gantt e edição dos quatro cadastros verificados na demonstração. Binários de imagem e anexos também foram verificados por API no Storage hospedado, com sessão autenticada comum e RLS.
- Auditoria npm de dependências de produção: nenhum alerta. A auditoria completa ainda aponta alertas transitivos nas ferramentas locais Vercel CLI e Vitest; não são dependências do bundle de produção e precisam de acompanhamento antes de estabelecer CI.

## Avisos do Supabase revisados

- [Funções SECURITY DEFINER acessíveis a authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable): 19 avisos relacionados às RPCs intencionalmente expostas. Elas conferem identidade, empresa, escopo e regras da operação; acesso anônimo revogado. RLS não substitui essas validações.
- [RLS sem políticas](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy): tabela privada de provisionamento, bloqueada intencionalmente para clientes e sem grants de acesso.
- [Índices ainda não usados](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index): informativo esperado em banco sem operação. Mantidos os índices de isolamento e vínculos; reavaliar com uso real.
- [Proteção contra senhas vazadas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection): desabilitada na configuração atual do Auth; alteração de política de senha não faz parte desta entrega.
- Ausência de índices nas chaves estrangeiras e reavaliação desnecessária de `auth.uid()` nas políticas foram corrigidas.

## Pendências para disponibilizar o primeiro acesso

1. O proprietário fará a integração manual da Vercel com [allysonassuncao/mavi-tasks](https://github.com/allysonassuncao/mavi-tasks). Esse fluxo dispensa login no CLI da Vercel.
2. Importar o repositório com preset Vite, build `npm run build` e saída `dist`; configurar URL e chave pública do Supabase antes de publicar, conforme README. A prévia inicial usará o projeto MAVI vazio já autorizado; antes de produção, separar homologação e dados operacionais.
3. No Supabase Auth, desabilitar cadastro público — a API confirmou que ainda está habilitado. Login anônimo já está desabilitado. O conector não oferece edição dessa configuração e o dashboard requer login.
4. Configurar Site URL e redirecionamento exato `/?setup=1` para a URL publicada; validar entrega de e-mail/SMTP.
5. Acesso do administrador já validado localmente. Configurar a URL publicada para os fluxos futuros de convite e recuperação.
6. Homologar login, gravação autenticada, arquivos e recuperação de conta. Depois, implantar a função de convites com origem configurada e completar a interface administrativa.

Esta entrega é a fundação funcional. Recursos restantes do produto estão detalhados no README e no planejamento; não é uma declaração de conclusão do SaaS completo ou de prontidão para produção.
