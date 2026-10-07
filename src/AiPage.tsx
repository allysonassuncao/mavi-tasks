import { useMemo, useState } from "react";
import {
  BarChart3,
  BellRing,
  Boxes,
  Brain,
  GraduationCap,
  Lightbulb,
  MessageCircle,
  Radar,
  Route,
  Shuffle,
  Thermometer,
  Zap,
} from "lucide-react";
import { aiTab, useHash, type AiTab } from "./router";
import type { Snapshot } from "./types";
import { AiUsagePage } from "./AiUsagePage";
import { AiProvidersPanel, AiRoutesPanel, useAiLibrary } from "./AiProviders";
import { CopilotLearning } from "./CopilotLearning";
import { MaviLearning } from "./MaviLearning";
import { TemperatureSettings } from "./TemperatureSettings";
import { RadarSettings } from "./RadarSettings";
import { CampaignInsightSettings } from "./CampaignInsightSettings";
import { CampaignDailySettings } from "./CampaignDailySettings";
import { AiPowersPanel } from "./AiPowersPanel";
import { NoticeAnimationAdmin } from "./NoticeAnimationAdmin";
import { noticesApi } from "./notices";
import { SettingsHistory, SettingsLogProvider } from "./AiSettingsLog";
import { WhatsappGroupsPanel } from "./WhatsappGroups";
import { JobAlertsPanel } from "./JobAlerts";
import { RouterPanel } from "./AiRouter";
import { demoRouter, serverRouter } from "./ai-router";

const TABS: {
  id: AiTab;
  label: string;
  icon: typeof BarChart3;
  admin: boolean;
}[] = [
  { id: "consumo", label: "Consumo e limites", icon: BarChart3, admin: false },
  { id: "copiloto", label: "Copiloto", icon: GraduationCap, admin: false },
  {
    id: "aprendizado",
    label: "Aprendizado da MAVI",
    icon: Brain,
    admin: false,
  },
  { id: "termometro", label: "Termômetro", icon: Thermometer, admin: false },
  { id: "radar", label: "Radar", icon: Radar, admin: false },
  { id: "campanhas", label: "Campanhas", icon: Lightbulb, admin: false },
  { id: "poderes", label: "Poderes", icon: Zap, admin: false },
  { id: "provedores", label: "Provedores e modelos", icon: Boxes, admin: true },
  { id: "regras", label: "Quem usa qual modelo", icon: Route, admin: false },
  { id: "roteamento", label: "Roteamento", icon: Shuffle, admin: false },
  {
    id: "whatsapp",
    label: "Grupos do Whatsapp",
    icon: MessageCircle,
    admin: false,
  },
  { id: "avisos", label: "Avisos de falhas", icon: BellRing, admin: true },
];

/**
 * Painel de IA (líderes): o consumo e os limites de gasto, o aprendizado
 * do Assistente MAVI nas tarefas (#copiloto), o das respostas da MAVI
 * (#aprendizado), o Termômetro do cliente
 * (#termometro), os tópicos do Radar do cliente (#radar), os insights da
 * MAVI nas campanhas (#campanhas), os poderes do módulo MAVI (#poderes) e as regras de quem usa qual provedor e modelo (por
 * funcionalidade, pessoa, cliente, produto e projeto, #regras), o roteador
 * de modelos (nível de custo, privacidade e desempenho, #roteamento) e os grupos
 * do WhatsApp lidos pela MAVI (#whatsapp; só administradores ajustam); para
 * administradores, também a biblioteca de provedores e API Keys
 * (#provedores) e os avisos de falhas das rotinas (#avisos). Cada aba tem o
 * seu endereço.
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
  const tabs = TABS.filter((t) => isAdmin || !t.admin);
  return (
    <div className="ai-page">
      {tabs.length > 1 && (
        <nav
          className="drive-view ai-page-tabs"
          aria-label="Seções do Painel da MAVI"
        >
          {tabs.map((t) => (
            <a
              key={t.id}
              href={`#${t.id}`}
              className={tab === t.id ? "selected" : ""}
              aria-current={tab === t.id ? "page" : undefined}
            >
              <t.icon size={15} aria-hidden="true" />
              {t.label}
            </a>
          ))}
        </nav>
      )}
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
      ) : tab === "poderes" ? (
        <AiPowersPanel
          company={company}
          data={data}
          demo={demo}
          notify={notify}
        />
      ) : tab === "radar" ? (
        <RadarSettings company={company} data={data} notify={notify} />
      ) : tab === "campanhas" ? (
        <>
          <CampaignInsightSettings company={company} data={data} notify={notify} />
          <CampaignDailySettings company={company} demo={demo} notify={notify} />
        </>
      ) : tab === "termometro" ? (
        <TemperatureSettings company={company} data={data} notify={notify} />
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
            as abas de provedores e de regras.
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
    </div>
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
  return (
    <SettingsLogProvider company={demo ? undefined : company} data={data} providers={library?.providers}>
      {tab === "roteamento" ? (
        <RouterPanel
          api={router}
          company={demo ? undefined : company}
          data={data}
          library={library}
          reloadLibrary={reload}
          notify={notify}
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
