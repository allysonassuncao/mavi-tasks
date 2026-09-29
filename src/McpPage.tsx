import { useEffect, useRef, useState } from "react";
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  LogIn,
  LogOut,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  User,
  Users,
} from "lucide-react";
import { Button, Input, Loading, Textarea } from "./ui";
import { Modal } from "./components";
import type { Snapshot } from "./types";
import { AudienceFields, type Audience } from "./AiPowersPanel";
import { myPowers } from "./ai";
import {
  blankDraft,
  connectMcp,
  deleteMcp,
  disconnectMcp,
  discoverMcp,
  draftOf,
  listMcp,
  mcpStatus,
  saveMcp,
  setMcpAudience,
  setMcpToolAuto,
  toggleMcpTool,
  type McpAuth,
  type McpDraft,
  type McpServer,
} from "./mavi-mcp";
import "./mavi-mcp.css";

/**
 * MAVI › Conexões: os servidores MCP que a MAVI usa. Administradores e
 * gestores cadastram os da empresa e dizem quem usa; cada pessoa com o poder
 * cria os seus. Cada conexão mostra as ferramentas (as que alteram algo
 * pedem confirmação na conversa), liga e desliga cada uma, e o login na
 * conta do serviço quando é OAuth.
 */

const RESULTS: Record<string, string> = {
  conectado: "Conta conectada.",
  cancelado: "Login cancelado no serviço.",
  expirou: "O login demorou demais. Tente conectar de novo.",
  erro: "Não foi possível conectar a conta. Tente de novo.",
};

const AUTH_LABELS: Record<McpAuth, string> = {
  none: "Sem login",
  header: "Chave de API",
  oauth: "Login no serviço (OAuth)",
};

