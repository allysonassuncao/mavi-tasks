import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BookOpen,
  Bot,
  FlaskConical,
  History,
  Inbox,
  MessagesSquare,
  Pause,
  Play,
  Plus,
  Save,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { contractProductLabel } from "./domain";
import type { Snapshot } from "./types";
import {
  agentOp,
  createBuilderAgent,
  draftGet,
  draftSet,
  errorOf,
  linesOf,
  when,
  listBuilderAgents,
  type AgentDetail,
  type AgentDraft,
  type AgentVersion,
  type BuilderAgent,
  type DraftError,
  type MakecrmInbox,
} from "./agent-builder";
import { KnowledgePanel } from "./AgentBuilderKnowledge";
import { ConversationsPanel, SimulatorPanel } from "./AgentBuilderTest";
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
          onCreated={(id) => {
            setCreating(false);
            notify("Agente criado. Preencha o perfil e as instruções.");
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
  onCreated: (id: string) => void;
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
          setBusy(true);
          setError("");
          createBuilderAgent(company, { client, contract, name: name.trim() })
            .then((r) => onCreated(r.agent.id))
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
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="agent-editor-foot">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy} disabled={!client || !contract || !name.trim()}>
            Criar agente
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------ construtor
type Tab = "profile" | "instructions" | "knowledge" | "behavior" | "test" | "inboxes" | "versions" | "conversations";
const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "profile", label: "Perfil", icon: UserRound },
  { id: "instructions", label: "Instruções", icon: Sparkles },
  { id: "knowledge", label: "Conhecimento", icon: BookOpen },
  { id: "behavior", label: "Comportamento", icon: SlidersHorizontal },
  { id: "test", label: "Testar", icon: FlaskConical },
  { id: "inboxes", label: "Caixas", icon: Inbox },
  { id: "versions", label: "Versões", icon: History },
  { id: "conversations", label: "Conversas", icon: MessagesSquare },
];
const DRAFT_TABS = new Set<Tab>(["profile", "instructions", "behavior"]);

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
  const [tab, setTab] = useState<Tab>("profile");
  const [draft, setDraft] = useState<AgentDraft>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<DraftError[]>([]);
  const [publishing, setPublishing] = useState(false);

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

  const save = async (): Promise<boolean> => {
    setSaving(true);
    try {
      const r = await agentOp<{ draft_validation: { errors: DraftError[] } }>(company, agentId, "draft", { draft });
      setErrors(r.draft_validation.errors);
      setDirty(false);
      setDetail((d) => (d ? { ...d, agent: { ...d.agent, draft, draft_updated_at: new Date().toISOString() } } : d));
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
          publicar: {errors.map((e) => FIELD_LABEL[e.path] ?? e.path).join(", ")}.
        </p>
      )}

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

      <fieldset className="ab-panel" disabled={!canEdit && DRAFT_TABS.has(tab)}>
        {tab === "profile" && <ProfileForm draft={draft} change={change} errorFor={errorFor} />}
        {tab === "instructions" && <InstructionsForm draft={draft} change={change} errorFor={errorFor} />}
        {tab === "behavior" && <BehaviorForm draft={draft} change={change} errorFor={errorFor} />}
      </fieldset>
      {tab === "knowledge" && <KnowledgePanel company={company} agentId={agentId} canEdit={canEdit} notify={notify} />}
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
      {tab === "conversations" && <ConversationsPanel company={company} agentId={agentId} />}

      {publishing && (
        <PublishModal
          dirty={dirty}
          errors={errors}
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
  "persona.name": "nome do agente",
  "persona.company": "nome da empresa",
  "instructions.goal": "objetivo",
  persona: "perfil",
  instructions: "instruções",
};
const TAB_OF = (path: string): Tab =>
  path.startsWith("persona") ? "profile" : path.startsWith("instructions") ? "instructions" : "behavior";

type FormProps = {
  draft: AgentDraft;
  change: (path: string, value: unknown) => void;
  errorFor: (path: string) => string | undefined;
};

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className={`ab-field ${error ? "invalid" : ""}`}>
      <span className="ab-label">{label}</span>
      {children}
      {hint && !error && <small className="muted">{hint}</small>}
      {error && <small className="ab-error">{error}</small>}
    </label>
  );
}

