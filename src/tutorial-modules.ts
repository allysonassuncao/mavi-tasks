/**
 * Os módulos de que um tutorial pode falar (o "?" de cada tela abre os
 * deles), com os nomes da tela. Sem dependências: o servidor também usa
 * (a MAVI diz o nome da tela). A mesma lista de
 * mavi_private.tutorial_module_label no banco; os de "Módulos visíveis" têm
 * os mesmos nomes de MODULES (src/modules.ts), a MAVI com o nome curto.
 */
export const TUTORIAL_MODULES: { id: string; label: string }[] = [
  { id: "overview", label: "Visão geral" },
  { id: "notices", label: "Mural de avisos" },
  { id: "tasks", label: "Tarefas" },
  { id: "agenda", label: "Agenda" },
  { id: "campaigns", label: "Campanhas" },
  { id: "financeMedia", label: "Financeiro › Mídia" },
  { id: "financeMakeAdsRq", label: "Financeiro › Make Ads RQ" },
  { id: "onboarding", label: "Planejamento › Social Leads" },
  { id: "socialMedia", label: "Planejamento › Social Media" },
  { id: "cases", label: "Cases de Sucesso" },
  { id: "temperature", label: "Termômetro dos clientes" },
  { id: "radar", label: "Radar do cliente" },
  { id: "personalRadar", label: "Radar pessoal" },
  { id: "agents", label: "Agente Conversacional" },
  { id: "drive", label: "Drive" },
  { id: "reports", label: "Relatórios" },
  { id: "dashboards", label: "Dashboards" },
  { id: "clients", label: "Clientes" },
  { id: "products", label: "Produtos" },
  { id: "projects", label: "Projetos" },
  { id: "hours", label: "Controle de horas" },
  { id: "storage", label: "Armazenamento" },
  { id: "aiUsage", label: "Painel da MAVI" },
  { id: "assistant", label: "MAVI" },
  { id: "inbox", label: "Caixa de entrada" },
  { id: "profile", label: "Meu perfil" },
  { id: "settings", label: "Equipe e configurações" },
];
/** Telas fora de "Módulos visíveis" que também têm tutoriais. */
export const EXTRA_MODULES = ["inbox", "profile", "settings"] as const;
export const moduleLabel = (id: string) =>
  TUTORIAL_MODULES.find((m) => m.id === id)?.label ?? id;
export const isTutorialModule = (id: unknown): id is string =>
  typeof id === "string" && TUTORIAL_MODULES.some((m) => m.id === id);
