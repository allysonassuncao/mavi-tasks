import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  ChartColumn,
  Coins,
  FlaskConical,
  History,
  Inbox,
  MessageCircleQuestion,
  MessagesSquare,
  Pause,
  Play,
  Plug,
  Signpost,
  Repeat,
  Plus,
  Save,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  UserRound,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Select, SelectOption } from "./ui";
import { contractProductLabel } from "./domain";
import type { Snapshot } from "./types";
import {
  agentModels,
  agentOp,
  createBuilderAgent,
  draftSet,
  errorOf,
  when,
  listBuilderAgents,
  type AgentDetail,
  type AgentDraft,
  type AgentModels,
  type AgentVersion,
  type BuilderAgent,
  type DraftError,
  type MakecrmInbox,
} from "./agent-builder";
import { KnowledgePanel } from "./AgentBuilderKnowledge";
import { CatalogForm, ModelOptionsContext } from "./AgentBuilderFields";
import { AgentKeysSection } from "./AgentKeys";
import { IntegrationsPanel } from "./AgentIntegrations";
import { ScenariosPanel } from "./AgentScenarios";
import { FollowupPanel } from "./AgentFollowup";
import { AgentAssistant } from "./AgentAssistant";
import { FIELD_BY_PATH, FIELDS } from "./agent-fields";
import { ConversationsPanel, SimulatorPanel } from "./AgentBuilderTest";
import { GapsPanel } from "./AgentGaps";
import { InsightsPanel } from "./AgentInsights";
import { AgentCostsPanel } from "./AgentCosts";
import { PublishTestBox, TestRunsPanel } from "./AgentTestRuns";
import "./agent-builder.css";

/**
 * Agente Conversacional › Agentes MAVI: lista e construtor dos agentes do
 * motor próprio. Perfil, instruções, conhecimento e comportamento formam o
 * rascunho; testar usa o rascunho salvo; publicar cria uma versão; caixas
 * ligam o agente ao WhatsApp do cliente no MakeCRM.
 */



/** O agente aberto pelo link (?agente=<id>); fechar limpa o link. */
function useAgentParam() {
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get("agente"));
  const set = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("agente", id);
    else url.searchParams.delete("agente");
    window.history.replaceState(window.history.state, "", url);
    setOpen(id);
  };
  return [open, set] as const;
}

// ------------------------------------------------------------ seção
export function AgentBuilderSection({ company, data, notify }: { company: string; data: Snapshot; notify: (m: string) => void }) {
  const [open, setOpen] = useAgentParam();
  if (open) return <AgentEditor company={company} agentId={open} data={data} notify={notify} onClose={() => setOpen(null)} />;
  return <AgentBuilderList company={company} data={data} onOpen={setOpen} notify={notify} />;
}

