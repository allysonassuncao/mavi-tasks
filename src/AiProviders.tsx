import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Route,
  Search,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import { contractProductLabel } from "./domain";
import { fold } from "./task-search";
import type { Snapshot } from "./types";
import { listSkills, type SkillSummary } from "./mavi-skills";
import {
  deleteProvider,
  fetchProviderModels,
  providerLibrary,
  saveProvider,
  serverDefaults,
  setAiEffort,
  setAiRoute,
  setProviderActive,
  testProvider,
  type AiLibrary,
  type AiProvider,
  type ListedModel,
  type ProviderDraft,
  type ServerDefaults,
} from "./ai";
import {
  CATALOG,
  FEATURES,
  catalogEntry,
  featureInfo,
  isJevModel,
  isImageModel,
  isNonChatModel,
  isTranscribeModel,
  IMAGE_KINDS,
  TRANSCRIBE_KINDS,
  WEB_KINDS,
  keyHint as keyHintOf,
  pickRoute,
  safeBaseUrl,
  type AiFeature,
  type AiRoute,
  type ProviderKind,
  type ProviderModel,
  type RouteScope,
} from "./ai-providers";

/**
 * Painel de IA › Provedores e modelos / Quem usa qual IA
 * (administradores). A biblioteca guarda os provedores com a API Key (selada
 * no servidor; aqui só aparece o final) e os modelos com os preços; as
 * regras dizem qual provedor e modelo respondem para a empresa, cada
 * funcionalidade, pessoa, cliente, produto e projeto.
 */

const money = (v: number | undefined) =>
  v === undefined || v === null || Number.isNaN(v)
    ? "—"
    : `US$ ${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 4 })}`;

/** O que a tela faz com a biblioteca (no banco, ou na demonstração). */
export type LibraryApi = {
  setActive: (id: string, active: boolean) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  setRoute: (
    type: RouteScope,
    id: string | null,
    provider: string | null,
    model: string | null,
  ) => Promise<unknown>;
  /** O esforço de uma funcionalidade ou skill ("skill:<id>"); nulo: automático. */
  setEffort: (key: string, effort: string | null) => Promise<unknown>;
  save: (draft: ProviderDraft) => Promise<{ id: string }>;
  models: (
    args: Parameters<typeof fetchProviderModels>[1],
  ) => Promise<{ models: ListedModel[] }>;
  test: (
    args: Parameters<typeof testProvider>[1],
  ) => Promise<{ ok: boolean; ms: number; reply: string }>;
};

/** A biblioteca, carregada uma vez e recarregada depois de cada mudança. */
export function useAiLibrary(company: string, demo = false) {
  const [library, setLibrary] = useState<AiLibrary | null>(() =>
    demo ? demoLibrary() : null,
  );
  const [error, setError] = useState("");
  // O padrão do servidor de cada funcionalidade (os modelos da Vercel).
  const [defaults, setDefaults] = useState<ServerDefaults | null>(() =>
    demo ? DEMO_DEFAULTS : null,
  );
  useEffect(() => {
    if (!demo)
      serverDefaults()
        .then(setDefaults)
        .catch(() => setDefaults(null));
  }, [demo]);
  const reload = useCallback(
    () =>
      demo
        ? Promise.resolve()
        : providerLibrary(company)
            .then((l) => {
              setLibrary(l);
              setError("");
            })
            .catch((e) => setError((e as Error).message)),
    [company, demo],
  );
  useEffect(() => {
    void reload();
  }, [reload]);
  const api = useMemo<LibraryApi>(
    () =>
      demo
        ? demoApi(setLibrary)
        : {
            setActive: (id, active) => setProviderActive(company, id, active),
            remove: (id) => deleteProvider(company, id),
            setRoute: (type, id, provider, model) =>
              setAiRoute(company, type, id, provider, model),
            setEffort: (key, effort) => setAiEffort(company, key, effort),
            save: (draft) => saveProvider(company, draft),
            models: (args) => fetchProviderModels(company, args),
            test: (args) => testProvider(company, args),
          },
    [company, demo],
  );
  return { library, error, reload, api, defaults };
}

// ------------------------------------------------------------ demonstração
const DEMO_OPENAI = "demo-openai";
const DEMO_DEFAULTS: ServerDefaults = {
  claudeKey: true,
  openaiKey: true,
  features: Object.fromEntries(
    FEATURES.map((f) => [
      f.id,
      {
        model: f.transcription
          ? "gpt-4o-mini-transcribe"
          : f.images
            ? "gpt-image-1"
            : "claude-opus-5-5",
        env: f.env,
      },
    ]),
  ),
  embedding: { model: "text-embedding-3-small", env: "AI_EMBEDDING_MODEL" },
};
function demoLibrary(): AiLibrary {
  const now = new Date().toISOString();
  return {
    providers: [
      {
        id: "demo-claude",
        name: "Claude da agência",
        kind: "anthropic",
        base_url: null,
        key_hint: "a1B2",
        models: catalogEntry("anthropic")!.models.slice(0, 3),
        active: true,
        updated_at: now,
        routes: 1,
      },
      {
        id: DEMO_OPENAI,
        name: "OpenAI",
        kind: "openai",
        base_url: null,
        key_hint: "9xYz",
        models: [
          { id: "gpt-exemplo", label: "GPT (exemplo)", input: 2, output: 8 },
          { id: "gpt-exemplo-mini", label: "GPT mini (exemplo)", input: 0.4, output: 1.6 },
        ],
        active: true,
        updated_at: now,
        routes: 1,
      },
    ],
    routes: [
      {
        id: "demo-route-company",
        type: "company",
        scope_id: null,
        provider_id: "demo-claude",
        model: "claude-sonnet-5",
      },
      {
        id: "demo-route-feature",
        type: "feature",
        scope_id: null,
        feature: "whatsapp_task",
        provider_id: DEMO_OPENAI,
        model: "gpt-exemplo-mini",
      },
    ],
  };
}
function demoApi(
  set: (update: (l: AiLibrary | null) => AiLibrary | null) => void,
): LibraryApi {
  const count = (l: AiLibrary): AiLibrary => ({
    ...l,
    providers: l.providers.map((p) => ({
      ...p,
      routes: l.routes.filter((r) => r.provider_id === p.id).length,
    })),
  });
  const change = (fn: (l: AiLibrary) => AiLibrary) =>
    Promise.resolve(set((l) => (l ? count(fn(l)) : l)));
  return {
    setActive: (id, active) =>
      change((l) => ({
        ...l,
        providers: l.providers.map((p) => (p.id === id ? { ...p, active } : p)),
      })),
    remove: (id) =>
      change((l) => ({
        ...l,
        providers: l.providers.filter((p) => p.id !== id),
        routes: l.routes.filter((r) => r.provider_id !== id),
      })),
    setEffort: (key, effort) =>
      change((l) => {
        const efforts = { ...(l.efforts ?? {}) };
        if (effort) efforts[key] = effort;
        else delete efforts[key];
        return { ...l, efforts };
      }),
    setRoute: (type, id, provider, model) =>
      change((l) => {
        const feature = type === "feature" ? (id as AiFeature) : null;
        const scope = type === "company" || type === "feature" ? null : id;
        const others = l.routes.filter(
          (r) =>
            !(
              r.type === type &&
              r.scope_id === scope &&
              (r.feature ?? null) === feature
            ),
        );
        return {
          ...l,
          routes: provider
            ? [
                ...others,
                {
                  id: `demo-${type}-${id}`,
                  type,
                  scope_id: scope,
                  feature,
                  provider_id: provider,
                  model: model!,
                },
              ]
            : others,
        };
      }),
    save: async (draft) => {
      const id = draft.id ?? `demo-${Date.now()}`;
      await change((l) => {
        const old = l.providers.find((p) => p.id === id);
        const next: AiProvider = {
          id,
          name: draft.name,
          kind: draft.kind,
          base_url: draft.base_url ?? null,
          key_hint: draft.api_key ? keyHintOf(draft.api_key) : (old?.key_hint ?? ""),
          models: draft.models,
          active: draft.active ?? true,
          updated_at: new Date().toISOString(),
          routes: 0,
        };
        return {
          providers: old
            ? l.providers.map((p) => (p.id === id ? next : p))
            : [...l.providers, next],
          routes: l.routes.filter(
            (r) => r.provider_id !== id || draft.models.some((m) => m.id === r.model),
          ),
        };
      });
      return { id };
    },
    models: async (args) => ({
      models: (catalogEntry(args.kind)?.models.length
        ? catalogEntry(args.kind)!.models
        : [
            { id: "modelo-exemplo-grande", label: "Modelo grande (exemplo)" },
            { id: "modelo-exemplo-rapido", label: "Modelo rápido (exemplo)" },
          ]
      ).map((m) => ({ ...m })),
    }),
    test: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ ok: true, ms: 640, reply: "ok" }), 640),
      ),
  };
}