function TextField({ p, path, label, hint, placeholder, max, area, rows }: {
  p: FormProps;
  path: string;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
  max?: number;
  area?: boolean;
  rows?: number;
}) {
  const value = String(draftGet(p.draft, path) ?? "");
  return (
    <Field label={label} hint={hint} error={p.errorFor(path)}>
      {area ? (
        <Textarea value={value} onChange={(e) => p.change(path, e.target.value)} placeholder={placeholder} maxLength={max} rows={rows ?? 4} />
      ) : (
        <Input value={value} onChange={(e) => p.change(path, e.target.value)} placeholder={placeholder} maxLength={max} />
      )}
    </Field>
  );
}

/** Lista editada como texto, uma por linha. */
function ListField({ p, path, label, hint, placeholder }: { p: FormProps; path: string; label: string; hint?: ReactNode; placeholder?: string }) {
  const list: string[] = draftGet(p.draft, path) ?? [];
  const [text, setText] = useState(list.join("\n"));
  useEffect(() => {
    if (linesOf(text).join("\n") !== list.join("\n")) setText(list.join("\n"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.join("\n")]);
  return (
    <Field label={label} hint={hint ?? "Uma por linha."} error={p.errorFor(path)}>
      <Textarea
        value={text}
        rows={Math.min(10, Math.max(3, list.length + 1))}
        placeholder={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          p.change(path, linesOf(e.target.value));
        }}
      />
    </Field>
  );
}

function ChoiceField({ p, path, label, options, fallback }: { p: FormProps; path: string; label: string; options: [string, string][]; fallback: string }) {
  return (
    <Field label={label}>
      <Select value={String(draftGet(p.draft, path) ?? fallback)} onValueChange={(v) => p.change(path, v === fallback ? undefined : v)} aria-label={label}>
        {options.map(([v, l]) => (
          <SelectOption key={v} value={v}>
            {l}
          </SelectOption>
        ))}
      </Select>
    </Field>
  );
}

function NumberField({ p, path, label, hint, min, max, fallback, step }: {
  p: FormProps;
  path: string;
  label: string;
  hint?: ReactNode;
  min: number;
  max: number;
  fallback: number;
  step?: number;
}) {
  const v = draftGet(p.draft, path);
  return (
    <Field label={label} hint={hint} error={p.errorFor(path)}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={v ?? ""}
        placeholder={String(fallback)}
        onChange={(e) => p.change(path, e.target.value === "" ? undefined : Number(e.target.value))}
      />
    </Field>
  );
}

function CheckField({ p, path, label, fallback, hint }: { p: FormProps; path: string; label: string; fallback: boolean; hint?: string }) {
  const v = draftGet(p.draft, path);
  const checked = v === undefined ? fallback : !!v;
  return (
    <label className="agent-check ab-check">
      <input type="checkbox" checked={checked} onChange={(e) => p.change(path, e.target.checked === fallback ? undefined : e.target.checked)} />
      <span>
        {label}
        {hint && <small className="muted"> — {hint}</small>}
      </span>
    </label>
  );
}

function Group({ title, children, intro }: { title: string; intro?: string; children: ReactNode }) {
  return (
    <section className="ab-section">
      <h3>{title}</h3>
      {intro && <p className="muted ab-section-intro">{intro}</p>}
      <div className="ab-grid">{children}</div>
    </section>
  );
}

function ProfileForm(p: FormProps) {
  return (
    <>
      <Group title="Quem é o agente">
        <TextField p={p} path="persona.name" label="Nome do agente" placeholder="Clara" max={60} hint="Como ele se apresenta ao lead." />
        <TextField p={p} path="persona.role" label="Papel" placeholder="assistente virtual" max={120} />
        <TextField p={p} path="persona.tone" label="Tom de voz" placeholder="cordial, natural e direto, como uma pessoa real no WhatsApp" max={300} />
        <ChoiceField
          {...p}
          p={p}
          path="persona.reply_size"
          label="Tamanho das respostas"
          fallback="short"
          options={[
            ["short", "Curtas (1 a 2 frases)"],
            ["medium", "Médias (até 4 frases)"],
            ["long", "Mais detalhadas"],
          ]}
        />
        <ChoiceField
          {...p}
          p={p}
          path="persona.emoji"
          label="Emojis"
          fallback="few"
          options={[
            ["none", "Nenhum"],
            ["few", "Poucos"],
            ["many", "À vontade"],
          ]}
        />
        <TextField p={p} path="persona.language" label="Idioma" placeholder="português do Brasil" max={60} />
      </Group>
      <Group title="A empresa">
        <TextField p={p} path="persona.company" label="Nome da empresa" placeholder="Make Vendas" max={120} />
        <TextField p={p} path="persona.segment" label="Segmento" placeholder="Marketing digital" max={120} />
        <TextField p={p} path="persona.address" label="Endereço" max={400} />
        <TextField
          {...p}
          p={p}
          path="persona.company_summary"
          label="Sobre a empresa"
          area
          rows={5}
          max={4000}
          hint="O essencial que o agente precisa saber sempre. Detalhes (preços, políticas, catálogo) vão na base de conhecimento."
        />
      </Group>
    </>
  );
}

function InstructionsForm(p: FormProps) {
  return (
    <>
      <Group title="Objetivo e roteiro">
        <TextField
          {...p}
          p={p}
          path="instructions.goal"
          label="Objetivo"
          area
          rows={3}
          max={4000}
          placeholder="Ex.: Entender o que o lead procura, tirar dúvidas e agendar uma reunião com o time comercial."
        />
        <TextField
          {...p}
          p={p}
          path="instructions.conversation_guide"
          label="Roteiro da conversa"
          area
          rows={8}
          max={20000}
          placeholder={"1. Cumprimente e pergunte o nome.\n2. Entenda o negócio do lead.\n3. ..."}
          hint="As etapas e perguntas, na ordem. O agente segue como guia, sem copiar as frases."
        />
        <TextField p={p} path="instructions.business_hours" label="Horários de funcionamento" area rows={2} max={2000} placeholder="Segunda a sexta, 9h às 18h" />
      </Group>
      <Group title="Regras">
        <ListField p={p} path="instructions.rules" label="Regras" placeholder="Só agende reuniões em dias úteis." />
        <ListField p={p} path="instructions.never" label="O agente nunca deve" placeholder="Prometer desconto." />
      </Group>
      <Group title="Texto livre" intro="Para trazer um prompt pronto (do n8n, por exemplo) enquanto ele não é dividido nos campos acima.">
        <TextField p={p} path="instructions.extra" label="Instruções adicionais" area rows={10} max={60000} />
      </Group>
    </>
  );
}

const MODELS = [
  "openai/gpt-5.2",
  "openai/gpt-5.6-luna",
  "openai/gpt-5-mini",
  "openai/gpt-4.1",
  "anthropic/claude-sonnet-4.6",
  "google/gemini-3.1-flash-lite",
  "deepseek/deepseek-v4-pro",
];

function BehaviorForm(p: FormProps) {
  return (
    <>
      <Group title="Conhecimento" intro="Como o agente usa a base de conhecimento a cada mensagem.">
        <CheckField p={p} path="knowledge.enabled" label="Usar a base de conhecimento" fallback />
        <NumberField p={p} path="knowledge.prefetch_k" label="Trechos buscados a cada mensagem" min={0} max={20} fallback={6} hint="0 = só quando o agente pesquisar." />
        <CheckField p={p} path="knowledge.search_tool" label="Deixar o agente pesquisar mais quando precisar" fallback />
        <CheckField p={p} path="knowledge.rerank" label="Reordenar os resultados com IA" fallback={false} hint="mais preciso, cerca de 1 s a mais" />
      </Group>
      <Group title="Memória">
        <NumberField p={p} path="memory.history_messages" label="Mensagens recentes lembradas inteiras" min={4} max={100} fallback={30} hint="As mais antigas viram um resumo." />
        <CheckField p={p} path="memory.summary" label="Resumir as mensagens antigas" fallback />
        <ListField p={p} path="memory.contact_fields" label="Dados do contato a guardar" placeholder={"nome\ne-mail\ncidade"} hint="Um por linha. O agente registra quando o lead informar e não pergunta de novo." />
      </Group>
      <Group title="Mensagens do lead">
        <NumberField p={p} path="buffer.seconds" label="Espera antes de responder (segundos)" min={0} max={60} fallback={8} hint="Junta as mensagens que o lead manda em sequência." />
        <CheckField p={p} path="media.audio" label="Ouvir áudios (transcrição)" fallback />
        <CheckField p={p} path="media.images" label="Ver imagens" fallback />
        <CheckField p={p} path="media.documents" label="Ler documentos (PDF, DOCX)" fallback />
      </Group>
      <Group title="Respostas">
        <NumberField p={p} path="output.max_messages" label="Máximo de mensagens por resposta" min={1} max={8} fallback={4} />
        <CheckField p={p} path="output.typing_delay" label="Pausa de digitação entre as mensagens" fallback />
        <CheckField p={p} path="output.strip_trailing_period" label="Tirar o ponto final das mensagens" fallback />
        <CheckField p={p} path="output.no_em_dash" label="Não usar travessão (—)" fallback />
      </Group>
      <Group title="Passar para uma pessoa">
        <CheckField p={p} path="handoff.enabled" label="O agente pode passar a conversa para a equipe" fallback hint="desliga a IA na conversa e deixa uma nota no MakeCRM" />
        <TextField p={p} path="handoff.when" label="Quando passar (além de quando o lead pedir)" area rows={2} max={2000} placeholder="Ex.: quando o lead quiser negociar valores." />
        <TextField p={p} path="handoff.message" label="O que dizer ao passar" max={500} placeholder="Vou te passar para alguém da equipe, tá? Já já te respondem por aqui." />
      </Group>
      <Group title="Modelo" intro="Deixe em branco para usar o padrão do motor.">
        <Field label="Modelo">
          <Input list="ab-models" value={draftGet(p.draft, "model.model") ?? ""} placeholder="padrão do motor" onChange={(e) => p.change("model.model", e.target.value.trim() || undefined)} />
        </Field>
        <Field label="Modelo reserva (se o principal falhar)">
          <Input list="ab-models" value={draftGet(p.draft, "model.fallback_model") ?? ""} placeholder="padrão do motor" onChange={(e) => p.change("model.fallback_model", e.target.value.trim() || undefined)} />
        </Field>
        <ChoiceField
          {...p}
          p={p}
          path="model.effort"
          label="Esforço de raciocínio"
          fallback=""
          options={[
            ["", "Padrão do modelo"],
            ["low", "Baixo (mais rápido)"],
            ["medium", "Médio"],
            ["high", "Alto (mais caro)"],
          ]}
        />
        <datalist id="ab-models">
          {MODELS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Group>
    </>
  );
}

// ------------------------------------------------------------ publicar e versões
function PublishModal({
  dirty,
  errors,
  onClose,
  onPublish,
}: {
  dirty: boolean;
  errors: DraftError[];
  onClose: () => void;
  onPublish: (note: string) => Promise<void>;
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