function AgentBuilderList({
  company,
  data,
  onOpen,
  notify,
}: {
  company: string;
  data: Snapshot;
  onOpen: (id: string) => void;
  notify: (m: string) => void;
}) {
  const [list, setList] = useState<{ agents: BuilderAgent[]; configured: boolean } | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => {
    listBuilderAgents(company)
      .then((r) => {
        setList(r);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company]);
  useEffect(load, [load]);

  const clientName = (id?: string) => data.clients.find((c) => c.id === id)?.name ?? "Cliente";
  const groups = useMemo(() => {
    const by = new Map<string, BuilderAgent[]>();
    for (const a of list?.agents ?? []) {
      const k = a.external_ref.mavi_client_id ?? "";
      by.set(k, [...(by.get(k) ?? []), a]);
    }
    return [...by.entries()].sort((x, y) => clientName(x[0]).localeCompare(clientName(y[0]), "pt-BR"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, data.clients]);

  return (
    <div className="ab-page">
      <div className="ab-head">
        <div>
          <h2 className="ab-title">Agentes MAVI</h2>
          <p className="muted ab-intro">
            Agentes de WhatsApp que rodam no motor da Make Vendas, sem n8n: perfil, instruções, base de conhecimento e
            teste antes de publicar.
          </p>
        </div>
        <Button type="button" className="btn primary" onClick={() => setCreating(true)}>
          <Plus size={16} aria-hidden="true" /> Novo agente
        </Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!list && !error && <Loading variant="table" />}
      {list && !list.configured && (
        <div className="ab-notice">
          <TriangleAlert size={16} aria-hidden="true" />
          O motor de agentes ainda não está ligado a este MAVI (faltam AGENTS_ENGINE_URL e AGENTS_ENGINE_KEY na Vercel).
        </div>
      )}
      {list && list.configured && !list.agents.length && (
        <div className="agent-empty">
          <Bot size={22} aria-hidden="true" />
          <strong>Nenhum agente ainda</strong>
          <span>Crie o primeiro agente de um cliente. Ele só atende no WhatsApp depois de publicado e ligado a uma caixa.</span>
        </div>
      )}
      {groups.map(([client, agents]) => (
        <section key={client} className="ab-group">
          <h3 className="agent-group-title">{clientName(client)}</h3>
          {agents.map((a) => (
            <button key={a.id} type="button" className="ab-card" onClick={() => onOpen(a.id)}>
              <span className="ab-card-main">
                <strong>{a.name}</strong>
                <span className="muted">
                  {a.external_ref.mavi_contract_id ? contractProductLabel(data, a.external_ref.mavi_contract_id) : ""}
                  {` · rascunho salvo em ${when(a.draft_updated_at)}`}
                </span>
              </span>
              <span className="ab-badges">
                <StatusBadge agent={a} />
                <span className={`ab-badge ${a.bindings ? "on" : ""}`}>
                  {a.bindings ? `${a.bindings} ${a.bindings === 1 ? "caixa" : "caixas"}` : "Sem caixa"}
                </span>
              </span>
            </button>
          ))}
        </section>
      ))}
      {creating && (
        <NewAgentModal
          company={company}
          data={data}
          onClose={() => setCreating(false)}
          onCreated={(id, withMavi) => {
            setCreating(false);
            notify(withMavi ? "Agente criado. A MAVI vai te ajudar a montar." : "Agente criado. Preencha o perfil e as instruções.");
            if (withMavi) {
              const url = new URL(window.location.href);
              url.searchParams.set("mavi", "1");
              window.history.replaceState(window.history.state, "", url);
            }
            onOpen(id);
          }}
        />
      )}
    </div>
  );
}

function StatusBadge({ agent }: { agent: Pick<BuilderAgent, "status" | "published_version"> }) {
  if (agent.status === "paused") return <span className="ab-badge warn">Pausado</span>;
  if (!agent.published_version) return <span className="ab-badge">Rascunho</span>;
  return <span className="ab-badge on">Publicado · v{agent.published_version}</span>;
}

function NewAgentModal({
  company,
  data,
  onClose,
  onCreated,
}: {
  company: string;
  data: Snapshot;
  onClose: () => void;
  onCreated: (id: string, withMavi: boolean) => void;
}) {
  const clients = useMemo(
    () => data.clients.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.clients],
  );
  const [client, setClient] = useState("");
  const contracts = useMemo(() => data.contracts.filter((c) => c.client_id === client && !c.archived), [data.contracts, client]);
  const [contract, setContract] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    // Sugere o produto "MAVI"/"Agente" quando houver.
    const pick = contracts.find((c) => /mavi|agente/i.test(contractProductLabel(data, c.id))) ?? contracts[0];
    setContract(pick?.id ?? "");
  }, [contracts, data]);
  return (
    <Modal title="Novo agente" onClose={onClose} busy={busy}>
      <form
        className="ab-form"
        onSubmit={(e) => {
          e.preventDefault();
          // Qual botão enviou: "Criar e montar com a MAVI" abre a conversa com ela.
          const withMavi = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("data-mavi") === "1";
          setBusy(true);
          setError("");
          createBuilderAgent(company, { client, contract, name: name.trim() })
            .then((r) => onCreated(r.agent.id, withMavi))
            .catch((err) => setError(errorOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          <span>Cliente</span>
          <Select value={client} onValueChange={setClient} aria-label="Cliente" required>
            <SelectOption value="">Escolha o cliente</SelectOption>
            {clients.map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {c.name}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label>
          <span>Produto</span>
          <Select value={contract} onValueChange={setContract} aria-label="Produto" required disabled={!client}>
            <SelectOption value="">{client ? "Escolha o produto" : "Escolha o cliente primeiro"}</SelectOption>
            {contracts.map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {contractProductLabel(data, c.id)}
              </SelectOption>
            ))}
          </Select>
          <small className="muted">Quem edita este produto no Drive edita o agente.</small>
        </label>
        <label>
          <span>Nome do agente</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Clara (atendimento)" maxLength={120} required />
        </label>
        <p className="ab-hint">Com a MAVI, ela faz perguntas, lê o site do cliente e o agente do n8n (se houver) e preenche tudo com você.</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="agent-editor-foot">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn secondary" loading={busy} disabled={!client || !contract || !name.trim()}>
            Criar e preencher
          </Button>
          <Button type="submit" data-mavi="1" className="btn primary" loading={busy} disabled={!client || !contract || !name.trim()}>
            <Sparkles size={15} aria-hidden="true" /> Criar e montar com a MAVI
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ construtor
type Tab =
  | "profile"
  | "instructions"
  | "knowledge"
  | "behavior"
  | "integrations"
  | "scenarios"
  | "followup"
  | "test"
  | "inboxes"
  | "versions"
  | "conversations"
  | "insights"
  | "gaps"
  | "costs"
  | "simulated";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "profile", label: "Perfil", icon: UserRound },
  { id: "instructions", label: "Instruções", icon: Sparkles },
  { id: "knowledge", label: "Conhecimento", icon: BookOpen },
  { id: "behavior", label: "Comportamento", icon: SlidersHorizontal },
  { id: "integrations", label: "Integrações", icon: Plug },
  { id: "scenarios", label: "Cenários", icon: Signpost },
  { id: "followup", label: "Follow-up", icon: Repeat },
  { id: "test", label: "Testar", icon: FlaskConical },
  { id: "simulated", label: "Leads simulados", icon: UsersRound },
  { id: "inboxes", label: "Caixas", icon: Inbox },
  { id: "versions", label: "Versões", icon: History },
  { id: "conversations", label: "Conversas", icon: MessagesSquare },
  { id: "insights", label: "Insights", icon: ChartColumn },
  { id: "gaps", label: "Lacunas", icon: MessageCircleQuestion },
  { id: "costs", label: "Custos", icon: Coins },
];
/** A aba pelo link (?aba=insights|lacunas, como no resumo semanal). */
const TAB_PARAM: Record<string, Tab> = { insights: "insights", lacunas: "gaps", custos: "costs", testes: "simulated" };
/** As abas do rascunho (o que "Salvar rascunho" grava); as três primeiras vêm do catálogo dos campos. */
const DRAFT_TABS = new Set<Tab>(["profile", "instructions", "behavior", "integrations", "scenarios", "followup"]);
const FORM_TABS = new Set<Tab>(["profile", "instructions", "behavior"]);

function AgentEditor({
  company,
  agentId,
  data,
  notify,
  onClose,
}: {
  company: string;
  agentId: string;
  data: Snapshot;
  notify: (m: string) => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState("");
  // A aba e o período vindos do link (?aba=insights&de=…&ate=…), lidos uma vez.
  const [linked] = useState(() => {
    const q = new URLSearchParams(window.location.search);
    const de = q.get("de") ?? "";
    const ate = q.get("ate") ?? "";
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    return {
      tab: TAB_PARAM[q.get("aba") ?? ""] ?? null,
      period: ymd.test(de) && ymd.test(ate) ? { from: de, to: ate } : null,
      run: q.get("bateria"),
    };
  });
  const [tab, setTab] = useState<Tab>(linked.tab ?? "profile");
  // Com muitas abas, a aberta (pelo link ou pelo "Ver lacunas") fica à vista na barra.
  useEffect(() => {
    document.querySelector(".ab-tabs button.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, !!detail]);
  const [draft, setDraft] = useState<AgentDraft>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [publishing, setPublishing] = useState(false);
  // A conversa com a MAVI: aberta pelo botão ou ao criar com "Criar e montar com a MAVI" (?mavi=1).
  const [assistant, setAssistant] = useState(() => new URLSearchParams(window.location.search).get("mavi") === "1");
  const [knowledgeKey, setKnowledgeKey] = useState(0);
  // Os modelos liberados no Painel da MAVI (para os menus de modelo e as chaves).
  const [models, setModels] = useState<AgentModels | null>(null);
  useEffect(() => {
    agentModels(company)
      .then(setModels)
      .catch(() => setModels(null));
  }, [company]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (["mavi", "aba", "de", "ate", "bateria"].some((k) => url.searchParams.has(k))) {
      for (const k of ["mavi", "aba", "de", "ate", "bateria"]) url.searchParams.delete(k);
      window.history.replaceState(window.history.state, "", url);
    }
  }, []);

  const load = useCallback(() => {
    agentOp<AgentDetail>(company, agentId, "get")
      .then((d) => {
        setDetail(d);
        setDraft(d.agent.draft ?? {});
        setErrors(d.draft_validation.errors);
        setDirty(false);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId]);
  useEffect(load, [load]);

  // Não perder edição ao fechar a aba do navegador.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const canEdit = !!detail?.can_edit;
  const change = (path: string, value: unknown) => {
    setDraft((d) => draftSet(d, path, value));
    setDirty(true);
  };

  const save = async (toSave: AgentDraft = draft): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await agentOp<{ draft_validation: { errors: DraftError[] } }>(company, agentId, "draft", { draft: toSave });
      setErrors(r.draft_validation.errors);
      setDirty(false);
      setDetail((d) => (d ? { ...d, agent: { ...d.agent, draft: toSave, draft_updated_at: new Date().toISOString() } } : d));
      return true;
    } catch (e) {
      notify(errorOf(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (dirty && !window.confirm("Há mudanças não salvas no rascunho. Sair mesmo assim?")) return;
    onClose();
  };

  if (error)
    return (
      <div className="ab-page">
        <button type="button" className="agent-link-btn" onClick={onClose}>
          <ArrowLeft size={15} aria-hidden="true" /> Agentes MAVI
        </button>
        <p className="form-error" role="alert">{error}</p>
      </div>
    );
  if (!detail) return <Loading variant="page" />;
  const a = detail.agent;
  const errorFor = (path: string) => errors.find((e) => e.path === path || e.path.startsWith(`${path}.`))?.message;

  return (
    <div className="ab-page ab-editor">
      <div className="ab-editor-top">
        <button type="button" className="agent-link-btn" onClick={close}>
          <ArrowLeft size={15} aria-hidden="true" /> Agentes MAVI
        </button>
        <div className="ab-editor-title">
          <h2 className="ab-title">{a.name}</h2>
          <StatusBadge agent={a} />
          <span className="muted ab-meta">
            {data.clients.find((c) => c.id === a.external_ref.mavi_client_id)?.name}
            {a.external_ref.mavi_contract_id ? ` · ${contractProductLabel(data, a.external_ref.mavi_contract_id)}` : ""}
          </span>
        </div>
        <div className="ab-editor-actions">
          {canEdit && (
            <>
              <Button
                type="button"
                className="btn secondary"
                disabled={!dirty}
                loading={saving}
                onClick={() => void save().then((ok) => ok && notify("Rascunho salvo."))}
              >
                <Save size={15} aria-hidden="true" /> {dirty ? "Salvar rascunho" : "Rascunho salvo"}
              </Button>
              <Button
                type="button"
                className="btn secondary"
                onClick={() =>
                  agentOp(company, agentId, "update", { status: a.status === "active" ? "paused" : "active" })
                    .then(() => {
                      notify(a.status === "active" ? "Agente pausado: ele para de responder." : "Agente ativo de novo.");
                      load();
                    })
                    .catch((e) => notify(errorOf(e)))
                }
              >
                {a.status === "active" ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                {a.status === "active" ? "Pausar" : "Ativar"}
              </Button>
              <Button type="button" className={`btn secondary ab-mavi-btn ${assistant ? "on" : ""}`} onClick={() => setAssistant(!assistant)}>
                <Sparkles size={15} aria-hidden="true" /> Montar com a MAVI
              </Button>
              <Button type="button" className="btn primary" onClick={() => setPublishing(true)}>
                Publicar
              </Button>
            </>
          )}
        </div>
      </div>
      {!canEdit && <p className="ab-notice">Você vê este agente, mas só quem edita o produto do cliente no Drive pode mudar.</p>}
      {errors.length > 0 && DRAFT_TABS.has(tab) && (
        <p className="ab-notice warn">
          <TriangleAlert size={15} aria-hidden="true" /> Faltam {errors.length === 1 ? "1 campo" : `${errors.length} campos`} para
          publicar: {[...new Set(errors.map((e) => FIELD_LABEL[e.path] ?? (e.path.startsWith("integrations") ? "integrações" : e.path.startsWith("followup") ? "follow-up" : e.path)))].join(", ")}.
        </p>
      )}

      <div className={`ab-editor-layout ${assistant && canEdit ? "with-assistant" : ""}`}>
        <div className="ab-editor-main">
          <nav className="ab-tabs" role="tablist" aria-label="Partes do agente">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "selected" : ""}
                onClick={() => setTab(t.id)}
              >
                <t.icon size={15} aria-hidden="true" /> {t.label}
                {DRAFT_TABS.has(t.id) && errors.some((e) => TAB_OF(e.path) === t.id) && <span className="ab-dot" aria-label="tem pendência" />}
              </button>
            ))}
          </nav>

          <ModelOptionsContext.Provider value={models}>
            <fieldset className="ab-panel" disabled={!canEdit && FORM_TABS.has(tab)}>
              {FORM_TABS.has(tab) && <CatalogForm tab={tab as "profile" | "instructions" | "behavior"} p={{ draft, change, errorFor }} />}
            </fieldset>
            {tab === "behavior" && <AgentKeysSection company={company} agentId={agentId} draft={draft} canEdit={canEdit} notify={notify} />}
              {tab === "integrations" && <IntegrationsPanel company={company} agentId={agentId} draft={draft} canEdit={canEdit} change={change} errorFor={errorFor} />}
              {tab === "scenarios" && <ScenariosPanel company={company} agentId={agentId} draft={draft} canEdit={canEdit} change={change} errorFor={errorFor} />}
              {tab === "followup" && <FollowupPanel company={company} agentId={agentId} detail={detail} draft={draft} canEdit={canEdit} change={change} errorFor={errorFor} />}
          </ModelOptionsContext.Provider>
          {tab === "knowledge" && <KnowledgePanel key={knowledgeKey} company={company} agentId={agentId} canEdit={canEdit} notify={notify} />}
          {tab === "test" && (
            <SimulatorPanel
              company={company}
              agentId={agentId}
              dirty={dirty}
              saveFirst={save}
              published={a.published_version}
              valid={!errors.length}
              notify={notify}
            />
          )}
          {tab === "inboxes" && <InboxesPanel company={company} detail={detail} canEdit={canEdit} notify={notify} reload={load} />}
          {tab === "versions" && <VersionsPanel company={company} agentId={agentId} canEdit={canEdit} notify={notify} reload={load} />}
          {tab === "conversations" && <ConversationsPanel company={company} agentId={agentId} canEdit={canEdit} notify={notify} />}
          {tab === "insights" && (
            <InsightsPanel company={company} agentId={agentId} canEdit={canEdit} notify={notify} initial={linked.period} onOpenGaps={() => setTab("gaps")} />
          )}
          {tab === "costs" && <AgentCostsPanel company={company} agentId={agentId} bindings={detail.bindings} />}
          {tab === "simulated" && (
            <TestRunsPanel company={company} agentId={agentId} canEdit={canEdit} published={a.published_version} notify={notify} openRun={linked.run} />
          )}
          {tab === "gaps" && (
            <GapsPanel company={company} agentId={agentId} canEdit={canEdit} notify={notify} onTrained={() => setKnowledgeKey((k) => k + 1)} />
          )}
        </div>
        {assistant && canEdit && (
          <AgentAssistant
            company={company}
            agentId={agentId}
            draft={draft}
            notify={notify}
            onClose={() => setAssistant(false)}
            onKnowledgeChanged={() => setKnowledgeKey((k) => k + 1)}
            applyFields={async (changes) => {
              const next = changes.reduce<AgentDraft>((d, c) => draftSet(d, c.path, c.value ?? undefined), draft);
              setDraft(next);
              return save(next);
            }}
          />
        )}
      </div>
      {publishing && (
        <PublishModal
          dirty={dirty}
          errors={errors}
          test={canEdit ? { company, agentId, published: a.published_version, saveFirst: () => (dirty ? save() : Promise.resolve(true)) } : undefined}
          onClose={() => setPublishing(false)}
          onPublish={async (note) => {
            if (dirty && !(await save())) return;
            try {
              const r = await agentOp<{ version: number }>(company, agentId, "publish", { note });
              setPublishing(false);
              notify(
                detail.bindings.length
                  ? `Versão ${r.version} publicada: já vale nas caixas ligadas.`
                  : `Versão ${r.version} publicada. Ligue uma caixa para ele atender no WhatsApp.`,
              );
              load();
            } catch (e) {
              const err = e as { details?: DraftError[] };
              if (err.details?.length) setErrors(err.details);
              notify(errorOf(e));
            }
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ campos
const FIELD_LABEL: Record<string, string> = {
  ...Object.fromEntries(FIELDS.map((f) => [f.path, f.label.toLowerCase()])),
  persona: "perfil",
  instructions: "instruções",
};
const TAB_OF = (path: string): Tab =>
  path.startsWith("integrations")
    ? "integrations"
    : path.startsWith("scenarios")
      ? "scenarios"
      : path.startsWith("followup")
      ? "followup"
      : ((FIELD_BY_PATH.get(path)?.tab as Tab | undefined) ?? (path.startsWith("persona") ? "profile" : path.startsWith("instructions") ? "instructions" : "behavior"));

// ------------------------------------------------------------ publicar e versões
function PublishModal({
  dirty,
  errors,
  onClose,
  onPublish,
  test,
}: {
  dirty: boolean;
  errors: DraftError[];
  onClose: () => void;
  onPublish: (note: string) => Promise<void>;
  /** A bateria rápida com leads simulados antes de publicar. */
  test?: { company: string; agentId: string; published: number | null; saveFirst: () => Promise<boolean> };
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Publicar o agente" onClose={onClose} busy={busy}>
      <form
        className="ab-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onPublish(note.trim()).finally(() => setBusy(false));
        }}
      >
        <p className="muted">
          A versão publicada passa a responder nas caixas ligadas a este agente
          {dirty ? ". As mudanças não salvas serão salvas antes" : ""}. Teste antes na aba Testar.
        </p>
        {errors.length > 0 && (
          <p className="ab-notice warn">
            <TriangleAlert size={15} aria-hidden="true" /> Complete antes: {errors.map((x) => FIELD_LABEL[x.path] ?? x.path).join(", ")}.
          </p>
        )}
        {test && errors.length === 0 && <PublishTestBox {...test} />}
        <label>
          <span>O que mudou (opcional)</span>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Ex.: novo roteiro de qualificação" />
        </label>
        <div className="agent-editor-foot">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy} disabled={errors.length > 0 && !dirty}>
            Publicar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function VersionsPanel({
  company,
  agentId,
  canEdit,
  notify,
  reload,
}: {
  company: string;
  agentId: string;
  canEdit: boolean;
  notify: (m: string) => void;
  reload: () => void;
}) {
  const [data, setData] = useState<{ versions: AgentVersion[]; published_version: number | null } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const load = useCallback(() => {
    agentOp<{ versions: AgentVersion[]; published_version: number | null }>(company, agentId, "versions")
      .then(setData)
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId]);
  useEffect(load, [load]);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!data) return <Loading variant="list" />;
  if (!data.versions.length) return <p className="muted">Nenhuma versão publicada ainda.</p>;
  return (
    <ul className="ab-list">
      {data.versions.map((v) => (
        <li key={v.version} className="ab-row">
          <span className="ab-row-main">
            <strong>
              Versão {v.version}
              {v.version === data.published_version && <span className="ab-badge on">no ar</span>}
            </strong>
            <span className="muted">
              {when(v.created_at)}
              {v.published_by ? ` · ${v.published_by}` : ""}
              {v.restored_from ? ` · cópia da versão ${v.restored_from}` : ""}
              {v.note ? ` · ${v.note}` : ""}
            </span>
          </span>
          {canEdit && v.version !== data.published_version && (
            <Button
              type="button"
              className="btn secondary compact"
              loading={busy === v.version}
              onClick={() => {
                if (!window.confirm(`Publicar de novo a versão ${v.version}? Ela passa a responder nas caixas ligadas.`)) return;
                setBusy(v.version);
                agentOp<{ version: number }>(company, agentId, "publish", { restore_version: v.version, note: `Volta para a versão ${v.version}` })
                  .then((r) => {
                    notify(`Versão ${v.version} publicada de novo como versão ${r.version}.`);
                    load();
                    reload();
                  })
                  .catch((e) => notify(errorOf(e)))
                  .finally(() => setBusy(null));
              }}
            >
              Voltar para esta
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ caixas do MakeCRM
function InboxesPanel({
  company,
  detail,
  canEdit,
  notify,
  reload,
}: {
  company: string;
  detail: AgentDetail;
  canEdit: boolean;
  notify: (m: string) => void;
  reload: () => void;
}) {
  const agentId = detail.agent.id;
  const [inboxes, setInboxes] = useState<MakecrmInbox[] | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<MakecrmInbox | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const load = useCallback(() => {
    if (!canEdit) return;
    agentOp<{ inboxes: MakecrmInbox[] }>(company, agentId, "inboxes")
      .then((r) => setInboxes(r.inboxes))
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, canEdit]);
  useEffect(load, [load]);
  const bindingOf = (inbox: string) => detail.bindings.find((b) => b.inbox_id === inbox);

  return (
    <div className="ab-stack">
      <p className="muted ab-section-intro">
        Ligue o agente às caixas de WhatsApp do cliente no MakeCRM. As mensagens que chegam na caixa passam a ser respondidas pela
        versão publicada. Quando alguém da equipe responde pelo celular, o MakeCRM desliga a IA naquela conversa.
      </p>
      {!detail.agent.published_version && (
        <p className="ab-notice warn">
          <TriangleAlert size={15} aria-hidden="true" /> Publique o agente antes: sem versão publicada ele não responde.
        </p>
      )}
      {warnings.length > 0 && (
        <div className="ab-notice">
          {warnings.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
      )}
      {!canEdit && (
        <ul className="ab-list">
          {detail.bindings.length ? (
            detail.bindings.map((b) => (
              <li key={b.id} className="ab-row">
                <strong>{b.inbox_name}</strong>
                <span className="muted">ligada em {when(b.created_at)}</span>
              </li>
            ))
          ) : (
            <li className="muted">Nenhuma caixa ligada.</li>
          )}
        </ul>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {canEdit && !inboxes && !error && <Loading variant="list" />}
      {canEdit && inboxes && (
        <ul className="ab-list">
          {inboxes.map((i) => {
            const mine = bindingOf(i.id);
            const other = i.bound_agent && i.bound_agent.id !== agentId ? i.bound_agent : null;
            return (
              <li key={i.id} className={`ab-row ${i.status ? "" : "off"}`}>
                <span className="ab-row-main">
                  <strong>{i.name}</strong>
                  <span className="muted">
                    {i.kind === "whatsapp_uazapi" ? "WhatsApp (QR Code)" : "WhatsApp Business API"}
                    {!i.status ? " · desconectada" : ""}
                    {other ? ` · ligada ao agente "${other.name}"` : ""}
                  </span>
                </span>
                {mine ? (
                  <span className="ab-row-actions">
                    <span className="ab-badge on">Ligada</span>
                    <Button
                      type="button"
                      className="btn secondary compact"
                      loading={busy === i.id}
                      onClick={() => {
                        if (!window.confirm(`Desligar o agente da caixa "${i.name}"? A caixa volta para o que respondia antes.`)) return;
                        setBusy(i.id);
                        agentOp<{ restored_webhook_url: string | null }>(company, agentId, "unbind", { binding: mine.id })
                          .then((r) => {
                            notify(r.restored_webhook_url ? "Caixa desligada: voltou para o atendimento anterior." : "Caixa desligada: sem IA.");
                            reload();
                            load();
                          })
                          .catch((e) => notify(errorOf(e)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      Desligar
                    </Button>
                  </span>
                ) : (
                  !other && (
                    <Button type="button" className="btn secondary compact" onClick={() => setConfirm(i)}>
                      Ligar a este agente
                    </Button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirm && (
        <Modal title="Ligar a caixa ao agente" onClose={() => setConfirm(null)} busy={busy === confirm.id}>
          <div className="ab-form">
            <p>
              A caixa <strong>{confirm.name}</strong> passa a ser atendida por <strong>{detail.agent.name}</strong> (versão
              publicada). O que respondia antes nesta caixa (n8n ou outro agente) deixa de responder; ao desligar, ele volta.
            </p>
            <p className="muted">O MakeCRM pode levar até 1 hora para começar a mandar as mensagens para o agente novo.</p>
            <div className="agent-editor-foot">
              <Button type="button" className="btn secondary" onClick={() => setConfirm(null)}>
                Cancelar
              </Button>
              <Button
                type="button"
                className="btn primary"
                loading={busy === confirm.id}
                onClick={() => {
                  const inbox = confirm;
                  setBusy(inbox.id);
                  agentOp<{ warnings: string[] }>(company, agentId, "bind", { inbox_id: inbox.id })
                    .then((r) => {
                      setWarnings(r.warnings ?? []);
                      notify(`Caixa "${inbox.name}" ligada ao agente.`);
                      setConfirm(null);
                      reload();
                      load();
                    })
                    .catch((e) => notify(errorOf(e)))
                    .finally(() => setBusy(null));
                }}
              >
                Ligar
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