// ------------------------------------------------------------ biblioteca
export function AiProvidersPanel({
  api,
  library,
  error,
  reload,
  notify,
}: {
  api: LibraryApi;
  library: AiLibrary | null;
  error: string;
  reload: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<AiProvider | "new" | null>(null);
  const [problem, setProblem] = useState("");

  async function toggle(p: AiProvider) {
    setProblem("");
    try {
      await api.setActive(p.id, !p.active);
      notify(p.active ? `${p.name} desligado.` : `${p.name} ligado.`);
      await reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }
  async function remove(p: AiProvider) {
    const rules = p.routes
      ? ` As ${p.routes} regras que o usam deixam de valer (volta a regra mais geral).`
      : "";
    if (!window.confirm(`Remover o provedor "${p.name}" e a API Key salva?${rules}`))
      return;
    setProblem("");
    try {
      await api.remove(p.id);
      notify("Provedor removido.");
      await reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  return (
    <div className="ai-admin">
      <section className="ai-admin-intro panel">
        <div>
          <strong>Biblioteca de provedores</strong>
          <p>
            Cadastre as contas dos provedores de IA da agência — Claude, OpenAI, Gemini,
            OpenRouter e outras compatíveis — com a API Key e os modelos
            liberados. Depois, em <a href="#regras">Quem usa qual modelo</a>,
            escolha o provedor e o modelo de cada funcionalidade, pessoa,
            cliente, produto ou projeto.
          </p>
        </div>
        <Button className="btn primary" onClick={() => setEditing("new")}>
          <Plus size={16} /> Adicionar provedor
        </Button>
      </section>
      {(error || problem) && (
        <p className="form-error" role="alert">
          {error || problem}
        </p>
      )}
      {!library ? (
        !error && <Loading compact />
      ) : (
        <div className="ai-provider-list">
          <article className="ai-provider-card builtin">
            <header>
              <span className="ai-provider-mark" aria-hidden="true">
                <Zap size={16} />
              </span>
              <div>
                <strong>Padrão do servidor</strong>
                <small>Claude, com a chave da Vercel (ANTHROPIC_API_KEY)</small>
              </div>
            </header>
            <p className="muted">
              Responde quando nenhuma regra vale, com o modelo da variável de
              cada funcionalidade (AI_MODEL, MEETINGS_MODEL,
              WHATSAPP_TASK_MODEL e SOCIAL_LEADS_MODEL).
            </p>
          </article>
          {library.providers.map((p) => (
            <ProviderCard
              key={p.id}
              api={api}
              provider={p}
              onEdit={() => setEditing(p)}
              onToggle={() => void toggle(p)}
              onRemove={() => void remove(p)}
            />
          ))}
          {!library.providers.length && (
            <button
              type="button"
              className="ai-provider-card ai-provider-empty"
              onClick={() => setEditing("new")}
            >
              <Plus size={18} />
              <strong>Adicione o primeiro provedor</strong>
              <small>Enquanto isso, tudo usa o padrão do servidor.</small>
            </button>
          )}
        </div>
      )}
      {editing && (
        <ProviderDialog
          api={api}
          provider={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (name) => {
            setEditing(null);
            notify(`${name} salvo.`);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ProviderCard({
  api,
  provider: p,
  onEdit,
  onToggle,
  onRemove,
}: {
  api: LibraryApi;
  provider: AiProvider;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const entry = catalogEntry(p.kind);
  const [model, setModel] = useState(p.models[0]?.id ?? "");
  const [test, setTest] = useState<
    | { state: "running" }
    | { state: "ok"; ms: number; reply: string }
    | { state: "error"; message: string }
    | null
  >(null);
  useEffect(() => {
    if (!p.models.some((m) => m.id === model)) setModel(p.models[0]?.id ?? "");
  }, [p.models, model]);
  async function run() {
    setTest({ state: "running" });
    try {
      const r = await api.test({ id: p.id, kind: p.kind, model });
      setTest({ state: "ok", ms: r.ms, reply: r.reply });
    } catch (e) {
      setTest({ state: "error", message: (e as Error).message });
    }
  }
  return (
    <article className={`ai-provider-card${p.active ? "" : " off"}`}>
      <header>
        <span className="ai-provider-mark" aria-hidden="true">
          {p.name.slice(0, 1).toUpperCase()}
        </span>
        <div>
          <strong>{p.name}</strong>
          <small>
            {entry?.label ?? p.kind}
            {p.base_url ? ` · ${p.base_url.replace(/^https:\/\//, "")}` : ""}
          </small>
        </div>
        <span className={`ai-provider-state ${p.active ? "on" : ""}`}>
          {p.active ? "Ativo" : "Desligado"}
        </span>
      </header>
      <dl className="ai-provider-facts">
        <div>
          <dt>
            <KeyRound size={13} aria-hidden="true" /> API Key
          </dt>
          <dd>•••• {p.key_hint || "salva"}</dd>
        </div>
        <div>
          <dt>
            <Route size={13} aria-hidden="true" /> Regras
          </dt>
          <dd>
            {p.routes
              ? `${p.routes} ${p.routes === 1 ? "regra usa" : "regras usam"}`
              : "nenhuma regra ainda"}
          </dd>
        </div>
      </dl>
      <ul className="ai-model-chips" aria-label={`Modelos de ${p.name}`}>
        {p.models.map((m) => (
          <li key={m.id} title={`${money(m.input)} entrada · ${money(m.output)} saída, por milhão de tokens`}>
            <span>{m.label || m.id}</span>
            <small>
              {m.input}/{m.output}
            </small>
          </li>
        ))}
      </ul>
      <div className="ai-provider-test">
        <Select
          aria-label={`Modelo para testar em ${p.name}`}
          value={model || "none"}
          onValueChange={setModel}
        >
          {p.models.map((m) => (
            <SelectOption key={m.id} value={m.id}>
              {m.label || m.id}
            </SelectOption>
          ))}
        </Select>
        <Button
          className="btn secondary"
          onClick={() => void run()}
          loading={test?.state === "running"}
          disabled={!model}
        >
          Testar
        </Button>
        {test?.state === "ok" && (
          <span className="ai-test-result ok" role="status">
            <CheckCircle2 size={14} aria-hidden="true" /> Funcionou em{" "}
            {(test.ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}{" "}
            s
          </span>
        )}
        {test?.state === "error" && (
          <span className="ai-test-result error" role="alert">
            <XCircle size={14} aria-hidden="true" /> {test.message}
          </span>
        )}
      </div>
      <footer>
        <button type="button" className="text-btn" onClick={onEdit}>
          <Pencil size={14} /> Editar
        </button>
        <button type="button" className="text-btn" onClick={onToggle}>
          <Power size={14} /> {p.active ? "Desligar" : "Ligar"}
        </button>
        <button type="button" className="text-btn danger" onClick={onRemove}>
          <Trash2 size={14} /> Remover
        </button>
      </footer>
    </article>
  );
}

type ModelRow = {
  id: string;
  label: string;
  input: string;
  output: string;
  cached: string;
};
const toRow = (m: Partial<ProviderModel>): ModelRow => ({
  id: m.id ?? "",
  label: m.label ?? "",
  input: m.input === undefined ? "" : String(m.input).replace(".", ","),
  output: m.output === undefined ? "" : String(m.output).replace(".", ","),
  cached: m.cached === undefined ? "" : String(m.cached).replace(".", ","),
});
const price = (v: string) =>
  v.trim() === "" ? NaN : Number(v.trim().replace(",", "."));

function ProviderDialog({
  api,
  provider,
  onClose,
  onSaved,
}: {
  api: LibraryApi;
  provider: AiProvider | null;
  onClose: () => void;
  onSaved: (name: string) => Promise<void>;
}) {
  const [kind, setKind] = useState<ProviderKind | null>(provider?.kind ?? null);
  const entry = kind ? catalogEntry(kind)! : null;
  const [name, setName] = useState(provider?.name ?? "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider?.base_url ?? "");
  const [rows, setRows] = useState<ModelRow[]>(
    provider?.models.map(toRow) ?? [],
  );
  const [listed, setListed] = useState<ListedModel[] | null>(null);
  const [listing, setListing] = useState(false);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function pick(k: ProviderKind) {
    const e = catalogEntry(k)!;
    setKind(k);
    setName((n) => n || (k === "custom" ? "" : e.label));
    setRows(e.models.map(toRow));
    setListed(null);
    setError("");
  }
  const connection = () => ({
    id: provider?.id,
    kind: kind!,
    base_url: baseUrl.trim() || undefined,
    api_key: apiKey.trim() || undefined,
  });
  async function loadModels() {
    setError("");
    setListing(true);
    try {
      const r = await api.models(connection());
      setListed(r.models);
      if (!r.models.length) setError("A API não devolveu nenhum modelo.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setListing(false);
    }
  }
  function toggleListed(m: ListedModel, on: boolean) {
    setRows((list) =>
      on
        ? list.some((r) => r.id === m.id)
          ? list
          : [...list, toRow(m)]
        : list.filter((r) => r.id !== m.id),
    );
  }
  function setRow(i: number, patch: Partial<ModelRow>) {
    setRows((list) => list.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  }

  async function save() {
    setError("");
    if (!kind || !entry) return;
    if (!name.trim()) return setError("Dê um nome ao provedor.");
    if (!provider && !apiKey.trim()) return setError("Informe a API Key.");
    if (kind === "custom" && !baseUrl.trim())
      return setError("Informe o endereço da API.");
    if (baseUrl.trim()) {
      const bad = safeBaseUrl(baseUrl);
      if (bad) return setError(bad);
    }
    const models: ProviderModel[] = [];
    for (const r of rows) {
      if (!r.id.trim()) continue;
      const input = price(r.input);
      const output = price(r.output);
      const cached = r.cached.trim() ? price(r.cached) : undefined;
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0)
        return setError(
          `Informe os preços de entrada e de saída do modelo ${r.id.trim()} (US$ por milhão de tokens).`,
        );
      if (cached !== undefined && (!Number.isFinite(cached) || cached < 0))
        return setError(`Preço de cache inválido no modelo ${r.id.trim()}.`);
      models.push({
        id: r.id.trim(),
        ...(r.label.trim() ? { label: r.label.trim() } : {}),
        input,
        output,
        ...(cached !== undefined ? { cached } : {}),
      });
    }
    if (!models.length) return setError("Adicione ao menos um modelo.");
    setBusy(true);
    try {
      await api.save({
        id: provider?.id,
        name: name.trim(),
        kind,
        base_url: baseUrl.trim() || undefined,
        api_key: apiKey.trim() || undefined,
        models,
        active: provider?.active ?? true,
      });
      await onSaved(name.trim());
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const shownListed = useMemo(() => {
    const q = fold(filter.trim());
    return (listed ?? []).filter(
      (m) => !q || fold(`${m.id} ${m.label ?? ""}`).includes(q),
    );
  }, [listed, filter]);

  return (
    <Modal
      title={provider ? `Editar ${provider.name}` : "Adicionar provedor"}
      onClose={onClose}
      busy={busy}
      className="ai-provider-dialog"
    >
      <div className="entity-form">
        {!entry ? (
          <>
            <small className="muted">Escolha o provedor do modelo.</small>
            <div className="ai-catalog" role="list">
              {CATALOG.map((c) => (
                <button
                  key={c.kind}
                  type="button"
                  role="listitem"
                  className="ai-catalog-item"
                  onClick={() => pick(c.kind)}
                >
                  <span className="ai-provider-mark" aria-hidden="true">
                    {c.kind === "custom" ? "+" : c.label.slice(0, 1)}
                  </span>
                  <span>
                    <strong>{c.label}</strong>
                    <small>
                      {c.api === "anthropic"
                        ? "API oficial da Claude"
                        : c.kind === "openai"
                          ? "API oficial da OpenAI"
                          : c.kind === "custom"
                            ? "Qualquer endereço /chat/completions"
                            : "Pela API compatível com a OpenAI"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="ai-dialog-kind">
              <span className="ai-provider-mark" aria-hidden="true">
                {entry.kind === "custom" ? "+" : entry.label.slice(0, 1)}
              </span>
              <strong>{entry.label}</strong>
              {!provider && (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => setKind(null)}
                >
                  Trocar
                </button>
              )}
            </div>
            <label>
              Nome na biblioteca
              <Input
                value={name}
                maxLength={80}
                placeholder="Ex.: OpenAI da agência"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              API Key
              <Input
                type="password"
                autoComplete="off"
                value={apiKey}
                placeholder={
                  provider
                    ? `•••• ${provider.key_hint} — deixe em branco para manter`
                    : "Cole a chave aqui"
                }
                onChange={(e) => setApiKey(e.target.value)}
              />
              <small className="ai-field-help">
                Fica guardada criptografada; ninguém consegue vê-la de novo, nem
                administradores.
                {entry.keysUrl && (
                  <>
                    {" "}
                    <a href={entry.keysUrl} target="_blank" rel="noreferrer">
                      Onde criar a chave <ExternalLink size={11} />
                    </a>
                  </>
                )}
              </small>
            </label>
            {entry.kind === "custom" ? (
              <label>
                Endereço da API
                <Input
                  value={baseUrl}
                  placeholder="https://api.exemplo.com/v1"
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <small className="ai-field-help">
                  O endereço antes de /chat/completions (Together, Fireworks,
                  Azure OpenAI, um gateway próprio…).
                </small>
              </label>
            ) : (
              <details className="ai-advanced" open={!!baseUrl}>
                <summary>Endereço da API (avançado)</summary>
                <Input
                  value={baseUrl}
                  aria-label="Endereço da API"
                  placeholder={entry.baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
                <small className="ai-field-help">
                  Deixe em branco para usar o endereço oficial.
                </small>
              </details>
            )}

            <section className="ai-models-editor" aria-label="Modelos liberados">
              <div className="ai-models-head">
                <strong>Modelos liberados</strong>
                <span>
                  <Button
                    className="btn secondary"
                    onClick={() => void loadModels()}
                    loading={listing}
                    disabled={!provider && !apiKey.trim()}
                    title={
                      !provider && !apiKey.trim()
                        ? "Informe a API Key primeiro"
                        : undefined
                    }
                  >
                    <RefreshCw size={14} /> Buscar na API
                  </Button>
                  <Button
                    className="btn secondary"
                    onClick={() =>
                      setRows((l) => [
                        ...l,
                        { id: "", label: "", input: "", output: "", cached: "" },
                      ])
                    }
                  >
                    <Plus size={14} /> Manual
                  </Button>
                </span>
              </div>
              <small className="ai-field-help">
                Preços em US$ por milhão de tokens, usados no consumo da MAVI e
                nos limites.
                {entry.pricingUrl && (
                  <>
                    {" "}
                    <a href={entry.pricingUrl} target="_blank" rel="noreferrer">
                      Tabela de preços de {entry.label}{" "}
                      <ExternalLink size={11} />
                    </a>
                  </>
                )}
              </small>
              {listed && listed.length > 0 && (
                <div className="ai-listed">
                  <Input
                    type="search"
                    icon={Search}
                    placeholder={`Filtrar ${listed.length} modelos`}
                    aria-label="Filtrar modelos"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  />
                  <ul>
                    {shownListed.slice(0, 200).map((m) => (
                      <li key={m.id}>
                        <label className="checkbox-label">
                          <Checkbox
                            checked={rows.some((r) => r.id === m.id)}
                            onCheckedChange={(on) => toggleListed(m, on === true)}
                          />
                          <span>
                            {m.id}
                            {m.label && m.label !== m.id && <small>{m.label}</small>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rows.length > 0 ? (
                <div className="ai-model-rows">
                  <div className="ai-model-row head" aria-hidden="true">
                    <span>Modelo (id na API)</span>
                    <span>Entrada</span>
                    <span>Saída</span>
                    <span>Cache</span>
                    <span />
                  </div>
                  {rows.map((r, i) => (
                    <div className="ai-model-row" key={i}>
                      <input
                        className="ai-price"
                        value={r.id}
                        aria-label="Id do modelo"
                        placeholder="ex.: gpt-…"
                        onChange={(e) => setRow(i, { id: e.target.value })}
                      />
                      <input
                        className="ai-price"
                        value={r.input}
                        inputMode="decimal"
                        aria-label={`Preço de entrada de ${r.id || "modelo"}`}
                        placeholder="US$"
                        onChange={(e) => setRow(i, { input: e.target.value })}
                      />
                      <input
                        className="ai-price"
                        value={r.output}
                        inputMode="decimal"
                        aria-label={`Preço de saída de ${r.id || "modelo"}`}
                        placeholder="US$"
                        onChange={(e) => setRow(i, { output: e.target.value })}
                      />
                      <input
                        className="ai-price"
                        value={r.cached}
                        inputMode="decimal"
                        aria-label={`Preço de cache de ${r.id || "modelo"}`}
                        placeholder="opc."
                        onChange={(e) => setRow(i, { cached: e.target.value })}
                      />
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Tirar ${r.id || "modelo"}`}
                        onClick={() => setRows((l) => l.filter((_, k) => k !== i))}
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted ai-models-empty">
                  Busque os modelos na API ou adicione um manualmente.
                </p>
              )}
            </section>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          {entry && (
            <Button
              className="btn primary"
              onClick={() => void save()}
              loading={busy}
            >
              {provider ? "Salvar alterações" : "Adicionar à biblioteca"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ regras
type PersonScope = Exclude<RouteScope, "company" | "feature">;
const SCOPES: { id: PersonScope; label: string; one: string }[] = [
  { id: "user", label: "Pessoas", one: "Pessoa" },
  { id: "client", label: "Clientes", one: "Cliente" },
  { id: "contract", label: "Produtos", one: "Produto" },
  { id: "project", label: "Projetos", one: "Projeto" },
];
const SERVER = "server";

/** As partes da MAVI que não chamam um modelo (nada a escolher). */
const FIXED_ROWS = [
  {
    group: "MAVI · poderes",
    label: "Visualizações (gráficos, tabelas, indicadores, linha do tempo)",
    note: "A MAVI do módulo descreve e o app desenha: não chama outro modelo.",
    value: "Usa o modelo da MAVI do módulo",
  },
  {
    group: "MAVI · poderes",
    label: "Ações com confirmação (propor tarefa e comentário)",
    note: "A MAVI do módulo propõe e a pessoa confirma: não chama outro modelo.",
    value: "Usa o modelo da MAVI do módulo",
  },
  {
    group: "MAVI · ferramentas",
    label: "Consultas (buscar na base, reuniões, tarefas, campanhas, termômetro, skills)",
    note: "Leem o banco com as permissões de quem pergunta: não chamam modelo. A busca por significado usa os vetores abaixo.",
    value: "Não usam modelo",
  },
  {
    group: "MAVI · ferramentas",
    label: "Perguntas antes de seguir",
    note: "Parte do jeito de trabalhar de cada MAVI (bolinha e módulo).",
    value: "Usa o modelo de quem pergunta",
  },
];

function fixedRow(row: (typeof FIXED_ROWS)[number]) {
  return (
    <tr key={row.label}>
      <td>
        <div className="ai-feature-name">
          <span className="ai-feature-group">{row.group}</span>
          <span className="ai-usage-name">{row.label}</span>
          <small className="ai-feature-note info">{row.note}</small>
        </div>
      </td>
      <td>
        <span className="ai-feature-fixed">{row.value}</span>
      </td>
      <td />
    </tr>
  );
}
/** As da MAVI primeiro (bolinha, módulo e poderes), depois as outras. */
const ORDERED = [
  ...FEATURES.filter((f) => f.group.startsWith("MAVI")),
  ...FEATURES.filter((f) => !f.group.startsWith("MAVI")),
];
const MAVI_ROWS = FEATURES.filter((f) => f.group.startsWith("MAVI")).length;

/**
 * Cada skill pode ter o seu modelo: escolhida na caixa de mensagem, a
 * resposta inteira usa ele; carregada pela MAVI, a skill roda nele como
 * ajudante e o resultado volta para a conversa.
 */
/** O esforço (quanto a IA raciocina) que dá para escolher. */
export const EFFORT_OPTIONS: { id: string; label: string }[] = [
  { id: "low", label: "Baixo · mais rápido e barato" },
  { id: "medium", label: "Médio" },
  { id: "high", label: "Alto" },
  { id: "xhigh", label: "Muito alto" },
  { id: "max", label: "Máximo · mais lento e caro" },
];
/** As funcionalidades de conversa em que o esforço muda a resposta. */
export const EFFORT_FEATURES = new Set(["assistant", "mavi_page", "meetings_history", "canvas_writer", "web_search"]);
const effortName = (id: string | undefined) =>
  EFFORT_OPTIONS.find((o) => o.id === id)?.label.split(" · ")[0] ?? "";

function EffortSelect({
  label,
  value,
  auto,
  onChange,
}: {
  label: string;
  value: string | undefined;
  /** O que vale sem escolha. */
  auto: string;
  onChange: (effort: string | null) => void;
}) {
  return (
    <Select
      aria-label={`Esforço de ${label}`}
      value={value ?? "auto"}
      onValueChange={(v) => onChange(v === "auto" ? null : v)}
    >
      <SelectOption value="auto">{auto}</SelectOption>
      {EFFORT_OPTIONS.map((o) => (
        <SelectOption key={o.id} value={o.id}>
          {o.label}
        </SelectOption>
      ))}
    </Select>
  );
}

function SkillRoutes({
  skills,
  routes,
  choices,
  onSet,
  efforts,
  onEffort,
}: {
  skills: SkillSummary[];
  routes: AiRoute[];
  choices: ReactNode;
  onSet: (skill: string, choice: string) => void;
  efforts: Record<string, string>;
  onEffort: (key: string, effort: string | null) => void;
}) {
  const shown = skills.filter((s) => s.published && !s.archived);
  return (
    <section className="panel ai-features" aria-label="Por skill">
      <header>
        <strong>Por skill</strong>
        <small>
          O modelo que roda cada skill. Escolhida na caixa de mensagem, a
          resposta inteira usa este modelo; carregada pela MAVI, a skill roda
          nele como ajudante e o resultado volta para a conversa. Sem escolha,
          vale o modelo da conversa. O esforço vale desde o momento em que a
          skill é carregada; no automático, pelo menos Alto.
        </small>
      </header>
      {!shown.length ? (
        <p className="muted ai-route-empty">Nenhuma skill publicada ainda.</p>
      ) : (
        <div className="drive-table-wrap">
          <table className="drive-table ai-usage-table ai-feature-table">
            <thead>
              <tr>
                <th>Skill</th>
                <th>Provedor e modelo</th>
                <th>Esforço</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const r = routes.find((x) => x.type === "skill" && x.scope_id === s.id);
                return (
                  <tr key={s.id}>
                    <td>
                      <div className="ai-feature-name">
                        <span className="ai-feature-group">{s.slug}</span>
                        <span className="ai-usage-name">{s.current?.name ?? s.slug}</span>
                      </div>
                    </td>
                    <td>
                      <Select
                        aria-label={`Modelo da skill ${s.current?.name ?? s.slug}`}
                        value={r ? `${r.provider_id}|${r.model}` : SERVER}
                        onValueChange={(v) => onSet(s.id, v)}
                      >
                        <SelectOption value={SERVER}>O modelo da conversa</SelectOption>
                        {choices}
                      </Select>
                    </td>
                    <td>
                      <EffortSelect
                        label={s.current?.name ?? s.slug}
                        value={efforts[`skill:${s.id}`]}
                        auto="Automático · pelo menos Alto"
                        onChange={(e) => onEffort(`skill:${s.id}`, e)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function AiRoutesPanel({
  api,
  data,
  library,
  defaults,
  error,
  reload,
  notify,
  canManageProviders = true,
  company,
}: {
  api: LibraryApi;
  data: Snapshot;
  library: AiLibrary | null;
  /** O padrão do servidor de cada funcionalidade (nulo: ainda não veio). */
  defaults: ServerDefaults | null;
  error: string;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  /**
   * Administrador: cadastra provedores e API Keys. Gestores editam as
   * regras entre os provedores já cadastrados.
   */
  canManageProviders?: boolean;
  /** A empresa (as skills, para escolher o modelo de cada uma). */
  company?: string;
}) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  useEffect(() => {
    if (!company) return;
    listSkills(company)
      .then((list) => setSkills(Array.isArray(list) ? list : null))
      .catch(() => setSkills(null));
  }, [company]);
  const [tab, setTab] = useState<PersonScope>("user");
  const [problem, setProblem] = useState("");
  const providers = library?.providers ?? [];
  const routes = library?.routes ?? [];
  const byId = new Map(providers.map((p) => [p.id, p]));

  const nameOf = useCallback(
    (type: RouteScope, id: string | null) => {
      if (type === "feature") return featureInfo(id ?? "")?.label ?? "Funcionalidade";
      if (type === "company" || !id) return "Empresa toda";
      if (type === "user")
        return data.members.find((m) => m.user_id === id)?.name ?? "Pessoa removida";
      if (type === "client")
        return `Cliente ${data.clients.find((c) => c.id === id)?.name ?? "?"}`;
      if (type === "contract") {
        const k = data.contracts.find((c) => c.id === id);
        const client = data.clients.find((c) => c.id === k?.client_id)?.name;
        return k
          ? `${contractProductLabel(data, id)} · cliente ${client ?? "?"}`
          : "Produto removido";
      }
      return data.projects.find((p) => p.id === id)?.name ?? "Projeto removido";
    },
    [data],
  );
  const serverLabel = (feature?: AiFeature) => {
    const d = feature ? defaults?.features[feature] : undefined;
    return d ? `Padrão do servidor · ${d.model}` : "Padrão do servidor";
  };
  const choiceLabel = (
    r: Pick<AiRoute, "provider_id" | "model"> | null,
    feature?: AiFeature,
  ) => {
    if (!r) return serverLabel(feature);
    const p = byId.get(r.provider_id);
    const m = p?.models.find((x) => x.id === r.model);
    return `${p?.name ?? "?"} · ${m?.label || r.model}${p && !p.active ? " (desligado)" : ""}`;
  };

  async function set(
    type: RouteScope,
    id: string | null,
    choice: string,
    quiet = false,
  ) {
    setProblem("");
    const [provider, ...model] = choice === SERVER ? [] : choice.split("|");
    try {
      await api.setRoute(
        type,
        id,
        provider ?? null,
        provider ? model.join("|") : null,
      );
      if (!quiet)
        notify(provider ? "Regra salva." : "Regra removida: vale a mais geral.");
      await reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  const efforts = library?.efforts ?? {};
  async function setEffort(key: string, effort: string | null) {
    setProblem("");
    try {
      await api.setEffort(key, effort);
      notify(effort ? `Esforço salvo: ${effortName(effort)}.` : "Esforço no automático.");
      await reload();
    } catch (e) {
      setProblem((e as Error).message);
    }
  }

  if (!library)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading compact />
    );

  const companyRoute = routes.find((r) => r.type === "company") ?? null;
  const shown = routes.filter((r) => r.type === tab);
  // O Jev (TypeSafe) não conversa: só aparece no termômetro do cliente.
  const option = (p: AiProvider, m: AiProvider["models"][number]) => (
    <SelectOption key={`${p.id}|${m.id}`} value={`${p.id}|${m.id}`}>
      {`${p.name} · ${m.label || m.id}${p.active ? "" : " (desligado)"}`}
    </SelectOption>
  );
  // Conversa: sem o Jev e sem os modelos que só transcrevem ou geram vetores.
  const choices = (
    <>
      {providers.map((p) =>
        p.models
          .filter((m) => !isJevModel(m.id) && !isNonChatModel(m.id))
          .map((m) => option(p, m)),
      )}
    </>
  );
  // Transcrição: provedores com o endpoint de transcrição e os modelos que transcrevem.
  const transcribeOptions = providers
    .filter((p) => TRANSCRIBE_KINDS.includes(p.kind))
    .flatMap((p) =>
      p.models.filter((m) => isTranscribeModel(m.id)).map((m) => option(p, m)),
    );
  const transcribeChoices = transcribeOptions.length ? (
    <>{transcribeOptions}</>
  ) : (
    <SelectOption value="none" disabled>
      Cadastre um modelo de transcrição (ex.: Whisper)
    </SelectOption>
  );
  // Imagens: provedores com o endpoint de imagens e os modelos que geram imagens.
  const imageOptions = providers
    .filter((p) => IMAGE_KINDS.includes(p.kind))
    .flatMap((p) =>
      p.models.filter((m) => isImageModel(m.id)).map((m) => option(p, m)),
    );
  const imageChoices = imageOptions.length ? (
    <>{imageOptions}</>
  ) : (
    <SelectOption value="none" disabled>
      Cadastre um modelo de imagem (ex.: gpt-image-1)
    </SelectOption>
  );
  // Busca na internet: a Claude e o OpenRouter, com modelos de conversa.
  const webOptions = providers
    .filter((p) => WEB_KINDS.includes(p.kind))
    .flatMap((p) =>
      p.models
        .filter((m) => !isJevModel(m.id) && !isNonChatModel(m.id))
        .map((m) => option(p, m)),
    );
  const webChoices = webOptions.length ? (
    <>{webOptions}</>
  ) : (
    <SelectOption value="none" disabled>
      Cadastre um provedor da Claude ou do OpenRouter
    </SelectOption>
  );
  const jevChoices = (
    <>
      {providers
        .filter((p) => p.kind === "openrouter")
        .map((p) => p.models.filter((m) => isJevModel(m.id)).map((m) => option(p, m)))}
    </>
  );

  return (
    <div className="ai-admin">
      <section className="panel ai-route-order">
        <strong>Qual modelo responde</strong>
        <p>
          Vale a regra mais específica para quem pede, onde e em qual
          funcionalidade. As regras de projeto, produto, cliente e pessoa
          valem nas conversas com a MAVI (assistente e gravações); nas outras
          funcionalidades, vale a da funcionalidade e depois a da empresa.
          Provedores desligados são pulados.
        </p>
        <ol aria-label="Ordem das regras">
          {[
            "Projeto",
            "Produto",
            "Cliente",
            "Pessoa",
            "Funcionalidade",
            "Empresa",
            "Padrão do servidor",
          ].map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </section>
      {(error || problem) && (
        <p className="form-error" role="alert">
          {error || problem}
        </p>
      )}
      {!providers.length && (
        <p className="panel ai-route-empty">
          Nenhum provedor na biblioteca ainda: tudo usa o padrão do servidor.{" "}
          {canManageProviders ? (
            <a href="#provedores">Adicionar um provedor</a>
          ) : (
            "Peça a um administrador para cadastrar um provedor."
          )}
        </p>
      )}

      <section className="panel ai-usage-company">
        <div>
          <strong>Padrão da empresa</strong>
          <small>
            Para todo mundo e todas as funcionalidades, quando não há regra mais
            específica.
          </small>
        </div>
        <Select
          aria-label="Modelo padrão da empresa"
          value={companyRoute ? `${companyRoute.provider_id}|${companyRoute.model}` : SERVER}
          onValueChange={(v) => void set("company", null, v)}
        >
          <SelectOption value={SERVER}>Padrão do servidor</SelectOption>
          {choices}
        </Select>
      </section>

      <FeatureRoutes
        routes={routes}
        byId={byId}
        companyLabel={companyRoute ? choiceLabel(companyRoute) : null}
        companyProvider={
          companyRoute ? byId.get(companyRoute.provider_id) : undefined
        }
        serverLabel={serverLabel}
        choices={choices}
        jevChoices={jevChoices}
        transcribeChoices={transcribeChoices}
        imageChoices={imageChoices}
        webChoices={webChoices}
        routeLabel={(r) => choiceLabel(r)}
        embedding={defaults?.embedding}
        onSet={(feature, choice) => void set("feature", feature, choice)}
        efforts={efforts}
        onEffort={(key, effort) => void setEffort(key, effort)}
      />
      {skills && (
        <SkillRoutes
          skills={skills}
          routes={routes}
          choices={choices}
          onSet={(skill, choice) => void set("skill", skill, choice)}
          efforts={efforts}
          onEffort={(key, effort) => void setEffort(key, effort)}
        />
      )}

      <div className="drive-view drive-tabs" role="tablist">
        {SCOPES.map((s) => {
          const n = routes.filter((r) => r.type === s.id).length;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={tab === s.id}
              className={tab === s.id ? "selected" : ""}
              onClick={() => setTab(s.id)}
            >
              {s.label}
              {n > 0 && <span className="ai-tab-count">{n}</span>}
            </button>
          );
        })}
      </div>
      <div className="panel drive-table-wrap">
        <table className="drive-table ai-usage-table">
          <thead>
            <tr>
              <th>{SCOPES.find((s) => s.id === tab)!.one}</th>
              <th>Provedor e modelo</th>
              <th aria-label="Ações" />
            </tr>
          </thead>
          <tbody>
            {shown.length ? (
              shown
                .map((r) => ({ r, name: nameOf(tab, r.scope_id) }))
                .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }))
                .map(({ r, name }) => (
                  <tr key={r.id}>
                    <td>
                      <span className="ai-usage-name">{name}</span>
                    </td>
                    <td>
                      <Select
                        aria-label={`Modelo de ${name}`}
                        value={`${r.provider_id}|${r.model}`}
                        onValueChange={(v) => void set(tab, r.scope_id, v)}
                      >
                        <SelectOption value={SERVER}>
                          Sem regra (vale a mais geral)
                        </SelectOption>
                        {choices}
                      </Select>
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Tirar a regra de ${name}`}
                        title="Tirar a regra"
                        onClick={() => void set(tab, r.scope_id, SERVER)}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))
            ) : (
              <tr>
                <td colSpan={3} className="muted ai-empty-cell">
                  Nenhuma regra para {SCOPES.find((s) => s.id === tab)!.label.toLowerCase()}:
                  vale a regra mais geral.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {providers.length > 0 && (
        <NewRoute
          key={tab}
          tab={tab}
          data={data}
          taken={new Set(shown.map((r) => r.scope_id ?? ""))}
          nameOf={nameOf}
          choices={choices}
          onSave={(id, choice) => void set(tab, id, choice)}
        />
      )}
      <RouteSimulator
        data={data}
        routes={routes}
        serverLabel={serverLabel}
        active={new Set(providers.filter((p) => p.active).map((p) => p.id))}
        nameOf={nameOf}
        choiceLabel={choiceLabel}
      />
    </div>
  );
}

/**
 * Por funcionalidade: o provedor e o modelo de cada uma (sem escolha, a da
 * empresa ou o padrão do servidor, com o modelo da variável da Vercel).
 */
function FeatureRoutes({
  routes,
  byId,
  companyLabel,
  companyProvider,
  serverLabel,
  choices,
  jevChoices,
  transcribeChoices,
  imageChoices,
  webChoices,
  routeLabel,
  embedding,
  onSet,
  efforts,
  onEffort,
}: {
  routes: AiRoute[];
  byId: ReadonlyMap<string, AiProvider>;
  /** A regra da empresa (nulo: não há). */
  companyLabel: string | null;
  companyProvider?: AiProvider;
  serverLabel: (feature?: AiFeature) => string;
  choices: ReactNode;
  /** Os modelos do Jev nos provedores OpenRouter (funcionalidades de decisão). */
  jevChoices: ReactNode;
  /** Os modelos de transcrição (OpenAI, Groq, Mistral, endereço próprio). */
  transcribeChoices: ReactNode;
  /** Os modelos de imagem (OpenAI, Google, xAI, OpenRouter, endereço próprio). */
  imageChoices: ReactNode;
  /** Os modelos da busca na internet (Claude e OpenRouter). */
  webChoices: ReactNode;
  routeLabel: (r: AiRoute) => string;
  /** O modelo de vetores do servidor (só para leitura). */
  embedding?: { model: string; env: string };
  onSet: (feature: AiFeature, choice: string) => void;
  efforts: Record<string, string>;
  onEffort: (key: string, effort: string | null) => void;
}) {
  return (
    <section className="panel ai-features" aria-label="Por funcionalidade">
      <header>
        <strong>Por funcionalidade</strong>
        <small>
          O provedor e o modelo de cada funcionalidade com a MAVI. Sem escolha,
          vale o padrão da empresa (ou o do servidor); a transcrição de áudio e
          as imagens não herdam o padrão da empresa, que é um modelo de
          conversa. Nas
          conversas (assistente e gravações), as regras de pessoa, cliente,
          produto e projeto vencem a da funcionalidade. O esforço diz quanto a
          IA raciocina antes de responder: mais esforço, respostas mais
          cuidadosas (artes, análises, skills), mais lentas e mais caras. Nos
          modelos fora da Claude, vai até Alto.
        </small>
      </header>
      <div className="drive-table-wrap">
        <table className="drive-table ai-usage-table ai-feature-table">
          <thead>
            <tr>
              <th>Funcionalidade</th>
              <th>Provedor e modelo</th>
              <th>Esforço</th>
            </tr>
          </thead>
          <tbody>
            {ORDERED.map((f, fi) => {
              const r = routes.find(
                (x) => x.type === "feature" && x.feature === f.id,
              );
              // Quem responde de fato: a escolha dela ou a da empresa.
              const provider = r
                ? byId.get(r.provider_id)
                : f.decisions || f.transcription || f.images || f.own
                  ? undefined
                  : companyProvider;
              // O módulo sem regra própria segue a regra da bolinha.
              const bubble =
                f.id === "mavi_page"
                  ? routes.find((x) => x.type === "feature" && x.feature === "assistant")
                  : undefined;
              const outsideClaude =
                provider && catalogEntry(provider.kind)?.api !== "anthropic";
              return (
                <Fragment key={f.id}>
                <tr>
                  <td>
                    <div className="ai-feature-name">
                      <span className="ai-feature-group">{f.group}</span>
                      <span className="ai-usage-name">{f.label}</span>
                      {(outsideClaude || f.transcription || f.images || f.own || f.web || f.id === "mavi_page" || f.id === "conversation_summary") &&
                        f.note && (
                        <small
                          className={`ai-feature-note${f.transcription || f.images || f.own || f.web || f.id === "mavi_page" || f.id === "conversation_summary" ? " info" : ""}`}
                        >
                          {f.note}
                        </small>
                      )}
                    </div>
                  </td>
                  <td>
                    <Select
                      aria-label={`Modelo de ${f.label}`}
                      value={r ? `${r.provider_id}|${r.model}` : SERVER}
                      onValueChange={(v) => onSet(f.id, v)}
                    >
                      <SelectOption value={SERVER}>
                        {f.decisions
                          ? "Automático · o Jev cadastrado num provedor OpenRouter"
                          : f.transcription || f.images
                            ? `${serverLabel(f.id)} (OpenAI)`
                            : f.id === "web_search"
                              ? "Sem modelo próprio · a MAVI do módulo busca (se for Claude)"
                              : f.id === "canvas_writer"
                                ? "Sem modelo próprio · a MAVI do módulo escreve"
                                : f.id === "mavi_rerank"
                                  ? "Sem reordenação · fica a ordem da busca"
                                : bubble
                                  ? `Segue a bolinha · ${routeLabel(bubble)}`
                                  : companyLabel
                              ? `Padrão da empresa · ${companyLabel}`
                              : serverLabel(f.id)}
                      </SelectOption>
                      {f.decisions
                        ? jevChoices
                        : f.transcription
                          ? transcribeChoices
                          : f.images
                            ? imageChoices
                            : f.web
                              ? webChoices
                              : choices}
                    </Select>
                  </td>
                  <td>
                    {EFFORT_FEATURES.has(f.id) ? (
                      <EffortSelect
                        label={f.label}
                        value={efforts[f.id]}
                        auto={
                          f.id === "mavi_page" && efforts.assistant
                            ? `Segue a bolinha · ${effortName(efforts.assistant)}`
                            : "Automático · padrão do modelo"
                        }
                        onChange={(e) => onEffort(f.id, e)}
                      />
                    ) : (
                      <span className="ai-feature-fixed">—</span>
                    )}
                  </td>
                </tr>
                {/* As partes da MAVI sem modelo, logo depois das dela. */}
                {fi === MAVI_ROWS - 1 && FIXED_ROWS.map(fixedRow)}
                </Fragment>
              );
            })}
            <tr>
              <td>
                <div className="ai-feature-name">
                  <span className="ai-feature-group">MAVI</span>
                  <span className="ai-usage-name">
                    Vetores da busca e do RAG
                  </span>
                  <small className="ai-feature-note info">
                    Leem reuniões, tarefas, Whatsapp e arquivos para a busca,
                    os Relacionados e o dossiê. Fixo: trocar o modelo exige
                    refazer o índice inteiro.
                  </small>
                </div>
              </td>
              <td>
                <span className="ai-feature-fixed">
                  Padrão do servidor · {embedding?.model ?? "text-embedding-3-small"}{" "}
                  (OpenAI)
                </span>
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function scopeOptions(
  tab: PersonScope,
  data: Snapshot,
  nameOf: (type: RouteScope, id: string) => string,
) {
  const ids =
    tab === "user"
      ? data.members.filter((m) => m.active).map((m) => m.user_id)
      : tab === "client"
        ? data.clients.filter((c) => !c.archived).map((c) => c.id)
        : tab === "contract"
          ? data.contracts.filter((k) => !k.archived).map((k) => k.id)
          : data.projects.filter((p) => !p.archived).map((p) => p.id);
  return ids
    .map((id) => ({ id, name: nameOf(tab, id) }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
}

function NewRoute({
  tab,
  data,
  taken,
  nameOf,
  choices,
  onSave,
}: {
  tab: PersonScope;
  data: Snapshot;
  taken: Set<string>;
  nameOf: (type: RouteScope, id: string) => string;
  choices: ReactNode;
  onSave: (id: string, choice: string) => void;
}) {
  const options = useMemo(
    () => scopeOptions(tab, data, nameOf).filter((o) => !taken.has(o.id)),
    [tab, data, nameOf, taken],
  );
  const [id, setId] = useState("");
  const [choice, setChoice] = useState("");
  return (
    <form
      className="ai-new-limit"
      onSubmit={(e) => {
        e.preventDefault();
        if (id && choice) {
          onSave(id, choice);
          setId("");
          setChoice("");
        }
      }}
    >
      <strong>Nova regra</strong>
      <Select
        aria-label="Para quem"
        value={id || "none"}
        onValueChange={(v) => setId(v === "none" ? "" : v)}
      >
        <SelectOption value="none">Escolha…</SelectOption>
        {options.map((o) => (
          <SelectOption key={o.id} value={o.id}>
            {o.name}
          </SelectOption>
        ))}
      </Select>
      <Select
        aria-label="Provedor e modelo"
        value={choice || "none"}
        onValueChange={(v) => setChoice(v === "none" ? "" : v)}
      >
        <SelectOption value="none">Provedor e modelo…</SelectOption>
        {choices}
      </Select>
      <Button className="btn primary" type="submit" disabled={!id || !choice}>
        Definir
      </Button>
    </form>
  );
}

/** "Quem responde?": a regra que vale para uma pessoa num lugar. */
function RouteSimulator({
  data,
  routes,
  serverLabel,
  active,
  nameOf,
  choiceLabel,
}: {
  data: Snapshot;
  routes: AiRoute[];
  serverLabel: (feature?: AiFeature) => string;
  active: ReadonlySet<string>;
  nameOf: (type: RouteScope, id: string | null) => string;
  choiceLabel: (r: AiRoute | null, feature?: AiFeature) => string;
}) {
  const [feature, setFeature] = useState<AiFeature>("assistant");
  const talk = featureInfo(feature)?.conversation ?? true;
  const [user, setUser] = useState("");
  const [client, setClient] = useState("");
  const [contract, setContract] = useState("");
  const [project, setProject] = useState("");
  const contracts = data.contracts.filter(
    (k) => !k.archived && k.client_id === client,
  );
  const projects = data.projects.filter(
    (p) => !p.archived && p.contract_id === contract,
  );
  const hit = pickRoute(
    routes,
    talk
      ? {
          feature,
          user: user || undefined,
          client: client || undefined,
          contract: contract || undefined,
          project: project || undefined,
        }
      : { feature },
    active,
  );
  const why = hit
    ? hit.type === "company"
      ? "pela regra da empresa"
      : hit.type === "feature"
        ? "pela regra da funcionalidade"
        : `pela regra de ${nameOf(hit.type, hit.scope_id)}`
    : "nenhuma regra vale";
  const none = (label: string) => <SelectOption value="none">{label}</SelectOption>;
  return (
    <section className="panel ai-simulator" aria-label="Quem responde">
      <strong>Quem responde?</strong>
      <div className="ai-simulator-fields">
        <Select
          aria-label="Funcionalidade"
          value={feature}
          onValueChange={(v) => setFeature(v as AiFeature)}
        >
          {FEATURES.map((f) => (
            <SelectOption key={f.id} value={f.id}>
              {`${f.group} · ${f.label}`}
            </SelectOption>
          ))}
        </Select>
        {talk && (
          <>
          <Select
            aria-label="Pessoa"
            value={user || "none"}
            onValueChange={(v) => setUser(v === "none" ? "" : v)}
          >
            {none("Qualquer pessoa")}
            {scopeOptions("user", data, nameOf).map((o) => (
              <SelectOption key={o.id} value={o.id}>
                {o.name}
              </SelectOption>
            ))}
          </Select>
          <Select
            aria-label="Cliente"
            value={client || "none"}
            onValueChange={(v) => {
              setClient(v === "none" ? "" : v);
              setContract("");
              setProject("");
            }}
          >
            {none("Sem cliente (assistente geral)")}
            {scopeOptions("client", data, nameOf).map((o) => (
              <SelectOption key={o.id} value={o.id}>
                {o.name}
              </SelectOption>
            ))}
          </Select>
          {client && contracts.length > 0 && (
            <Select
              aria-label="Produto"
              value={contract || "none"}
              onValueChange={(v) => {
                setContract(v === "none" ? "" : v);
                setProject("");
              }}
            >
              {none("Qualquer produto")}
              {contracts.map((k) => (
                <SelectOption key={k.id} value={k.id}>
                  {contractProductLabel(data, k.id)}
                </SelectOption>
              ))}
            </Select>
          )}
          {contract && projects.length > 0 && (
            <Select
              aria-label="Projeto"
              value={project || "none"}
              onValueChange={(v) => setProject(v === "none" ? "" : v)}
            >
              {none("Qualquer projeto")}
              {projects.map((p) => (
                <SelectOption key={p.id} value={p.id}>
                  {p.name}
                </SelectOption>
              ))}
            </Select>
          )}
          </>
        )}
      </div>
      <p className="ai-simulator-result" role="status">
        Responde <strong>{hit ? choiceLabel(hit) : serverLabel(feature)}</strong>,{" "}
        {why}.
      </p>
      {!talk ? (
        <small className="muted">
          Nesta funcionalidade, as regras de pessoa, cliente, produto e projeto
          não valem.
        </small>
      ) : (
        client && (
          <small className="muted">
            As regras do cliente valem só para quem tem acesso a ele.
          </small>
        )
      )}
    </section>
  );
}
