import { useMemo, useState } from "react";
import {
  Bot,
  BookMarked,
  BarChart3,
  BellRing,
  Boxes,
  Brain,
  ClipboardCheck,
  GraduationCap,
  Lightbulb,
  ListChecks,
  MessageCircle,
  Radar,
  Route,
  Shuffle,
  Thermometer,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { aiTab, useHash, type AiTab } from "./router";
import { SectionLayout } from "./SectionNav";
import type { Snapshot } from "./types";
import { AiUsagePage } from "./AiUsagePage";
import { AiProvidersPanel, AiRoutesPanel, useAiLibrary } from "./AiProviders";
import { CopilotLearning } from "./CopilotLearning";
import { MaviLearning } from "./MaviLearning";
import { MaviMemoryPanel } from "./MaviMemoryPanel";
import { TemperatureSettings } from "./TemperatureSettings";
import { RadarSettings } from "./RadarSettings";
import { RadarTaskLearning } from "./RadarTaskLearning";
import { CampaignInsightSettings } from "./CampaignInsightSettings";
import { CampaignDailySettings } from "./CampaignDailySettings";
import { AiPowersPanel } from "./AiPowersPanel";
import { AgentModelsPanel } from "./AgentModelsPanel";
import { NoticeAnimationAdmin } from "./NoticeAnimationAdmin";
import { noticesApi } from "./notices";
import { SettingsHistory, SettingsLogProvider } from "./AiSettingsLog";
import { WhatsappGroupsPanel } from "./WhatsappGroups";
import { JobAlertsPanel } from "./JobAlerts";
import { RouterPanel } from "./AiRouter";
import { demoRouter, serverRouter } from "./ai-router";
import { EvalSetPanel } from "./AiEvalSet";
import { demoEval, serverEval } from "./ai-eval-set";

type Section = { id: AiTab; label: string; icon: LucideIcon; admin: boolean };

const SECTIONS: { label: string; items: Section[] }[] = [
  {
    label: "Uso",
    items: [
      { id: "consumo", label: "Consumo e limites", icon: BarChart3, admin: false },
      { id: "avisos", label: "Avisos de falhas", icon: BellRing, admin: true },
    ],
  },
  {
    label: "Aprendizado",
    items: [
      { id: "copiloto", label: "Copiloto", icon: GraduationCap, admin: false },
      { id: "aprendizado", label: "Aprendizado da MAVI", icon: Brain, admin: false },
      { id: "memoria", label: "Memória", icon: BookMarked, admin: false },
    ],
  },
  {
    label: "Funcionalidades",
    items: [
      { id: "termometro", label: "Termômetro", icon: Thermometer, admin: false },
      { id: "radar", label: "Radar", icon: Radar, admin: false },
      { id: "tarefas-radar", label: "Tarefas do Radar", icon: ListChecks, admin: false },
      { id: "campanhas", label: "Campanhas", icon: Lightbulb, admin: false },
      { id: "whatsapp", label: "Grupos do Whatsapp", icon: MessageCircle, admin: false },
      { id: "poderes", label: "Poderes", icon: Zap, admin: false },
    ],
  },
  {
    label: "Modelos",
    items: [
      { id: "provedores", label: "Provedores e modelos", icon: Boxes, admin: true },
      { id: "regras", label: "Quem usa qual modelo", icon: Route, admin: false },
      { id: "roteamento", label: "Roteamento", icon: Shuffle, admin: false },
      { id: "avaliacao", label: "Avaliação", icon: ClipboardCheck, admin: false },
      { id: "agentes", label: "Agentes MAVI", icon: Bot, admin: false },
    ],
  },
];
const TABS = SECTIONS.flatMap((g) => g.items);

/**
 * Painel de IA (líderes): o consumo e os limites de gasto, o aprendizado
 * do Assistente MAVI nas tarefas (#copiloto), o das respostas da MAVI
 * (#aprendizado), o Termômetro do cliente
 * (#termometro), os tópicos do Radar do cliente (#radar), o que a MAVI
 * aprende com as tarefas abertas a partir do Radar (#tarefas-radar), os insights da
 * MAVI nas campanhas (#campanhas), os poderes do módulo MAVI (#poderes) e as regras de quem usa qual provedor e modelo (por
 * funcionalidade, pessoa, cliente, produto e projeto, #regras), o roteador
 * de modelos (nível de custo, privacidade e desempenho, #roteamento), o
 * conjunto de avaliação (#avaliacao) e os grupos
 * do WhatsApp lidos pela MAVI (#whatsapp; só administradores ajustam); para
 * administradores, também a biblioteca de provedores e API Keys
 * (#provedores) e os avisos de falhas das rotinas (#avisos). Cada seção tem
 * o seu endereço e fica no menu lateral da página (SectionLayout).
 */
export function AiPage({
  company,
  data,
  isAdmin,
  demo = false,
  notify,
}: {
  company: string;
  data: Snapshot;
  isAdmin: boolean;
  /** Na demonstração, a biblioteca é de exemplo e nada vai ao banco. */
  demo?: boolean;
  notify: (message: string) => void;
}) {
  const hash = aiTab(useHash());
  // Gestores veem tudo menos a biblioteca de provedores (as API Keys) e os
  // avisos de falhas.
  const tab =
    isAdmin || !TABS.find((t) => t.id === hash)?.admin ? hash : "consumo";
  const groups = SECTIONS.map((g) => ({
    ...g,
    items: g.items.filter((t) => isAdmin || !t.admin),
  }));
  return (
    <SectionLayout
      title="Painel da MAVI"
      label="Seções do Painel da MAVI"
      groups={groups}
      current={tab}
      storageKey="painel-mavi"
    >
      {tab === "whatsapp" ? (
        <WhatsappGroupsPanel
          data={data}
          company={company}
          canEdit={isAdmin}
          demo={demo}
          notify={notify}
        />
      ) : tab === "avisos" ? (
        <JobAlertsPanel
          data={data}
          company={company}
          isAdmin={isAdmin}
          demo={demo}
          notify={notify}
        />
      ) : tab === "agentes" ? (
        <AgentModelsPanel company={company} notify={notify} />
      ) : tab === "poderes" ? (
        <AiPowersPanel
          company={company}
          data={data}
          demo={demo}
          notify={notify}
        />
      ) : tab === "radar" ? (
        <RadarSettings company={company} data={data} notify={notify} />
      ) : tab === "tarefas-radar" ? (
        <RadarTaskLearning company={company} data={data} notify={notify} />
      ) : tab === "campanhas" ? (
        <>
          <CampaignInsightSettings company={company} data={data} notify={notify} />
          <CampaignDailySettings company={company} demo={demo} notify={notify} />
        </>
      ) : tab === "termometro" ? (
        <TemperatureSettings company={company} data={data} notify={notify} />
      ) : tab === "memoria" ? (
        <MaviMemoryPanel company={company} data={data} demo={demo} notify={notify} />
      ) : tab === "aprendizado" ? (
        <MaviLearning
          company={company}
          data={data}
          demo={demo}
          isAdmin={isAdmin}
          notify={notify}
        />
      ) : tab === "copiloto" ? (
        <CopilotLearning
          company={company}
          data={data}
          demo={demo}
          notify={notify}
        />
      ) : tab === "consumo" ? (
        demo ? (
          <p className="panel ai-route-empty">
            No ambiente demonstrativo não há consumo da MAVI para mostrar. Veja
            as seções de provedores e de regras.
          </p>
        ) : (
          <AiUsagePage company={company} data={data} notify={notify} />
        )
      ) : (
        <AdminTabs
          company={company}
          data={data}
          tab={tab}
          demo={demo}
          isAdmin={isAdmin}
          notify={notify}
        />
      )}
    </SectionLayout>
  );
}

function AdminTabs({
  company,
  data,
  tab,
  demo,
  isAdmin,
  notify,
}: {
  company: string;
  data: Snapshot;
  tab: AiTab;
  demo: boolean;
  isAdmin: boolean;
  notify: (message: string) => void;
}) {
  const { library, error, reload, api, defaults } = useAiLibrary(company, demo);
  // Uma instância só (na demonstração, a de exemplo guarda em memória).
  const notices = useMemo(() => noticesApi(demo, data, ""), [demo]); // eslint-disable-line react-hooks/exhaustive-deps
  // Cada salvamento das animações recarrega o histórico (os das regras
  // recarregam a biblioteca, que também conta).
  const [saved, setSaved] = useState(0);
  const version = useMemo(() => ({}), [library, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  const router = useMemo(() => (demo ? demoRouter() : serverRouter(company)), [demo, company]);
  const evalSet = useMemo(() => (demo ? demoEval() : serverEval(company)), [demo, company]);
  return (
    <SettingsLogProvider company={demo ? undefined : company} data={data} providers={library?.providers}>
      {tab === "avaliacao" ? (
        <EvalSetPanel
          api={evalSet}
          router={router}
          data={data}
          library={library}
          defaults={defaults}
          notify={notify}
        />
      ) : tab === "roteamento" ? (
        <RouterPanel
          api={router}
          company={demo ? undefined : company}
          data={data}
          library={library}
          reloadLibrary={reload}
          notify={notify}
          serverKey={defaults?.claudeKey !== false}
        />
      ) : tab === "provedores" ? (
        <AiProvidersPanel
          api={api}
          library={library}
          error={error}
          reload={reload}
          notify={notify}
        />
      ) : (
        <>
          <AiRoutesPanel
            api={api}
            data={data}
            library={library}
            defaults={defaults}
            error={error}
            reload={reload}
            notify={notify}
            canManageProviders={isAdmin}
            company={demo ? undefined : company}
          />
          <NoticeAnimationAdmin
            api={notices}
            company={company}
            data={data}
            library={library}
            notify={notify}
            onSaved={() => setSaved((n) => n + 1)}
          />
          <SettingsHistory data={data} version={version} />
        </>
      )}
    </SettingsLogProvider>
  );
}
