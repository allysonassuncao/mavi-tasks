import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  BotMessageSquare,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  EyeOff,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { contractProductLabel } from "./domain";
import type { Snapshot } from "./types";
import {
  AgentServerError,
  ROLE_LABEL,
  SOURCE_LABEL,
  agentInstances,
  agentPrompt,
  agentPromptVersion,
  agentPromptVersions,
  agentStatus,
  deleteAgentInstance,
  ignoreAgentWorkflow,
  linkAgentWorkflow,
  listAgents,
  publishAgentPrompt,
  refreshAgentWorkflow,
  saveAgentInstance,
  syncAgents,
  testAgentInstance,
  useLiveAgents,
  type AgentInstance,
  type AgentPrompt,
  type AgentPromptSummary,
  type AgentPromptVersion,
  type AgentStatus,
  type AgentWorkflow,
} from "./agents";
import { diffLines, diffStats, type DiffLine } from "./text-diff";
import { applySuggestion } from "./agent-check";
import "./agents.css";

const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Sao_Paulo",
      })
    : "—";
const count = (n: number | undefined, one: string, many: string) =>
  `${n ?? 0} ${(n ?? 0) === 1 ? one : many}`;
const chars = (n: number) => `${n.toLocaleString("pt-BR")} caracteres`;
const errorOf = (e: unknown) => (e as Error)?.message ?? "Algo deu errado.";

/** Papel e estado do fluxo, em selos. */
function WorkflowBadges({ w }: { w: AgentWorkflow }) {
  return (
    <span className="agent-badges">
      <span className={`agent-role agent-role-${w.role}`}>{ROLE_LABEL[w.role]}</span>
      <span className={`agent-state ${w.active ? "on" : ""}`}>
        {w.archived ? "Arquivado" : w.active ? "Ativo" : "Parado"}
      </span>
    </span>
  );
}

/** A ficha do nó: modelo, ferramentas e memória. */
function SetupLine({ p }: { p: AgentPromptSummary | AgentPrompt }) {
  const s = p.setup ?? {};
  const parts = [
    s.model ? `Modelo ${s.model}` : s.provider ? `Modelo ${s.provider}` : "",
    s.tools?.length ? `${s.tools.length} ${s.tools.length === 1 ? "ferramenta" : "ferramentas"}` : "",
    s.memory ? "com memória" : "",
    s.disabled ? "nó desativado" : "",
  ].filter(Boolean);
  return parts.length ? <span className="muted">{parts.join(" · ")}</span> : null;
}

// ------------------------------------------------------------ lista
/**
 * Os fluxos com AI Agent que a pessoa vê, por cliente: principais e
 * subfluxos à vista, as cópias (backups) recolhidas. Clicar num nó abre o
 * prompt. `contract`: só os do produto (a pasta do Drive).
 */
