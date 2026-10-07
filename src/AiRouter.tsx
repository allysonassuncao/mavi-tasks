import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import { contractProductLabel } from "./domain";
import type { Snapshot } from "./types";
import type { AiLibrary } from "./ai";
import { featureInfo, isLinkTranscriber } from "./ai-providers";
import { FieldHistory } from "./AiSettingsLog";
import {
  LEVELS,
  SERVER_PROVIDER,
  SURFACES,
  TASK_TYPES,
  levelLabel,
  ms,
  pct,
  setRouteAuto,
  surfaceLabel,
  usd,
  type CostLevel,
  type RouteRecent,
  type RouteStats,
  type RouterApi,
  type RouterScope,
  type RouterScopeType,
  type RouterSettings,
} from "./ai-router";
import "./campaign-insights.css";
import "./ai-router.css";

/** As funcionalidades em que se conversa com a MAVI (onde o roteador escolhe). */
const ROUTED_FEATURES = [
  "assistant",
  "mavi_page",
  "meetings_history",
  "meetings_ask",
  "whatsapp_history",
  "task_search",
  "task_copilot",
  "dashboard_builder",
  "tutorial_search",
  "skill_coach",
  "personal_assistant",
];
const SCOPE_LABEL: Record<string, string> = {
  feature: "Funcionalidade",
  user: "Pessoa",
  client: "Cliente",
  contract: "Produto",
  project: "Projeto",
};
const DEFAULT = "default";

/**
 * Painel da MAVI › Roteamento: o roteador de modelos lê cada pedido (tipo,
 * complexidade, tamanho, ferramentas, anexos, tela) e escolhe o modelo pelo
 * nível de custo, com as travas de privacidade; refaz com um modelo mais
 * forte quando a resposta sai fraca; mostra o desempenho real por tipo de
 * pedido e modelo. No modo sombra, só registra o que escolheria.
 */