export function McpPage({
  company,
  data,
  isLeader,
  powersHref,
  notify,
}: {
  company: string;
  data: Snapshot;
  isLeader: boolean;
  powersHref: string;
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<McpServer[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [mcpOn, setMcpOn] = useState(true);
  const [editing, setEditing] = useState<McpDraft | null>(null);
  const [audience, setAudience] = useState<McpServer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const returned = useRef(false);

  useEffect(() => {
    myPowers(company)
      .then((p) => setMcpOn(Array.isArray(p) && p.includes("mcp")))
      .catch(() => {});
  }, [company]);
  useEffect(() => {
    listMcp(company)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [company, tick]);
  const reload = () => setTick((t) => t + 1);

  // A volta do login no serviço (?mcp=conectado): avisa e busca as ferramentas.
  useEffect(() => {
    if (returned.current || !list) return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get("mcp");
    if (!result) return;
    returned.current = true;
    notify(RESULTS[result] ?? RESULTS.erro);
    params.delete("mcp");
    const rest = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    if (result !== "conectado") return;
    const stale = list.filter((s) => s.auth === "oauth" && s.connected && s.editable);
    if (!stale.length) return;
    void Promise.all(stale.map((s) => discoverMcp(s.id).catch(() => null))).then(reload);
  }, [list, notify]);

  async function run(id: string, work: () => Promise<unknown>, done?: string) {
    setBusy(id);
    setError("");
    try {
      await work();
      if (done) notify(done);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  async function connect(s: McpServer) {
    setBusy(s.id);
    setError("");
    try {
      const { url } = await connectMcp(s.id, window.location.pathname);
      window.location.assign(url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }
  async function refresh(s: McpServer) {
    await run(s.id, async () => {
      const r = await discoverMcp(s.id);
      if (r.needs_connect) notify("Conecte a conta para a MAVI ver as ferramentas.");
      else notify(`${r.tools ?? 0} ferramentas encontradas.`);
    });
  }

  const company_ = (list ?? []).filter((s) => !s.personal);
  const mine = (list ?? []).filter((s) => s.personal);
  const card = (s: McpServer) => {
    const status = mcpStatus(s);
    const on = s.tools.filter((t) => t.enabled).length;
    const expanded = open.has(s.id);
    const canConnect = s.auth === "oauth" && (s.personal || s.per_person ? s.usable || s.editable : s.editable);
    return (
      <li key={s.id} className={`panel mcp-card${s.enabled ? "" : " off"}`}>
        <header className="mcp-card-head">
          <span className="mcp-card-icon" aria-hidden="true">
            <Plug size={17} />
          </span>
          <span className="mcp-card-title">
            <strong>{s.name}</strong>
            <small>{s.url}</small>
          </span>
          <span className={`mcp-status ${status.tone}`}>{status.label}</span>
        </header>
        {s.instructions && <p className="mcp-card-text">{s.instructions}</p>}
        <ul className="mcp-card-meta">
          <li>
            {s.auth === "oauth" ? <LogIn size={13} /> : s.auth === "header" ? <KeyRound size={13} /> : <ShieldCheck size={13} />}
            {AUTH_LABELS[s.auth]}
            {s.auth === "oauth" && !s.personal && (s.per_person ? " · cada pessoa com a sua conta" : " · conta da empresa")}
            {s.auth === "header" && s.header_hint ? ` · ${s.header_hint}` : ""}
          </li>
          {!s.personal && (
            <li>
              <Users size={13} />
              {s.everyone && !s.except_ids.length ? "Todos com o poder Conexões" : "Equipes e pessoas escolhidas"}
            </li>
          )}
          <li>
            {on} de {s.tools.length} ferramentas ligadas
          </li>
        </ul>
        {s.last_error && (
          <p className="form-error" role="alert">
            {s.last_error}
          </p>
        )}
        <div className="mcp-card-actions">
          {canConnect && !s.connected && (
            <Button className="btn primary" loading={busy === s.id} onClick={() => void connect(s)}>
              <LogIn size={15} /> {s.personal || s.per_person ? "Conectar minha conta" : "Conectar a conta da empresa"}
            </Button>
          )}
          {canConnect && s.connected && (
            <Button
              className="btn secondary"
              disabled={busy === s.id}
              onClick={() => {
                if (!window.confirm(`Desconectar a conta de ${s.name}?`)) return;
                void run(s.id, () => disconnectMcp(s.id), "Conta desconectada.");
              }}
            >
              <LogOut size={15} /> Desconectar
            </Button>
          )}
          {s.editable && (
            <Button className="btn secondary" loading={busy === s.id} onClick={() => void refresh(s)}>
              <RefreshCw size={15} /> Atualizar ferramentas
            </Button>
          )}
          {s.editable && (
            <Button className="btn secondary" onClick={() => setEditing(draftOf(s))}>
              <Pencil size={15} /> Editar
            </Button>
          )}
          {!s.personal && isLeader && (
            <Button className="btn secondary" onClick={() => setAudience(s)}>
              <Users size={15} /> Quem usa
            </Button>
          )}
          {s.editable && (
            <Button
              className="btn secondary mcp-danger"
              disabled={busy === s.id}
              onClick={() => {
                if (!window.confirm(`Apagar a conexão ${s.name}? As contas conectadas também saem.`)) return;
                void run(s.id, () => deleteMcp(s.id), "Conexão apagada.");
              }}
            >
              <Trash2 size={15} /> Apagar
            </Button>
          )}
        </div>
        {!!s.tools.length && (
          <div className="mcp-tools">
            <button
              type="button"
              className="mcp-tools-toggle"
              aria-expanded={expanded}
              onClick={() =>
                setOpen((o) => {
                  const next = new Set(o);
                  if (next.has(s.id)) next.delete(s.id);
                  else next.add(s.id);
                  return next;
                })
              }
            >
              {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              Ferramentas
            </button>
            {expanded && (
              <ul>
                {s.tools.map((t) => (
                  <li key={t.name} className={t.enabled ? "" : "off"}>
                    <span>
                      <strong>{t.title || t.name}</strong>
                      <span className={`mcp-tool-kind ${t.read_only || t.auto ? "read" : "write"}`}>
                        {t.read_only ? "Só lê" : t.auto ? "Roda sem confirmar" : "Altera · pede confirmação"}
                      </span>
                      {t.description && <small>{t.description}</small>}
                      {!t.read_only && s.editable && (
                        <label className="mcp-tool-auto">
                          <input
                            type="checkbox"
                            checked={!t.auto}
                            disabled={busy === `${s.id}:${t.name}:auto`}
                            onChange={() =>
                              void run(`${s.id}:${t.name}:auto`, () => setMcpToolAuto(s.id, t.name, !t.auto))
                            }
                          />
                          Pedir confirmação antes de rodar
                        </label>
                      )}
                    </span>
                    {s.editable ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={t.enabled}
                        aria-label={`${t.enabled ? "Desligar" : "Ligar"} ${t.title || t.name}`}
                        className={`template-switch${t.enabled ? " on" : ""}`}
                        disabled={busy === `${s.id}:${t.name}`}
                        onClick={() =>
                          void run(`${s.id}:${t.name}`, () => toggleMcpTool(s.id, t.name, !t.enabled))
                        }
                      >
                        <span aria-hidden="true" />
                        {t.enabled ? "Ligada" : "Desligada"}
                      </button>
                    ) : (
                      <small>{t.enabled ? "Ligada" : "Desligada"}</small>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="mcp-page">
      {!mcpOn && (
        <p className="panel mcp-off">
          O poder <strong>Conexões (MCP)</strong> está desligado para você: a MAVI
          só usa as conexões depois que um administrador ou gestor ligar em{" "}
          <a href={powersHref}>Painel da MAVI › Poderes</a>.
          {isLeader && " Você já pode cadastrar e testar as conexões da empresa."}
        </p>
      )}
      <div className="mcp-toolbar">
        <p>
          Conecte a MAVI a outros serviços (Notion, Linear, um sistema próprio…)
          pelo protocolo MCP. Ela consulta direto e, para criar ou mudar algo no
          serviço, mostra um card para você confirmar.
        </p>
        {isLeader && (
          <Button className="btn primary" onClick={() => setEditing(blankDraft(false))}>
            <Building2 size={16} /> Conexão da empresa
          </Button>
        )}
        {mcpOn && (
          <Button
            className={`btn ${isLeader ? "secondary" : "primary"}`}
            onClick={() => setEditing(blankDraft(true))}
          >
            <Plus size={16} /> Conexão pessoal
          </Button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list === null ? (
        <Loading compact />
      ) : !list.length ? (
        <div className="panel mcp-empty">
          <span className="mcp-empty-icon" aria-hidden="true">
            <Plug size={22} />
          </span>
          <strong>Nenhuma conexão ainda</strong>
          <p>
            Uma conexão é o endereço de um servidor MCP (em geral termina em
            /mcp). Com ela, a MAVI lê os dados do serviço e, com a sua
            confirmação, cria e atualiza coisas nele, direto na conversa.
          </p>
          {(isLeader || mcpOn) && (
            <div className="mcp-empty-actions">
              {isLeader && (
                <Button className="btn primary" onClick={() => setEditing(blankDraft(false))}>
                  <Building2 size={16} /> Criar conexão da empresa
                </Button>
              )}
              {mcpOn && (
                <Button
                  className={`btn ${isLeader ? "secondary" : "primary"}`}
                  onClick={() => setEditing(blankDraft(true))}
                >
                  <Plus size={16} /> Criar conexão pessoal
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {!!company_.length && (
            <section className="mcp-section">
              <h3>
                <Building2 size={15} /> Da empresa
              </h3>
              <ul className="mcp-grid">{company_.map(card)}</ul>
            </section>
          )}
          {!!mine.length && (
            <section className="mcp-section">
              <h3>
                <User size={15} /> Minhas conexões
              </h3>
              <ul className="mcp-grid">{mine.map(card)}</ul>
            </section>
          )}
        </>
      )}
      {editing && (
        <McpForm
          company={company}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={(id, needsConnect) => {
            setEditing(null);
            reload();
            if (needsConnect) {
              const s = { id } as McpServer;
              if (window.confirm("Conexão salva. Conectar a conta agora?")) void connect(s);
            }
          }}
          notify={notify}
        />
      )}
      {audience && (
        <AudienceModal
          server={audience}
          data={data}
          onClose={() => setAudience(null)}
          onSaved={() => {
            setAudience(null);
            notify("Público da conexão salvo.");
            reload();
          }}
        />
      )}
    </div>
  );
}

function McpForm({
  company,
  initial,
  onClose,
  onSaved,
  notify,
}: {
  company: string;
  initial: McpDraft;
  onClose: () => void;
  onSaved: (id: string, needsConnect: boolean) => void;
  notify: (message: string) => void;
}) {
  const [d, setD] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (patch: Partial<McpDraft>) => setD((x) => ({ ...x, ...patch }));
  const editing = !!initial.id;
  const redirect = `${window.location.origin}/api/mavi-mcp/callback`;
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await saveMcp(company, d);
      if (r.error) notify(`Conexão salva, mas o servidor respondeu: ${r.error}`);
      else if (!r.needs_connect) notify(`Conexão salva · ${r.tools ?? 0} ferramentas.`);
      onSaved(r.id, !!r.needs_connect);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${editing ? "Editar" : "Nova"} conexão ${d.personal ? "pessoal" : "da empresa"}`}
      onClose={onClose}
      busy={busy}
    >
      <form
        className="mcp-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span>Nome</span>
          <Input value={d.name} maxLength={60} required placeholder="Ex.: Notion da agência" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label>
          <span>Endereço do servidor MCP</span>
          <Input
            value={d.url}
            type="url"
            required
            placeholder="https://mcp.exemplo.com/mcp"
            onChange={(e) => set({ url: e.target.value })}
          />
          <small>Precisa ser https e aceitar o transporte Streamable HTTP.</small>
        </label>
        <label>
          <span>Quando a MAVI deve usar</span>
          <Textarea
            value={d.instructions}
            maxLength={2000}
            rows={3}
            placeholder="Ex.: Documentos e atas do time ficam aqui. Use para buscar briefings e registrar decisões."
            onChange={(e) => set({ instructions: e.target.value })}
          />
        </label>
        <fieldset className="mcp-auth">
          <legend>Autenticação</legend>
          {(["none", "header", "oauth"] as McpAuth[]).map((a) => (
            <label key={a} className={d.auth === a ? "on" : ""}>
              <input type="radio" name="mcp-auth" checked={d.auth === a} onChange={() => set({ auth: a })} />
              {AUTH_LABELS[a]}
            </label>
          ))}
        </fieldset>
        {d.auth === "header" && (
          <div className="mcp-form-row">
            <label>
              <span>Cabeçalho</span>
              <Input value={d.header_name} maxLength={60} onChange={(e) => set({ header_name: e.target.value })} />
            </label>
            <label>
              <span>Valor (a chave)</span>
              <Input
                value={d.header_value}
                type="password"
                autoComplete="off"
                placeholder={editing ? "Deixe em branco para manter" : "Bearer sk-…"}
                onChange={(e) => set({ header_value: e.target.value })}
              />
            </label>
          </div>
        )}
        {d.auth === "oauth" && (
          <>
            {!d.personal && (
              <fieldset className="mcp-auth">
                <legend>De quem é a conta</legend>
                <label className={!d.per_person ? "on" : ""}>
                  <input type="radio" name="mcp-who" checked={!d.per_person} onChange={() => set({ per_person: false })} />
                  Uma conta da empresa (você conecta)
                </label>
                <label className={d.per_person ? "on" : ""}>
                  <input type="radio" name="mcp-who" checked={d.per_person} onChange={() => set({ per_person: true })} />
                  Cada pessoa conecta a própria conta
                </label>
              </fieldset>
            )}
            <details className="mcp-advanced">
              <summary>App OAuth criado à mão (opcional)</summary>
              <p>
                A MAVI cadastra o app sozinha quando o serviço deixa. Se não
                deixar, crie um app OAuth no serviço com o endereço de retorno{" "}
                <code>{redirect}</code> e informe os dados aqui.
              </p>
              <div className="mcp-form-row">
                <label>
                  <span>Client ID</span>
                  <Input value={d.client_id} maxLength={300} onChange={(e) => set({ client_id: e.target.value })} />
                </label>
                <label>
                  <span>Client secret</span>
                  <Input
                    value={d.client_secret}
                    type="password"
                    autoComplete="off"
                    placeholder={editing ? "Deixe em branco para manter" : ""}
                    onChange={(e) => set({ client_secret: e.target.value })}
                  />
                </label>
              </div>
            </details>
          </>
        )}
        <label className="mcp-check">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Conexão ligada (a MAVI usa)
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="mcp-form-foot">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy}>
            <Check size={15} /> Salvar e testar
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

function AudienceModal({
  server,
  data,
  onClose,
  onSaved,
}: {
  server: McpServer;
  data: Snapshot;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [a, setA] = useState<Audience>({
    everyone: server.everyone,
    team_ids: server.team_ids,
    user_ids: server.user_ids,
    except_ids: server.except_ids,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={`Quem usa ${server.name}`} onClose={onClose} busy={busy}>
      <div className="mcp-form">
        <p className="mcp-note">
          Vale para quem também tem o poder Conexões (MCP) em Painel da MAVI ›
          Poderes.
        </p>
        <AudienceFields name={`mcp-${server.id}`} data={data} value={a} onChange={(p) => setA((x) => ({ ...x, ...p }))} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="mcp-form-foot">
          <Button className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await setMcpAudience(server.id, a);
                onSaved();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check size={15} /> Salvar
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
