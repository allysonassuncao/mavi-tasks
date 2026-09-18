# Estado da implantação — 18/09/2026

## Supabase

- Projeto: MAVI, referência `zajlipvbotjafkowohmn`, região `us-east-2`, plano Free.
- Cinco migrações versionadas aplicadas, nomes locais sincronizados com o histórico remoto.
- 14 tabelas operacionais com RLS, funções de escrita com autorização explícita, índices para vínculos e bucket privado `mavi-attachments`.
- Agência: **Make Acelerador de Vendas**. Fuso: `America/Sao_Paulo`.
- Primeiro administrador reservado: **allyson@makevendas.com.br**. Registro interno consumido somente após confirmação do e-mail; não usa metadados editáveis do usuário para conceder permissões.
- Nenhum usuário Auth criado ou convite enviado. Nenhum dado demonstrativo no banco remoto. Após os testes: uma empresa, zero tarefas, zero vínculos e zero usuários Auth.
- Frontend local usa somente URL e chave publicável. Credenciais em `.env.local`, ignorado pelo Git; nenhuma chave privilegiada no navegador.

## Verificações concluídas

- Build de produção aprovado.
- Quatro testes de domínio e 31 verificações de banco aprovadas no PostgreSQL embarcado, incluindo isolamento, aprovações, horas, anexos, revogação e provisionamento do administrador.
- `supabase/tests/remote_smoke.sql` executado no PostgreSQL hospedado: isolamento de empresas, leitura de relatórios, bloqueio de escrita direta, aprovação e bloqueio anônimo. Fixtures revertidas na mesma transação.
- `node scripts/check-supabase.mjs`: Auth acessível; acesso anônimo negado a empresas, vínculos, tarefas e anexos pela API real.
- Tela de login conectada verificada no navegador. Fluxos autenticados reais e transferência de arquivos ainda aguardam ativação da primeira conta.
- Auditoria npm de dependências de produção: nenhum alerta. A auditoria completa ainda aponta alertas transitivos nas ferramentas locais Vercel CLI e Vitest; não são dependências do bundle de produção e precisam de acompanhamento antes de estabelecer CI.

## Avisos do Supabase revisados

- [Funções SECURITY DEFINER acessíveis a authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable): 14 avisos relacionados às RPCs intencionalmente expostas. Elas conferem identidade, empresa, escopo e regras da operação; acesso anônimo revogado. RLS não substitui essas validações.
- [RLS sem políticas](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy): tabela privada de provisionamento, bloqueada intencionalmente para clientes e sem grants de acesso.
- [Índices ainda não usados](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index): informativo esperado em banco sem operação. Mantidos os índices de isolamento e vínculos; reavaliar com uso real.
- Ausência de índices nas chaves estrangeiras e reavaliação desnecessária de `auth.uid()` nas políticas foram corrigidas.

## Pendências para disponibilizar o primeiro acesso

1. O proprietário fará a integração manual da Vercel com [allysonassuncao/mavi-tasks](https://github.com/allysonassuncao/mavi-tasks). Esse fluxo dispensa login no CLI da Vercel.
2. Importar o repositório com preset Vite, build `npm run build` e saída `dist`; configurar URL e chave pública do Supabase antes de publicar, conforme README. A prévia inicial usará o projeto MAVI vazio já autorizado; antes de produção, separar homologação e dados operacionais.
3. No Supabase Auth, desabilitar cadastro público — a API confirmou que ainda está habilitado. Login anônimo já está desabilitado. O conector não oferece edição dessa configuração e o dashboard requer login.
4. Configurar Site URL e redirecionamento exato `/?setup=1` para a URL publicada; validar entrega de e-mail/SMTP.
5. Enviar o convite ao primeiro administrador após instrução explícita. O usuário define sua própria senha; não compartilhar senha ou tokens na conversa.
6. Homologar login, gravação autenticada, arquivos e recuperação de conta. Depois, implantar a função de convites com origem configurada e completar a interface administrativa.

Esta entrega é a fundação funcional. Recursos restantes do produto estão detalhados no README e no planejamento; não é uma declaração de conclusão do SaaS completo ou de prontidão para produção.
