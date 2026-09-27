import { useMemo } from "react";
import { BarChart3, Boxes, GraduationCap, Route, Thermometer } from "lucide-react";
import { aiTab, useHash, type AiTab } from "./router";
import type { Snapshot } from "./types";
import { AiUsagePage } from "./AiUsagePage";
import { AiProvidersPanel, AiRoutesPanel, useAiLibrary } from "./AiProviders";
import { CopilotLearning } from "./CopilotLearning";
import { TemperatureSettings } from "./TemperatureSettings";
import { NoticeAnimationAdmin } from "./NoticeAnimationAdmin";
import { noticesApi } from "./notices";

const TABS: {
  id: AiTab;
  label: string;
  icon: typeof BarChart3;
  admin: boolean;
}[] = [
  { id: "consumo", label: "Consumo e limites", icon: BarChart3, admin: false },
  { id: "copiloto", label: "Copiloto", icon: GraduationCap, admin: false },
  { id: "termometro", label: "Termômetro", icon: Thermometer, admin: false },
  { id: "provedores", label: "Provedores e modelos", icon: Boxes, admin: true },
  { id: "regras", label: "Quem usa qual modelo", icon: Route, admin: true },
];

/**
 * Painel de IA (líderes): o consumo e os limites de gasto, o aprendizado
 * do Assistente MAVI nas tarefas (#copiloto), o Termômetro do cliente
 * (#termometro); para
 * administradores, também a biblioteca de provedores e as regras de quem usa
 * qual provedor e modelo (por funcionalidade, pessoa, cliente, produto e
 * projeto). Cada aba tem o seu endereço (#consumo, #copiloto, #provedores, #regras).
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
  const tab =
    isAdmin || hash === "copiloto" || hash === "termometro" ? hash : "consumo";
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
      {tab === "termometro" ? (
        <TemperatureSettings company={company} data={data} notify={notify} />
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
  notify,
}: {
  company: string;
  data: Snapshot;
  tab: AiTab;
  demo: boolean;
  notify: (message: string) => void;
}) {
  const { library, error, reload, api, defaults } = useAiLibrary(company, demo);
  // Uma instância só (na demonstração, a de exemplo guarda em memória).
  const notices = useMemo(() => noticesApi(demo, data, ""), [demo]); // eslint-disable-line react-hooks/exhaustive-deps
  return tab === "provedores" ? (
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
      />
      <NoticeAnimationAdmin
        api={notices}
        company={company}
        data={data}
        library={library}
        notify={notify}
      />
    </>
  );
}