export function AgentList({
  company,
  client,
  contract,
  query = "",
  data,
  canLink = false,
  leader = false,
  user = "",
  onOpen,
  emptyHint,
}: {
  company: string;
  client?: string | null;
  contract?: string | null;
  query?: string;
  data?: Snapshot;
  /** Trocar cliente (líderes e quem eles liberaram). */
  canLink?: boolean;
  leader?: boolean;
  user?: string;
  onOpen: (prompt: string) => void;
  emptyHint?: string;
}) {
  const [list, setList] = useState<AgentWorkflow[] | null>(null);
  const [error, setError] = useState("");
  const [openCopies, setOpenCopies] = useState<Set<string>>(new Set());
  const [linking, setLinking] = useState<string | null>(null);
  const load = useCallback(() => {
    listAgents(company, { client, contract, query })
      .then((l) => {
        setList(l);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, client, contract, query]);
  useEffect(load, [load]);
  useLiveAgents({ client, contract }, load);

  const groups = useMemo(() => {
    const by = new Map<string, { name: string; flows: AgentWorkflow[] }>();
    for (const w of list ?? []) {
      const key = w.client_id ?? "";
      const g = by.get(key) ?? { name: w.client_name ?? "Sem cliente", flows: [] };
      g.flows.push(w);
      by.set(key, g);
    }
    return [...by.entries()];
  }, [list]);

  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!list) return <Loading variant="table" />;
  if (!list.length)
    return (
      <div className="agent-empty">
        <BotMessageSquare size={22} aria-hidden="true" />
        <strong>{query ? "Nada encontrado" : "Nenhum agente por aqui"}</strong>
        <span>
          {query
            ? "Nenhum fluxo, nó ou prompt tem esse texto."
            : (emptyHint ??
              "Os fluxos do n8n com nó AI Agent aparecem aqui quando são ligados a um cliente que você atende.")}
        </span>
      </div>
    );

  const flow = (w: AgentWorkflow) => (
    <article key={w.id} className={`agent-flow ${w.role}`}>
      <header className="agent-flow-head">
        <div className="agent-flow-title">
          <strong>{w.name || "(fluxo sem nome)"}</strong>
          <WorkflowBadges w={w} />
        </div>
        <div className="agent-flow-actions">
          {canLink && data && (
            <button
              type="button"
              className="agent-link-btn"
              onClick={() => setLinking(linking === w.id ? null : w.id)}
            >
              <Link2 size={14} aria-hidden="true" /> Trocar cliente
            </button>
          )}
          <a className="agent-link-btn" href={w.n8n_url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" /> Abrir no n8n
          </a>
        </div>
      </header>
      <p className="agent-flow-meta muted">
        {w.instance_name}
        {w.product_name && !contract ? ` · ${w.product_name}` : ""}
        {w.n8n_updated_at ? ` · salvo no n8n em ${when(w.n8n_updated_at)}` : ""}
        {w.role === "subflow" && w.called_by.length
          ? ` · chamado por ${w.called_by.map((c) => `"${c.name}"`).join(", ")}`
          : ""}
        {w.link_source === "auto" ? " · ligado ao cliente pelo nome" : ""}
      </p>
      {linking === w.id && data && (
        <LinkEditor
          data={data}
          leader={leader}
          user={user}
          workflow={w}
          onDone={() => {
            setLinking(null);
            load();
          }}
        />
      )}
      <ul className="agent-nodes">
        {w.prompts.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={`agent-node ${p.removed ? "removed" : ""}`}
              onClick={() => onOpen(p.id)}
            >
              <span className="agent-node-head">
                <strong>{p.node_name}</strong>
                <span className="muted">
                  {p.removed
                    ? "saiu do fluxo"
                    : p.chars
                      ? chars(p.chars)
                      : "sem prompt de sistema"}{" "}
                  · v{p.version} · {when(p.changed_at)}
                  {p.changed_by_name ? ` por ${p.changed_by_name}` : ""}
                </span>
              </span>
              <SetupLine p={p} />
              {p.excerpt && <span className="agent-node-excerpt">{p.excerpt}</span>}
              <ChevronRight size={16} className="agent-node-go" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </article>
  );

  return (
    <div className="agent-groups">
      {groups.map(([key, g]) => {
        const live = g.flows.filter((w) => w.role !== "copy");
        const copies = g.flows.filter((w) => w.role === "copy");
        const open = openCopies.has(key) || !!query;
        return (
          <section key={key} className="agent-group">
            {!contract && <h3 className="agent-group-title">{g.name}</h3>}
            {live.map(flow)}
            {!live.length && (
              <p className="muted agent-group-none">
                Nenhum fluxo ativo ou subfluxo: só cópias.
              </p>
            )}
            {copies.length > 0 && (
              <>
                <button
                  type="button"
                  className="agent-copies-toggle"
                  aria-expanded={open}
                  onClick={() =>
                    setOpenCopies((s) => {
                      const n = new Set(s);
                      if (n.has(key)) n.delete(key);
                      else n.add(key);
                      return n;
                    })
                  }
                >
                  {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  Cópias e backups ({copies.length})
                  <span className="muted">
                    — parados e sem nenhum fluxo ativo chamando; ficam fora da MAVI
                  </span>
                </button>
                {open && copies.map(flow)}
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ ligar ao cliente
/** Escolhe o cliente e o produto do fluxo (líderes). */
function LinkEditor({
  data,
  leader,
  user,
  workflow,
  onDone,
}: {
  data: Snapshot;
  /** Fora os líderes, só os clientes que a pessoa atende (a regra do Drive). */
  leader: boolean;
  user: string;
  workflow: AgentWorkflow;
  onDone: () => void;
}) {
  const [client, setClient] = useState(workflow.client_id ?? "");
  const contracts = useMemo(
    () => data.contracts.filter((k) => k.client_id === client && !k.archived),
    [data, client],
  );
  const suggested = (list: typeof contracts) =>
    list.find((k) => /^\s*mavi\s*$/i.test(data.products.find((p) => p.id === k.product_id)?.name ?? ""))?.id ??
    (list.length === 1 ? list[0].id : "");
  const [contract, setContract] = useState(workflow.contract_id ?? suggested(contracts));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const clients = useMemo(() => {
    const teams = new Set(data.teamMembers.filter((t) => t.user_id === user).map((t) => t.team_id));
    const mine = new Set(data.clientTeams.filter((ct) => teams.has(ct.team_id)).map((ct) => ct.client_id));
    return data.clients
      .filter((c) => !c.archived && (leader || mine.has(c.id)))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }, [data, leader, user]);
  const save = (c: string | null, k: string | null) => {
    setBusy(true);
    setError("");
    linkAgentWorkflow(workflow.id, c, k, data.clients.find((x) => x.id === c)?.name ?? null)
      .then(onDone)
      .catch((e) => setError(errorOf(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="agent-link-editor">
      <label>
        <span>Cliente</span>
        <Select
          value={client}
          onValueChange={(v) => {
            setClient(v);
            setContract(suggested(data.contracts.filter((k) => k.client_id === v && !k.archived)));
          }}
          aria-label="Cliente do fluxo"
        >
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
        <Select value={contract} onValueChange={setContract} disabled={!client} aria-label="Produto do fluxo">
          <SelectOption value="">Sem produto (só líderes editam)</SelectOption>
          {contracts.map((k) => (
            <SelectOption key={k.id} value={k.id}>
              {contractProductLabel(data, k.id)}
            </SelectOption>
          ))}
        </Select>
      </label>
      <div className="agent-link-editor-actions">
        <Button className="btn primary" disabled={!client} loading={busy} onClick={() => save(client, contract || null)}>
          Ligar
        </Button>
        {workflow.client_id && (
          <Button className="btn secondary" disabled={busy} onClick={() => save(null, null)}>
            Desligar do cliente
          </Button>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

// ------------------------------------------------------------ diferença
/** As linhas que mudaram, com 3 linhas iguais em volta; o resto recolhido. */
export function DiffView({ lines }: { lines: DiffLine[] }) {
  const [shown, setShown] = useState<Set<number>>(new Set());
  const near = useMemo(() => {
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (l.kind === "same") return;
      for (let k = Math.max(0, i - 3); k <= Math.min(lines.length - 1, i + 3); k++) keep.add(k);
    });
    return keep;
  }, [lines]);
  const out: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    if (lines[i].kind === "same" && !near.has(i) && !shown.has(i)) {
      let j = i;
      while (j < lines.length && lines[j].kind === "same" && !near.has(j) && !shown.has(j)) j++;
      const from = i,
        to = j;
      out.push(
        <button
          key={`gap-${i}`}
          type="button"
          className="agent-diff-gap"
          onClick={() =>
            setShown((s) => {
              const n = new Set(s);
              for (let k = from; k < to; k++) n.add(k);
              return n;
            })
          }
        >
          … {to - from} {to - from === 1 ? "linha igual" : "linhas iguais"} (mostrar)
        </button>,
      );
      i = j;
      continue;
    }
    const l = lines[i];
    out.push(
      <div key={i} className={`agent-diff-line ${l.kind}`}>
        <span className="agent-diff-sign" aria-hidden="true">
          {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
        </span>
        <span className="agent-diff-text">
          {l.words
            ? l.words
                .filter((w) => w.kind === "same" || w.kind === l.kind)
                .map((w, k) =>
                  w.kind === "same" ? (
                    <span key={k}>{w.text}</span>
                  ) : (
                    <mark key={k}>{w.text}</mark>
                  ),
                )
            : l.text || " "}
        </span>
      </div>,
    );
    i++;
  }
  return <div className="agent-diff">{out}</div>;
}

// ------------------------------------------------------------ o prompt
type Mode = "view" | "edit" | "review";

/** Um ajuste sugerido pelo Radar (migration 20270512090000). */
export type PromptSuggestion = { before: string; after: string; why?: string };

/**
 * Um prompt: a ficha do nó, o texto, as versões e (quem edita) editar,
 * revisar a diferença e publicar no n8n. Com `suggestion` (o ajuste que o
 * Radar propôs), quem edita aplica e cai direto na revisão.
 */
export function AgentPromptSheet({
  promptId,
  onClose,
  notify,
  suggestion,
}: {
  promptId: string;
  onClose: () => void;
  notify: (message: string) => void;
  suggestion?: PromptSuggestion;
}) {
  const [prompt, setPrompt] = useState<AgentPrompt | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"prompt" | "versions">("prompt");
  const [mode, setMode] = useState<Mode>("view");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [warning, setWarning] = useState("");

  const load = useCallback(
    () =>
      agentPrompt(promptId)
        .then((p) => {
          setPrompt(p);
          setError("");
          return p;
        })
        .catch((e) => {
          setError(errorOf(e));
          return null;
        }),
    [promptId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  // Mudou em outra tela (ou no n8n, na leitura de 1h): relê se não está editando.
  useLiveAgents({}, () => {
    if (mode === "view") void load();
  });

  const editing = mode !== "view";
  const dirty = !!prompt && editing && draft !== prompt.prompt;
  const close = () => {
    if (dirty && !window.confirm("Descartar a edição deste prompt?")) return;
    onClose();
  };
  const refresh = () => {
    if (!prompt) return;
    setRefreshing(true);
    refreshAgentWorkflow(prompt.workflow_id)
      .then((r) => {
        notify(r.changed ? "Fluxo relido: havia mudanças no n8n." : "Fluxo relido: nada mudou no n8n.");
        return load();
      })
      .catch((e) => setError(errorOf(e)))
      .finally(() => setRefreshing(false));
  };
  const publish = () => {
    if (!prompt) return;
    setBusy(true);
    setWarning("");
    publishAgentPrompt({ prompt: prompt.id, base: prompt.version, text: draft, note })
      .then((r) => {
        notify(
          r.active
            ? `Publicado no n8n (versão ${r.version}): já vale nas conversas do cliente.`
            : `Publicado no n8n (versão ${r.version}).`,
        );
        setMode("view");
        setNote("");
        return load();
      })
      .catch(async (e) => {
        if (e instanceof AgentServerError && e.conflict) {
          // O texto da pessoa continua; a comparação passa a ser com o novo.
          await load();
          setWarning(
            `${e.message} A comparação abaixo já é com a versão mais nova; seu texto continua aqui.`,
          );
          setMode("review");
        } else setError(errorOf(e));
      })
      .finally(() => setBusy(false));
  };

  const w = prompt?.workflow;
  const diff = useMemo(
    () => (prompt && mode === "review" ? diffLines(prompt.prompt, draft) : []),
    [prompt, draft, mode],
  );
  const stats = diffStats(diff);

  return (
    <Modal
      title={prompt ? `${prompt.node_name}` : "Prompt"}
      onClose={close}
      wide
      busy={busy}
      className="agent-sheet"
      actions={
        prompt && (
          <div className="agent-sheet-actions">
            <Button className="btn secondary" onClick={refresh} loading={refreshing} disabled={editing}>
              <RefreshCw size={14} aria-hidden="true" /> Atualizar
            </Button>
            <a className="btn secondary" href={w?.n8n_url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} aria-hidden="true" /> n8n
            </a>
          </div>
        )
      }
    >
      <div className="agent-sheet-body">
        {error && <p className="form-error" role="alert">{error}</p>}
        {!prompt && !error && <Loading variant="page" />}
        {prompt && w && (
          <>
            <div className="agent-sheet-where">
              <span className="muted">
                {w.client_name ?? "Sem cliente"}
                {w.product_name ? ` · ${w.product_name}` : ""} · {w.instance_name}
              </span>
              <strong>{w.name}</strong>
              <WorkflowBadges w={w} />
            </div>
            <dl className="agent-setup">
              <div>
                <dt>Modelo</dt>
                <dd>
                  {prompt.setup.model ?? "—"}
                  {prompt.setup.provider ? <span className="muted"> · {prompt.setup.provider}</span> : null}
                </dd>
              </div>
              <div>
                <dt>Ferramentas</dt>
                <dd>{prompt.setup.tools?.length ? prompt.setup.tools.join(", ") : "—"}</dd>
              </div>
              <div>
                <dt>Memória</dt>
                <dd>{prompt.setup.memory ?? "—"}</dd>
              </div>
              <div>
                <dt>Versão</dt>
                <dd>
                  v{prompt.version} · {when(prompt.changed_at)}
                  {prompt.changed_by_name ? ` por ${prompt.changed_by_name}` : ""}
                </dd>
              </div>
            </dl>
            {prompt.removed && (
              <p className="agent-warning">
                <TriangleAlert size={15} aria-hidden="true" /> Este nó saiu do fluxo no n8n: só o histórico fica aqui.
              </p>
            )}
            {prompt.expression && (
              <p className="agent-note muted">
                Este prompt é uma expressão do n8n: os trechos entre {"{{ }}"} são preenchidos na hora pelo n8n
                (data, nome do contato…). Publicar mantém isso.
              </p>
            )}

            <div className="drive-view agent-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "prompt"}
                className={tab === "prompt" ? "selected" : ""}
                onClick={() => setTab("prompt")}
              >
                Prompt
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "versions"}
                className={tab === "versions" ? "selected" : ""}
                onClick={() => setTab("versions")}
                disabled={editing}
              >
                Versões
              </button>
            </div>

            {tab === "versions" ? (
              <VersionList
                prompt={prompt}
                notify={notify}
                onPublished={() => {
                  setTab("prompt");
                  void load();
                }}
              />
            ) : mode === "view" ? (
              <>
                {suggestion && (
                  <div className="agent-suggestion">
                    <strong>Ajuste sugerido pelo Radar</strong>
                    {suggestion.why && <p className="muted">{suggestion.why}</p>}
                    {suggestion.before && (
                      <p>
                        <span className="muted">Trocar: </span>
                        <q>{suggestion.before}</q>
                      </p>
                    )}
                    <p>
                      <span className="muted">{suggestion.before ? "Por: " : "Acrescentar: "}</span>
                      <q>{suggestion.after}</q>
                    </p>
                    {w.can_edit && !prompt.removed ? (
                      <Button
                        className="btn primary compact"
                        onClick={() => {
                          const next = applySuggestion(prompt.prompt, suggestion);
                          setNote(suggestion.why ? `Radar: ${suggestion.why}`.slice(0, 500) : "Ajuste sugerido pelo Radar");
                          if (next === null) {
                            // O texto mudou depois da conferência: a pessoa ajusta à mão.
                            setDraft(prompt.prompt);
                            setWarning("O trecho sugerido não está mais no prompt: ajuste à mão com o texto acima.");
                            setMode("edit");
                          } else {
                            setDraft(next);
                            setWarning("");
                            setMode("review");
                          }
                        }}
                      >
                        <Check size={14} aria-hidden="true" /> Aplicar e revisar
                      </Button>
                    ) : (
                      <p className="muted">Só quem edita este produto no Drive publica o ajuste.</p>
                    )}
                  </div>
                )}
                <div className="agent-text-toolbar">
                  <span className="muted">{chars(prompt.prompt.length)}</span>
                  <Button
                    className="btn secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(prompt.prompt)
                        .then(() => notify("Prompt copiado."))
                        .catch(() => notify("Não deu para copiar."))
                    }
                  >
                    <Copy size={14} aria-hidden="true" /> Copiar
                  </Button>
                  {w.can_edit && !prompt.removed && (
                    <Button
                      className="btn primary"
                      onClick={() => {
                        setDraft(prompt.prompt);
                        setWarning("");
                        setMode("edit");
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" /> Editar
                    </Button>
                  )}
                </div>
                {prompt.prompt ? (
                  <pre className="agent-prompt-text">{prompt.prompt}</pre>
                ) : (
                  <p className="muted">Este nó não tem prompt de sistema (o n8n usa o padrão dele).</p>
                )}
              </>
            ) : mode === "edit" ? (
              <>
                {warning && (
                  <p className="agent-warning" role="alert">
                    <TriangleAlert size={15} aria-hidden="true" /> {warning}
                  </p>
                )}
                <Textarea
                  className="agent-editor"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label="Prompt de sistema"
                  autoFocus
                  spellCheck
                />
                <div className="agent-editor-foot">
                  <span className="muted">
                    {chars(draft.length)}
                    {dirty ? " · alterado" : ""}
                  </span>
                  <Button className="btn secondary" onClick={() => (dirty && !window.confirm("Descartar a edição?") ? null : setMode("view"))}>
                    Cancelar
                  </Button>
                  <Button className="btn primary" disabled={!dirty || !draft.trim()} onClick={() => setMode("review")}>
                    Revisar alterações
                  </Button>
                </div>
              </>
            ) : (
              <>
                {warning && (
                  <p className="agent-warning" role="alert">
                    <TriangleAlert size={15} aria-hidden="true" /> {warning}
                  </p>
                )}
                <p className="agent-diff-stats">
                  <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>{" "}
                  {stats.added + stats.removed === 1 ? "linha mudou" : "linhas mudaram"} em relação à versão
                  v{prompt.version}
                </p>
                <DiffView lines={diff} />
                <label className="agent-note-field">
                  <span>O que mudou (opcional, fica no histórico)</span>
                  <Input
                    value={note}
                    maxLength={500}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Ex.: horário de sábado, novo preço da consulta"
                  />
                </label>
                <p className="agent-note muted">
                  Publicar salva o fluxo "{w.name}" no n8n trocando só este prompt
                  {w.active ? " e já vale nas próximas conversas do WhatsApp do cliente" : ""}.
                </p>
                <div className="agent-editor-foot">
                  <Button className="btn secondary" disabled={busy} onClick={() => setMode("edit")}>
                    <ArrowLeft size={14} aria-hidden="true" /> Voltar à edição
                  </Button>
                  <Button
                    className="btn primary"
                    loading={busy}
                    disabled={draft === prompt.prompt}
                    onClick={publish}
                  >
                    <Check size={14} aria-hidden="true" /> Publicar no n8n
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** As versões do prompt; cada uma abre com a diferença para a atual. */
function VersionList({
  prompt,
  notify,
  onPublished,
}: {
  prompt: AgentPrompt;
  notify: (message: string) => void;
  onPublished: () => void;
}) {
  const [versions, setVersions] = useState<AgentPromptVersion[] | null>(null);
  const [open, setOpen] = useState<{ version: number; text: string } | null>(null);
  const [asDiff, setAsDiff] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    agentPromptVersions(prompt.id)
      .then(setVersions)
      .catch((e) => setError(errorOf(e)));
  }, [prompt.id, prompt.version]);
  const show = (v: number) => {
    if (open?.version === v) return setOpen(null);
    agentPromptVersion(prompt.id, v)
      .then((x) => setOpen({ version: x.version, text: x.prompt }))
      .catch((e) => setError(errorOf(e)));
  };
  const restore = () => {
    if (!open) return;
    if (!window.confirm(`Publicar a versão v${open.version} no n8n no lugar da atual (v${prompt.version})?`)) return;
    setBusy(true);
    publishAgentPrompt({ prompt: prompt.id, base: prompt.version, text: open.text, restoreFrom: open.version })
      .then((r) => {
        notify(`Versão v${open.version} publicada no n8n (agora v${r.version}).`);
        setOpen(null);
        onPublished();
      })
      .catch((e) => setError(errorOf(e)))
      .finally(() => setBusy(false));
  };
  if (!versions) return error ? <p className="form-error">{error}</p> : <Loading variant="list" />;
  return (
    <div className="agent-versions">
      {error && <p className="form-error" role="alert">{error}</p>}
      <ul>
        {versions.map((v) => (
          <li key={v.version} className={open?.version === v.version ? "open" : ""}>
            <button type="button" onClick={() => show(v.version)}>
              <strong>
                v{v.version}
                {v.version === prompt.version ? " · atual" : ""}
              </strong>
              <span className={`agent-source agent-source-${v.source}`}>
                {SOURCE_LABEL[v.source]}
                {v.restored_from ? ` (v${v.restored_from})` : ""}
              </span>
              <span className="muted">
                {when(v.saved_at)}
                {v.saved_by_name ? ` · ${v.saved_by_name}` : ""} · {chars(v.chars)}
              </span>
              {v.note && <span className="agent-version-note">“{v.note}”</span>}
            </button>
            {open?.version === v.version && (
              <div className="agent-version-open">
                {v.version !== prompt.version && (
                  <div className="agent-text-toolbar">
                    <label className="agent-check">
                      <input type="checkbox" checked={asDiff} onChange={(e) => setAsDiff(e.target.checked)} />
                      O que muda se esta versão voltar (atual → v{v.version})
                    </label>
                    {prompt.workflow.can_edit && !prompt.removed && (
                      <Button className="btn primary" loading={busy} onClick={restore}>
                        Publicar esta versão
                      </Button>
                    )}
                  </div>
                )}
                {asDiff && v.version !== prompt.version ? (
                  <DiffView lines={diffLines(prompt.prompt, open.text)} />
                ) : (
                  <pre className="agent-prompt-text">{open.text}</pre>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------ sem cliente
function Unlinked({
  company,
  data,
  leader,
  user,
}: {
  company: string;
  data: Snapshot;
  leader: boolean;
  user: string;
}) {
  const [list, setList] = useState<AgentWorkflow[] | null>(null);
  const [all, setAll] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    listAgents(company, { unlinked: true })
      .then(setList)
      .catch((e) => setError(errorOf(e)));
  }, [company]);
  useEffect(load, [load]);
  useLiveAgents({}, load);
  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!list) return <Loading variant="table" />;
  const shown = list.filter((w) => all || (!w.ignored && w.role !== "copy"));
  const hidden = list.length - shown.length;
  return (
    <div className="agent-unlinked">
      <p className="muted agent-intro">
        Fluxos com AI Agent que não foram ligados sozinhos (o nome do fluxo não tem o nome de um cliente). Ligue
        ao cliente e ao produto, ou ignore os que são internos. Subfluxos herdam o cliente do fluxo principal.
        {leader
          ? " Outras pessoas usam esta aba quando liberadas em Módulos visíveis (ou Editar usuário › Recursos extras)."
          : ""}
      </p>
      <label className="agent-check">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        Mostrar também as cópias e os ignorados{hidden && !all ? ` (${hidden})` : ""}
      </label>
      {!shown.length && <p className="muted">Nada pendente: todos os fluxos ativos estão ligados a um cliente.</p>}
      {shown.map((w) => (
        <article key={w.id} className={`agent-flow ${w.role}`}>
          <header className="agent-flow-head">
            <div className="agent-flow-title">
              <strong>{w.name || "(fluxo sem nome)"}</strong>
              <WorkflowBadges w={w} />
              {w.ignored && <span className="agent-state">Ignorado</span>}
            </div>
            <div className="agent-flow-actions">
              <button type="button" className="agent-link-btn" onClick={() => setLinking(linking === w.id ? null : w.id)}>
                <Link2 size={14} aria-hidden="true" /> Ligar ao cliente
              </button>
              <button
                type="button"
                className="agent-link-btn"
                onClick={() =>
                  void ignoreAgentWorkflow(w.id, !w.ignored)
                    .then(load)
                    .catch((e) => setError(errorOf(e)))
                }
              >
                <EyeOff size={14} aria-hidden="true" /> {w.ignored ? "Voltar a mostrar" : "Ignorar"}
              </button>
              <a className="agent-link-btn" href={w.n8n_url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} aria-hidden="true" /> n8n
              </a>
            </div>
          </header>
          <p className="agent-flow-meta muted">
            {w.instance_name}
            {w.called_by.length ? ` · chamado por ${w.called_by.map((c) => `"${c.name}"`).join(", ")}` : ""}
            {w.prompts[0]?.excerpt ? ` · “${w.prompts[0].excerpt.slice(0, 140)}”` : ""}
          </p>
          {linking === w.id && (
            <LinkEditor
              data={data}
              leader={leader}
              user={user}
              workflow={w}
              onDone={() => {
                setLinking(null);
                load();
              }}
            />
          )}
        </article>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ VPS
function Instances({
  company,
  admin,
  notify,
}: {
  company: string;
  admin: boolean;
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<AgentInstance[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AgentInstance | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => {
    agentInstances(company)
      .then(setList)
      .catch((e) => setError(errorOf(e)));
  }, [company]);
  useEffect(load, [load]);
  useLiveAgents({}, load);
  const sync = (id?: string) => {
    setBusy(id ?? "all");
    setError("");
    syncAgents(company, id)
      .then((r) => {
        const bad = r.results.filter((x) => !x.ok);
        notify(
          !r.results.length
            ? "Nenhuma VPS para ler agora (alguma já está sendo lida)."
            : bad.length
              ? `Leitura com erro: ${bad.map((b) => `${b.instance}: ${b.error}`).join(" · ")}`
              : `Leitura concluída: ${r.results.map((x) => `${x.instance} (${x.agents ?? 0} fluxos com AI Agent)`).join(", ")}.`,
        );
        load();
      })
      .catch((e) => setError(errorOf(e)))
      .finally(() => setBusy(null));
  };
  if (!list) return error ? <p className="form-error">{error}</p> : <Loading variant="table" />;
  return (
    <div className="agent-instances">
      <p className="muted agent-intro">
        As VPS com o n8n dos agentes. O MAVI Tasks lê cada uma a cada hora (fluxos com nó AI Agent, prompts e
        ficha técnica) e publica nelas as edições. A chave da API fica cifrada no servidor e nunca volta para a tela.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {admin && (
        <div className="agent-instances-toolbar">
          <Button className="btn primary" onClick={() => setEditing("new")}>
            <Plus size={14} aria-hidden="true" /> Adicionar VPS
          </Button>
          {list.length > 0 && (
            <Button className="btn secondary" loading={busy === "all"} onClick={() => sync()}>
              <RefreshCw size={14} aria-hidden="true" /> Sincronizar todas agora
            </Button>
          )}
        </div>
      )}
      {editing && (
        <InstanceForm
          company={company}
          instance={editing === "new" ? null : editing}
          onDone={(saved) => {
            setEditing(null);
            load();
            if (saved) {
              notify("VPS salva: a chave funcionou. Lendo os fluxos agora…");
              sync(saved);
            }
          }}
        />
      )}
      {!list.length && !editing && (
        <div className="agent-empty">
          <Server size={22} aria-hidden="true" />
          <strong>Nenhuma VPS cadastrada</strong>
          <span>
            {admin
              ? "Adicione o endereço do n8n e uma chave da API (no n8n: Settings › n8n API › Create an API key)."
              : "Um administrador cadastra as VPS do n8n."}
          </span>
        </div>
      )}
      {list.map((i) => (
        <article key={i.id} className="agent-instance">
          <header className="agent-flow-head">
            <div className="agent-flow-title">
              <strong>{i.name}</strong>
              <span className={`agent-state ${i.enabled ? "on" : ""}`}>{i.enabled ? "Ativa" : "Pausada"}</span>
              {i.syncing && <span className="agent-state">Lendo agora…</span>}
            </div>
            {admin && (
              <div className="agent-flow-actions">
                <button type="button" className="agent-link-btn" disabled={!!busy} onClick={() => sync(i.id)}>
                  <RefreshCw size={14} aria-hidden="true" /> {busy === i.id ? "Lendo…" : "Sincronizar agora"}
                </button>
                <button
                  type="button"
                  className="agent-link-btn"
                  disabled={!!busy}
                  onClick={() => {
                    setBusy(`test-${i.id}`);
                    testAgentInstance(company, i.id)
                      .then(() => notify(`${i.name}: conexão com o n8n funcionando.`))
                      .catch((e) => setError(errorOf(e)))
                      .finally(() => setBusy(null));
                  }}
                >
                  <Check size={14} aria-hidden="true" /> Testar
                </button>
                <button type="button" className="agent-link-btn" onClick={() => setEditing(i)}>
                  <Pencil size={14} aria-hidden="true" /> Editar
                </button>
                <button
                  type="button"
                  className="agent-link-btn danger"
                  onClick={() => {
                    if (
                      !window.confirm(
                        `Remover ${i.name}? Os fluxos, prompts e o histórico de versões desta VPS saem do MAVI Tasks (nada muda no n8n).`,
                      )
                    )
                      return;
                    deleteAgentInstance(company, i.id)
                      .then(load)
                      .catch((e) => setError(errorOf(e)));
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" /> Remover
                </button>
              </div>
            )}
          </header>
          <p className="agent-flow-meta muted">
            {i.base_url} · chave {i.key_hint || "guardada"} · {count(i.workflows, "fluxo", "fluxos")} com AI Agent
          </p>
          <p className="agent-flow-meta">
            Última leitura completa: {when(i.last_sync_at)}
            {i.last_stats?.workflows != null
              ? ` · ${i.last_stats.workflows} fluxos no n8n, ${i.last_stats.agents ?? 0} com AI Agent (${count(i.last_stats.main, "principal", "principais")}, ${count(i.last_stats.subflows, "subfluxo", "subfluxos")}, ${count(i.last_stats.copies, "cópia", "cópias")})`
              : ""}
          </p>
          {i.last_error && (
            <p className="agent-warning">
              <TriangleAlert size={15} aria-hidden="true" /> Última tentativa ({when(i.last_attempt_at)}) falhou:{" "}
              {i.last_error}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}

function InstanceForm({
  company,
  instance,
  onDone,
}: {
  company: string;
  instance: AgentInstance | null;
  onDone: (saved: string | null) => void;
}) {
  const [name, setName] = useState(instance?.name ?? "");
  const [url, setUrl] = useState(instance?.base_url ?? "https://");
  const [key, setKey] = useState("");
  const [enabled, setEnabled] = useState(instance?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="agent-instance-form"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        saveAgentInstance({
          company,
          ...(instance ? { id: instance.id } : {}),
          name,
          base_url: url,
          ...(key.trim() ? { api_key: key.trim() } : {}),
          enabled,
        })
          .then((r) => onDone(enabled ? r.id : null))
          .catch((err) => setError(errorOf(err)))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        <span>Nome</span>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VPS 1" maxLength={80} required />
      </label>
      <label>
        <span>Endereço do n8n</span>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://n8n.suaempresa.com.br"
          required
        />
      </label>
      <label>
        <span>Chave da API do n8n{instance ? " (deixe vazio para manter a atual)" : ""}</span>
        <Input
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          required={!instance}
          placeholder={instance ? `Atual: ${instance.key_hint}` : "n8n › Settings › n8n API › Create an API key"}
        />
      </label>
      <label className="agent-check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Ler esta VPS a cada hora
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="agent-editor-foot">
        <Button type="button" className="btn secondary" disabled={busy} onClick={() => onDone(null)}>
          Cancelar
        </Button>
        <Button type="submit" className="btn primary" loading={busy}>
          Testar e salvar
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ módulo
type Tab = "agents" | "unlinked" | "instances";

/** O prompt aberto pelo link (?prompt=<id>), e o fechar limpa o link. */
function usePromptParam() {
  const [open, setOpen] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("prompt"),
  );
  const set = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("prompt", id);
    else url.searchParams.delete("prompt");
    window.history.replaceState(window.history.state, "", url);
    setOpen(id);
  };
  return [open, set] as const;
}

export function AgentsPage({
  company,
  user,
  data,
  notify,
}: {
  company: string;
  user: string;
  data: Snapshot;
  notify: (message: string) => void;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [tab, setTab] = useState<Tab>("agents");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = usePromptParam();
  const loadStatus = useCallback(() => {
    agentStatus(company)
      .then(setStatus)
      .catch(() => setStatus({ leader: false, linker: false }));
  }, [company]);
  useEffect(loadStatus, [loadStatus]);
  useLiveAgents({}, loadStatus);
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 350);
    return () => window.clearTimeout(t);
  }, [search]);
  const leader = !!status?.leader;
  const linker = !!status?.linker;
  const admin = status?.linker ? status.admin : false;
  // Perdeu a permissão com a aba aberta: volta para Agentes.
  useEffect(() => {
    if (!status) return;
    if ((tab === "unlinked" && !linker) || (tab === "instances" && !leader))
      setTab("agents");
  }, [status, tab, linker, leader]);
  const tabs: { id: Tab; label: string; show: boolean }[] = status?.linker
    ? [
        { id: "agents", label: "Agentes", show: true },
        {
          id: "unlinked",
          label: `Sem cliente${status.unlinked ? ` (${status.unlinked})` : ""}`,
          show: true,
        },
        { id: "instances", label: `VPS do n8n${status.errors ? " ⚠" : ""}`, show: leader },
      ]
    : [];

  return (
    <div className="agents-page">
      {status?.linker && (
        <div className="agent-top">
          <div className="drive-view agent-tabs" role="tablist">
            {tabs
              .filter((t) => t.show)
              .map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={tab === t.id ? "selected" : ""}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
          </div>
          {leader && (
            <span className="muted agent-last-sync">
              {status.instances
                ? `Última leitura do n8n: ${when(status.last_sync_at)}`
                : "Nenhuma VPS cadastrada ainda"}
            </span>
          )}
        </div>
      )}
      {tab === "agents" && (
        <>
          <div className="agent-search">
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar no texto dos prompts, nos fluxos ou nos clientes (ex.: agendamento, preço)"
              aria-label="Buscar nos prompts"
            />
          </div>
          <AgentList
            company={company}
            query={query}
            data={data}
            canLink={linker}
            leader={leader}
            user={user}
            onOpen={setOpen}
            emptyHint={
              leader && status?.linker && !status.instances
                ? admin
                  ? "Cadastre as VPS do n8n na aba VPS do n8n para trazer os agentes."
                  : "Um administrador precisa cadastrar as VPS do n8n."
                : undefined
            }
          />
        </>
      )}
      {tab === "unlinked" && linker && (
        <Unlinked company={company} data={data} leader={leader} user={user} />
      )}
      {tab === "instances" && leader && <Instances company={company} admin={admin} notify={notify} />}
      {open && <AgentPromptSheet promptId={open} onClose={() => setOpen(null)} notify={notify} />}
    </div>
  );
}

/** Drive › cliente › produto › Agente Conversacional. */
export function AgentFolder({
  company,
  client,
  contract,
  notify,
  initial,
}: {
  company: string;
  client: string;
  contract: string;
  notify: (message: string) => void;
  /** O prompt a abrir (link ?prompt=). */
  initial?: string | null;
}) {
  const [open, setOpen] = useState<string | null>(initial ?? null);
  return (
    <div className="agent-folder">
      <p className="muted agent-intro">
        O prompt de sistema do assistente de WhatsApp deste cliente, lido dos fluxos do n8n a cada hora. Abra um
        nó para ler, comparar versões e publicar mudanças.
      </p>
      <AgentList
        company={company}
        client={client}
        contract={contract}
        onOpen={setOpen}
        emptyHint="Nenhum fluxo do n8n ligado a este produto ainda. Um líder liga os fluxos em Agente Conversacional › Sem cliente."
      />
      {open && <AgentPromptSheet promptId={open} onClose={() => setOpen(null)} notify={notify} />}
    </div>
  );
}