export function RouterPanel({
  api,
  company,
  data,
  library,
  reloadLibrary,
  notify,
}: {
  api: RouterApi;
  /** A empresa (nulo na demonstração: o Automático das regras fica só na tela). */
  company?: string;
  data: Snapshot;
  library: AiLibrary | null;
  reloadLibrary: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [s, setS] = useState<RouterSettings | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [cap, setCap] = useState("");
  const [editing, setEditing] = useState<RouterScope | "new" | null>(null);

  const load = useCallback(
    () =>
      api
        .get()
        .then((r) => {
          setS(r);
          setCap(String(r.escalate_cap));
          setError("");
        })
        .catch((e: Error) => setError(e.message)),
    [api],
  );
  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Parameters<RouterApi["save"]>[0], message = "Roteamento salvo.") => {
    setSaving(true);
    setError("");
    try {
      await api.save(patch);
      await load();
      notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const providers = useMemo(
    () => (library?.providers ?? []).filter((p) => !isLinkTranscriber(p.kind)),
    [library],
  );
  const providerName = useCallback(
    (id: string) => (id === SERVER_PROVIDER ? "Servidor (Claude da Vercel)" : (providers.find((p) => p.id === id)?.name ?? "Provedor removido")),
    [providers],
  );
  const nameOf = useCallback(
    (type: string, id: string | null) => {
      if (type === "user") return data.members.find((m) => m.user_id === id)?.name ?? "Pessoa removida";
      if (type === "client") return data.clients.find((c) => c.id === id)?.name ?? "Cliente removido";
      if (type === "contract") {
        const k = data.contracts.find((c) => c.id === id);
        const client = data.clients.find((c) => c.id === k?.client_id)?.name;
        return k ? `${contractProductLabel(data, id ?? "")} · ${client ?? "?"}` : "Produto removido";
      }
      if (type === "project") return data.projects.find((p) => p.id === id)?.name ?? "Projeto removido";
      return featureInfo(id ?? "")?.label ?? id ?? "";
    },
    [data],
  );

  if (!s)
    return error ? (
      <p className="form-error" role="alert">
        Não foi possível carregar o roteamento: {error}
      </p>
    ) : (
      <Loading variant="field" />
    );

  const allIds = [SERVER_PROVIDER, ...providers.map((p) => p.id)];
  return (
    <div className="thermo-settings cins-settings rtr" aria-busy={saving}>
      <section className="panel cins-block">
        <h3>Como a MAVI escolhe o modelo</h3>
        <p className="cins-help">
          Antes de cada resposta, a MAVI lê o pedido (tipo, complexidade, tamanho do contexto, ferramentas, anexos e a
          tela) e escolhe, entre os provedores permitidos, o modelo que atende pelo menor custo no nível escolhido. As
          regras de pessoa, cliente, produto, projeto, funcionalidade e skill em{" "}
          <a href="#regras">Quem usa qual modelo</a> travam o modelo, a não ser que estejam em Automático (abaixo); a
          da empresa é só o ponto de partida. As restrições de provedor valem sempre, até no modo sombra.
        </p>
        <p className="cins-help">
          Em toda pergunta, a MAVI leva só as ferramentas das conexões (MCP) e das contas de anúncio que combinam com o
          pedido ou que a conversa usou há pouco; as outras ela procura quando precisa. Imagens anexadas vão direto para
          o modelo quando ele enxerga (com o roteador ativo, ele escolhe um que enxergue).
        </p>
        <div className="cins-row">
          <label>
            <span>Modo</span>
            <div className="ai-log-field">
              <Select
                value={s.mode}
                disabled={saving}
                aria-label="Modo do roteador"
                onValueChange={(v) =>
                  void save({ mode: v as RouterSettings["mode"] }, v === "active" ? "Roteador ativo: a MAVI escolhe o modelo." : "Roteador em sombra.")
                }
              >
                <SelectOption value="shadow">Sombra · só registra o que escolheria</SelectOption>
                <SelectOption value="active">Ativo · a MAVI escolhe o modelo</SelectOption>
              </Select>
              <FieldHistory title="Modo do roteador" area="router" fields={["mode"]} />
            </div>
            <small>Comece em sombra e confira em Desempenho o que ele escolheria antes de ativar.</small>
          </label>
          <label>
            <span>Nível de custo da empresa</span>
            <div className="ai-log-field">
              <Select
                value={s.level}
                disabled={saving}
                aria-label="Nível de custo da empresa"
                onValueChange={(v) => void save({ level: v as CostLevel })}
              >
                {LEVELS.map((l) => (
                  <SelectOption key={l.id} value={l.id}>
                    {l.label}
                  </SelectOption>
                ))}
              </Select>
              <FieldHistory title="Nível de custo da empresa" area="router" fields={["level"]} />
            </div>
            <small>{LEVELS.find((l) => l.id === s.level)?.hint}</small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Nível por tela</h3>
        <p className="cins-help">
          Sem escolha, vale o da empresa. Exceções de produto, cliente e pessoa (abaixo) valem antes da tela.
        </p>
        <div className="rtr-surfaces">
          {SURFACES.map((x) => (
            <label key={x.id}>
              <span>{x.label}</span>
              <Select
                value={s.surface_levels[x.id] ?? DEFAULT}
                disabled={saving}
                aria-label={`Nível em ${x.label}`}
                onValueChange={(v) => {
                  const next = { ...s.surface_levels };
                  if (v === DEFAULT) delete next[x.id];
                  else next[x.id] = v as CostLevel;
                  void save({ surface_levels: next });
                }}
              >
                <SelectOption value={DEFAULT}>Da empresa ({levelLabel(s.level)})</SelectOption>
                {LEVELS.map((l) => (
                  <SelectOption key={l.id} value={l.id}>
                    {l.label}
                  </SelectOption>
                ))}
              </Select>
            </label>
          ))}
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Segunda tentativa</h3>
        <label className="cins-check">
          <Checkbox checked={s.escalate} disabled={saving} onCheckedChange={(v) => void save({ escalate: v === true })} />
          <span>
            <strong>Refazer com um modelo mais forte quando a resposta sair fraca</strong>
            <small>
              Vazia, ou quando a MAVI promete buscar e não entrega. Também troca de provedor quando o escolhido falha (fora
              do ar, limite de uso). Só no modo ativo, e nunca depois de imagens, cards, perguntas ou plano.
            </small>
          </span>
        </label>
        <div className="cins-row">
          <label>
            <span>Teto da segunda tentativa (US$)</span>
            <Input
              type="number"
              min={0}
              max={20}
              step="0.05"
              value={cap}
              disabled={saving || !s.escalate}
              onChange={(e) => setCap(e.target.value)}
              onBlur={() => {
                const v = Math.min(Math.max(Number(cap) || 0, 0), 20);
                if (v !== Number(s.escalate_cap)) void save({ escalate_cap: v });
                else setCap(String(s.escalate_cap));
              }}
            />
            <small>Pelo custo estimado da resposta no modelo mais forte.</small>
          </label>
        </div>
      </section>

      <section className="panel cins-block">
        <h3>Privacidade</h3>
        <ProviderPicker
          title="Provedores permitidos na empresa"
          help="A MAVI nunca usa um provedor fora da lista, nem quando uma regra o escolhe."
          value={s.providers}
          ids={allIds}
          name={providerName}
          allLabel="Todos os provedores"
          disabled={saving}
          onChange={(v) => void save({ providers: v })}
          history={<FieldHistory title="Provedores permitidos" area="router" fields={["providers"]} />}
        />
        <ProviderPicker
          title="Liberados para clientes e produtos sigilosos"
          help="Nas conversas de um cliente ou produto marcado como sigiloso (exceções abaixo), só estes. Os valores dos secretos das anotações nunca vão para modelo nenhum."
          value={s.secret_providers}
          ids={allIds}
          name={providerName}
          allLabel="Os mesmos permitidos na empresa"
          disabled={saving}
          onChange={(v) => void save({ secret_providers: v })}
          history={<FieldHistory title="Liberados para sigilosos" area="router" fields={["secret_providers"]} />}
        />
      </section>

      <section className="panel cins-block">
        <div className="rtr-head">
          <h3>Exceções por pessoa, cliente e produto</h3>
          <Button className="btn" type="button" onClick={() => setEditing("new")} disabled={saving}>
            <Plus size={14} /> Nova exceção
          </Button>
        </div>
        {s.scopes.length ? (
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile">
              <thead>
                <tr>
                  <th>Para</th>
                  <th>Nível</th>
                  <th>Provedores</th>
                  <th>Sigiloso</th>
                  <th aria-label="Ações" />
                </tr>
              </thead>
              <tbody>
                {s.scopes.map((x) => (
                  <tr key={`${x.type}|${x.scope_id}`}>
                    <td data-label="Para">
                      <span className="ai-usage-name">{nameOf(x.type, x.scope_id)}</span>
                      <small className="muted"> · {SCOPE_LABEL[x.type]}</small>
                    </td>
                    <td data-label="Nível">{x.level ? levelLabel(x.level) : "—"}</td>
                    <td data-label="Provedores">{x.providers ? x.providers.map(providerName).join(", ") : "Todos os permitidos"}</td>
                    <td data-label="Sigiloso">{x.sigiloso ? "Sim" : "—"}</td>
                    <td className="num ai-log-actions">
                      <FieldHistory
                        title={nameOf(x.type, x.scope_id)}
                        area={x.type}
                        subject={x.scope_id}
                        fields={["level", "providers", "sigiloso"]}
                      />
                      <button type="button" className="icon-btn" title="Editar" aria-label="Editar a exceção" onClick={() => setEditing(x)}>
                        <Pencil size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Tirar a exceção"
                        aria-label="Tirar a exceção"
                        onClick={() =>
                          void api
                            .saveScope(x.type, x.scope_id, null, null, false)
                            .then(load)
                            .then(() => notify("Exceção removida."))
                            .catch((e: Error) => setError(e.message))
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="cins-help">Nenhuma exceção: vale o nível da tela ou da empresa, e os provedores permitidos.</p>
        )}
      </section>

      <AutoRules company={company} library={library} nameOf={nameOf} reload={reloadLibrary} notify={notify} onError={setError} />

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <Performance api={api} data={data} />

      {editing && (
        <ScopeEditor
          data={data}
          scope={editing === "new" ? null : editing}
          taken={new Set(s.scopes.map((x) => `${x.type}|${x.scope_id}`))}
          ids={allIds}
          name={providerName}
          nameOf={nameOf}
          onClose={() => setEditing(null)}
          onSave={async (type, id, level, list, sigiloso) => {
            await api.saveScope(type, id, level, list, sigiloso);
            await load();
            notify("Exceção salva.");
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/** Uma lista de provedores (nula: todos), com "todos" à parte. */
function ProviderPicker({
  title,
  help,
  value,
  ids,
  name,
  allLabel,
  disabled,
  onChange,
  history,
}: {
  title: string;
  help: string;
  value: string[] | null;
  ids: string[];
  name: (id: string) => string;
  allLabel: string;
  disabled?: boolean;
  onChange: (v: string[] | null) => void;
  history?: ReactNode;
}) {
  const all = value === null;
  return (
    <fieldset className="rtr-providers" disabled={disabled}>
      <legend>
        {title} {history}
      </legend>
      <small className="muted">{help}</small>
      <label className="cins-check">
        <Checkbox checked={all} onCheckedChange={(v) => onChange(v === true ? null : ids)} />
        <span>
          <strong>{allLabel}</strong>
        </span>
      </label>
      {!all && (
        <div className="rtr-provider-list">
          {ids.map((id) => (
            <label key={id} className="cins-check">
              <Checkbox
                checked={value.includes(id)}
                onCheckedChange={(v) => {
                  const next = v === true ? [...value, id] : value.filter((x) => x !== id);
                  if (next.length) onChange(next);
                }}
              />
              <span>{name(id)}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Nova exceção ou edição: para quem, nível, provedores e sigiloso. */
function ScopeEditor({
  data,
  scope,
  taken,
  ids,
  name,
  nameOf,
  onClose,
  onSave,
}: {
  data: Snapshot;
  scope: RouterScope | null;
  taken: Set<string>;
  ids: string[];
  name: (id: string) => string;
  nameOf: (type: string, id: string) => string;
  onClose: () => void;
  onSave: (type: RouterScopeType, id: string, level: CostLevel | null, providers: string[] | null, sigiloso: boolean) => Promise<void>;
}) {
  const [type, setType] = useState<RouterScopeType>(scope?.type ?? "client");
  const [id, setId] = useState(scope?.scope_id ?? "");
  const [level, setLevel] = useState<CostLevel | null>(scope?.level ?? null);
  const [providers, setProviders] = useState<string[] | null>(scope?.providers ?? null);
  const [sigiloso, setSigiloso] = useState(scope?.sigiloso ?? false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const options = useMemo(() => {
    const list =
      type === "user"
        ? data.members.filter((m) => m.active).map((m) => m.user_id)
        : type === "client"
          ? data.clients.filter((c) => !c.archived).map((c) => c.id)
          : data.contracts.filter((k) => !k.archived).map((k) => k.id);
    return list
      .filter((x) => !taken.has(`${type}|${x}`) || x === scope?.scope_id)
      .map((x) => ({ id: x, name: nameOf(type, x) }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
  }, [type, data, taken, nameOf, scope]);
  return (
    <Modal
      title={scope ? `Exceção · ${nameOf(scope.type, scope.scope_id)}` : "Nova exceção"}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="entity-form rtr-editor"
        onSubmit={(e) => {
          e.preventDefault();
          if (!id) return;
          setBusy(true);
          setProblem("");
          onSave(type, id, level, providers, type !== "user" && sigiloso)
            .catch((err: Error) => setProblem(err.message))
            .finally(() => setBusy(false));
        }}
      >
        {!scope && (
          <div className="cins-row">
            <label>
              <span>Tipo</span>
              <Select
                value={type}
                aria-label="Tipo da exceção"
                onValueChange={(v) => {
                  setType(v as RouterScopeType);
                  setId("");
                  if (v === "user") setSigiloso(false);
                }}
              >
                <SelectOption value="client">Cliente</SelectOption>
                <SelectOption value="contract">Produto</SelectOption>
                <SelectOption value="user">Pessoa</SelectOption>
              </Select>
            </label>
            <label>
              <span>Para</span>
              <Select value={id || "none"} aria-label="Para quem" onValueChange={(v) => setId(v === "none" ? "" : v)}>
                <SelectOption value="none">Escolha…</SelectOption>
                {options.map((o) => (
                  <SelectOption key={o.id} value={o.id}>
                    {o.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
          </div>
        )}
        <div className="cins-row">
          <label>
            <span>Nível de custo</span>
            <Select value={level ?? DEFAULT} aria-label="Nível de custo da exceção" onValueChange={(v) => setLevel(v === DEFAULT ? null : (v as CostLevel))}>
              <SelectOption value={DEFAULT}>O da tela ou da empresa</SelectOption>
              {LEVELS.map((l) => (
                <SelectOption key={l.id} value={l.id}>
                  {l.label}
                </SelectOption>
              ))}
            </Select>
          </label>
        </div>
        <ProviderPicker
          title="Provedores permitidos"
          help="Vale junto com a lista da empresa (só os que estão nas duas)."
          value={providers}
          ids={ids}
          name={name}
          allLabel="Todos os permitidos na empresa"
          onChange={setProviders}
        />
        {type !== "user" && (
          <label className="cins-check">
            <Checkbox checked={sigiloso} onCheckedChange={(v) => setSigiloso(v === true)} />
            <span>
              <strong>Sigiloso</strong>
              <small>Nas conversas deste {type === "client" ? "cliente" : "produto"}, só os provedores liberados para sigilosos.</small>
            </span>
          </label>
        )}
        {problem && (
          <p className="form-error" role="alert">
            {problem}
          </p>
        )}
        <div className="rtr-editor-actions">
          <Button className="btn" type="button" onClick={onClose}>
            Cancelar
          </Button>
          <Button className="btn primary" type="submit" disabled={!id || busy}>
            Salvar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** As regras de Quem usa qual modelo que valem nas conversas, com o Automático. */
function AutoRules({
  company,
  library,
  nameOf,
  reload,
  notify,
  onError,
}: {
  company?: string;
  library: AiLibrary | null;
  nameOf: (type: string, id: string | null) => string;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [demoAuto, setDemoAuto] = useState<Record<string, boolean>>({});
  const rules = (library?.routes ?? []).filter(
    (r) => (r.type === "feature" && ROUTED_FEATURES.includes(r.feature ?? "")) || ["user", "client", "contract", "project"].includes(r.type),
  );
  const byId = new Map((library?.providers ?? []).map((p) => [p.id, p]));
  const key = (r: (typeof rules)[number]) => `${r.type}|${r.scope_id ?? r.feature}`;
  return (
    <section className="panel cins-block">
      <h3>Regras que travam o modelo</h3>
      <p className="cins-help">
        Com o roteador ativo, a regra escolhe o modelo e o roteador não troca. Em Automático, o roteador escolhe pelo
        pedido e o modelo da regra vale no modo sombra.
      </p>
      {rules.length ? (
        <div className="drive-table-wrap">
          <table className="drive-table ai-usage-table stack-mobile">
            <thead>
              <tr>
                <th>Regra</th>
                <th>Modelo</th>
                <th>Automático</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const label = r.type === "feature" ? nameOf("feature", r.feature ?? "") : nameOf(r.type, r.scope_id);
                const p = byId.get(r.provider_id);
                const on = company ? !!r.auto : (demoAuto[key(r)] ?? !!r.auto);
                return (
                  <tr key={r.id}>
                    <td data-label="Regra">
                      <span className="ai-usage-name">{label}</span>
                      <small className="muted"> · {SCOPE_LABEL[r.type]}</small>
                    </td>
                    <td data-label="Modelo">
                      {p?.name ?? "?"} · {p?.models.find((m) => m.id === r.model)?.label || r.model}
                    </td>
                    <td data-label="Automático">
                      <span className="ai-log-field">
                        <Checkbox
                          checked={on}
                          aria-label={`Automático em ${label}`}
                          onCheckedChange={(v) => {
                            if (!company) return setDemoAuto((d) => ({ ...d, [key(r)]: v === true }));
                            void setRouteAuto(company, r.type, r.type === "feature" ? null : r.scope_id, r.type === "feature" ? (r.feature ?? null) : null, v === true)
                              .then(reload)
                              .then(() => notify(v === true ? "Regra em Automático." : "Regra trava o modelo."))
                              .catch((e: Error) => onError(e.message));
                          }}
                        />
                        <FieldHistory title={label} area={r.type} subject={r.type === "feature" ? (r.feature ?? "") : (r.scope_id ?? "")} fields={["auto"]} />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="cins-help">Nenhuma regra de conversa: o roteador escolhe sempre (no modo ativo).</p>
      )}
    </section>
  );
}

/** O desempenho real: o que respondeu, o que o roteador escolheria e as últimas decisões. */
function Performance({ api, data }: { api: RouterApi; data: Snapshot }) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<RouteStats | null>(null);
  const [recent, setRecent] = useState<RouteRecent[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    setLoading(true);
    return Promise.all([api.stats(days), api.recent(30)])
      .then(([st, rc]) => {
        setStats(st);
        setRecent(rc);
        setError("");
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [api, days]);
  useEffect(() => {
    void load();
  }, [load]);
  const person = (id: string | null) => data.members.find((m) => m.user_id === id)?.name ?? "—";
  const rows = (stats?.by_type_model ?? []).filter((r) => !!r.model && Number(r.n) > 0);
  const sh = stats?.shadow;
  return (
    <section className="panel cins-block rtr-perf" aria-busy={loading}>
      <div className="rtr-head">
        <h3>Desempenho</h3>
        <div className="rtr-head-actions">
          <Select value={String(days)} aria-label="Período" onValueChange={(v) => setDays(Number(v))}>
            <SelectOption value="7">Últimos 7 dias</SelectOption>
            <SelectOption value="30">Últimos 30 dias</SelectOption>
            <SelectOption value="90">Últimos 90 dias</SelectOption>
          </Select>
          <button type="button" className="icon-btn" title="Atualizar" aria-label="Atualizar o desempenho" onClick={() => void load()}>
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {stats && (
        <>
          <div className="rtr-kpis">
            <div>
              <strong>{stats.total.toLocaleString("pt-BR")}</strong>
              <small>respostas acompanhadas</small>
            </div>
            <div>
              <strong>{sh ? (sh.differ + sh.agree ? pct(sh.differ / (sh.differ + sh.agree)) : "—") : "—"}</strong>
              <small>em que o roteador escolheria outro modelo</small>
            </div>
            <div>
              <strong>{sh?.est_ratio !== null && sh?.est_ratio !== undefined ? pct(1 - Number(sh.est_ratio)) : "—"}</strong>
              <small>de economia estimada com a escolha dele</small>
            </div>
            <div>
              <strong>{sh?.locked ?? 0}</strong>
              <small>travadas por regra</small>
            </div>
          </div>
          <p className="cins-help">
            Qualidade é a fração de respostas sem sinal ruim: 👎, autoavaliação reprovada, ferramenta com erro, limite de
            passos ou falha. A economia compara o custo estimado do modelo sugerido com o do que respondeu.
          </p>
          {rows.length ? (
            <div className="drive-table-wrap">
              <table className="drive-table ai-usage-table stack-mobile">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Modelo</th>
                    <th className="num">Respostas</th>
                    <th className="num">Qualidade</th>
                    <th className="num">👍 / 👎</th>
                    <th className="num">1ª palavra</th>
                    <th className="num">Total (p50 · p95)</th>
                    <th className="num">Custo médio</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.task_type}|${r.model}`}>
                      <td data-label="Pedido">{TASK_TYPES[r.task_type] ?? r.task_type}</td>
                      <td data-label="Modelo" className="rtr-model">{r.model}</td>
                      <td data-label="Respostas" className="num">{r.n}</td>
                      <td data-label="Qualidade" className="num">{pct(r.quality)}</td>
                      <td data-label="👍 / 👎" className="num">
                        {r.up} / {r.down}
                      </td>
                      <td data-label="1ª palavra" className="num">{ms(r.first_token_ms_p50)}</td>
                      <td data-label="Total" className="num">
                        {ms(r.total_ms_p50)} · {ms(r.total_ms_p95)}
                      </td>
                      <td data-label="Custo médio" className="num">{usd(r.cost_avg)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="cins-help">Ainda sem respostas acompanhadas neste período.</p>
          )}
          {!!sh?.by_suggestion.length && (
            <>
              <h4 className="rtr-sub">Onde o roteador escolheria diferente</h4>
              <div className="drive-table-wrap">
                <table className="drive-table ai-usage-table stack-mobile">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th className="num">Complexidade</th>
                      <th>Respondeu</th>
                      <th>Escolheria</th>
                      <th className="num">Vezes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sh.by_suggestion.map((x) => (
                      <tr key={`${x.task_type}|${x.complexity}|${x.used_model}|${x.suggested_model}`}>
                        <td data-label="Pedido">{TASK_TYPES[x.task_type] ?? x.task_type}</td>
                        <td data-label="Complexidade" className="num">{x.complexity}</td>
                        <td data-label="Respondeu" className="rtr-model">{x.used_model}</td>
                        <td data-label="Escolheria" className="rtr-model">{x.suggested_model ?? "—"}</td>
                        <td data-label="Vezes" className="num">{x.n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
      {!!recent?.length && (
        <>
          <h4 className="rtr-sub">Últimas decisões</h4>
          <div className="drive-table-wrap">
            <table className="drive-table ai-usage-table stack-mobile rtr-recent">
              <thead>
                <tr>
                  <th>Quando</th>
                  <th>Quem · tela</th>
                  <th>Pedido</th>
                  <th>Respondeu</th>
                  <th>Por quê</th>
                  <th className="num">Espera</th>
                  <th className="num">Custo</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Quando">{new Date(r.at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td data-label="Quem · tela">
                      {person(r.user_id)} · {surfaceLabel(r.surface)}
                    </td>
                    <td data-label="Pedido">
                      {TASK_TYPES[r.task_type] ?? r.task_type} · {r.complexity}
                    </td>
                    <td data-label="Respondeu">
                      {r.used_model}
                      {r.mode === "auto" ? " · escolhido" : r.mode === "locked" ? " · regra" : ""}
                      {r.escalated && " · 2ª tentativa"}
                      {r.mode !== "auto" && r.suggested_model && r.suggested_model !== r.used_model && (
                        <small className="muted"> (escolheria {r.suggested_model})</small>
                      )}
                    </td>
                    <td data-label="Por quê" className="rtr-reason">
                      {r.error ? `${r.reason} · ${r.error}` : r.reason}
                    </td>
                    <td data-label="Espera" className="num">{ms(r.total_ms)}</td>
                    <td data-label="Custo" className="num">{usd(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

