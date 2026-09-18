import { useEffect, useState, type FormEvent } from "react";
import {
  CalendarDays,
  Check,
  Clock3,
  Download,
  Flag,
  MessageSquare,
  Paperclip,
  Play,
  Send,
  Square,
  UserRound,
  X,
  Plus,
  History,
  Save,
} from "lucide-react";
import { Modal, Avatar, Badge, Empty } from "./components";
import {
  type Snapshot,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
  priorities,
} from "./types";
import { dateKey, dateLabel, duration, minutes, names } from "./domain";
import { supabase } from "./supabase";
import { rpc, taskExtras } from "./api";
import type { DemoStore } from "./demo-store";
type Mutate = (name: string, args: Record<string, unknown>) => Promise<any>;
export function CreateForm({
  kind,
  data,
  company,
  user,
  busy,
  mutate,
  onClose,
}: {
  kind: string;
  data: Snapshot;
  company: string;
  user: string;
  busy: boolean;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [contract, setContract] = useState(data.contracts[0]?.id ?? ""),
    [error, setError] = useState("");
  const titles: Record<string, string> = {
    task: "Nova tarefa",
    client: "Novo cliente",
    product: "Novo produto",
    contract: "Vincular produto ao cliente",
    project: "Novo projeto",
    time: "Registrar horas",
    team: "Nova equipe",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) ?? "");
    let fn = "",
      a: Record<string, unknown> = { p_company: company };
    switch (kind) {
      case "client":
        fn = "create_client";
        Object.assign(a, { p_name: s("name"), p_email: s("email") });
        break;
      case "product":
        fn = "create_product";
        a.p_name = s("name");
        break;
      case "team":
        fn = "create_team";
        Object.assign(a, { p_name: s("name"), p_users: f.getAll("members") });
        break;
      case "contract":
        fn = "create_contract";
        Object.assign(a, {
          p_client: s("client"),
          p_product: s("product"),
          p_name: s("name"),
          p_team: s("team") || null,
        });
        break;
      case "project":
        fn = "create_project";
        Object.assign(a, {
          p_contract: contract,
          p_name: s("name"),
          p_due: s("due") || null,
        });
        break;
      case "task":
        fn = "create_task";
        Object.assign(a, {
          p_contract: contract,
          p_title: s("title"),
          p_assignee: s("assignee"),
          p_due: s("due"),
          p_project: s("project") || null,
          p_team: s("team") || null,
          p_description: s("description"),
          p_priority: s("priority"),
          p_estimated: Number(s("estimated")) * 60,
          p_client_approval: f.has("client_approval"),
          p_parent: s("parent") || null,
        });
        break;
      case "time":
        fn = "log_time";
        a = {
          p_task: s("task"),
          p_start: new Date(s("start")).toISOString(),
          p_end: new Date(s("end")).toISOString(),
          p_note: s("note"),
        };
        break;
    }
    try {
      await mutate(fn, a);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const contractSelect = (
    <label>
      Produto contratado
      <select
        required
        value={contract}
        onChange={(e) => setContract(e.target.value)}
      >
        {!data.contracts.length && (
          <option value="">Vincule um produto a um cliente primeiro</option>
        )}
        {data.contracts.map((c) => (
          <option value={c.id} key={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <form className="entity-form" onSubmit={submit}>
        {kind === "task" ? (
          <>
            <label>
              Nome da tarefa
              <input
                name="title"
                placeholder="O que precisa ser feito?"
                required
                minLength={2}
                maxLength={240}
                autoFocus
              />
            </label>
            {contractSelect}
            <div className="form-columns">
              <label>
                Projeto
                <select name="project" key={contract}>
                  <option value="">Sem projeto · manutenção</option>
                  {data.projects
                    .filter((p) => p.contract_id === contract)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Equipe
                <select name="team" key={contract}>
                  <option value="">Sem equipe principal</option>
                  {data.teams
                    .filter((t) =>
                      data.contractTeams.some(
                        (ct) =>
                          ct.contract_id === contract && ct.team_id === t.id,
                      ),
                    )
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <div className="form-columns">
              <label>
                Responsável
                <select name="assignee" defaultValue={user} required>
                  {data.members
                    .filter((m) => m.active)
                    .map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Prazo combinado
                <input
                  name="due"
                  type="date"
                  defaultValue={dateKey()}
                  required
                />
              </label>
            </div>
            <div className="form-columns">
              <label>
                Prioridade
                <select name="priority" defaultValue="normal">
                  {Object.entries(priorities).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Estimativa em horas
                <input
                  type="number"
                  name="estimated"
                  min="0"
                  max="10000"
                  step="0.25"
                  defaultValue="0"
                />
              </label>
            </div>
            <label>
              Tarefa principal (opcional)
              <select name="parent" key={contract}>
                <option value="">Esta é uma tarefa principal</option>
                {data.tasks
                  .filter((t) => t.contract_id === contract)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Descrição
              <textarea
                name="description"
                placeholder="Contexto, referências e critérios de entrega"
                rows={3}
              />
            </label>
            <label className="checkbox-label">
              <input type="checkbox" name="client_approval" /> Exigir aprovação
              do cliente além da aprovação interna
            </label>
          </>
        ) : null}
        {["client", "product", "project", "team", "contract"].includes(
          kind,
        ) && (
          <label>
            {kind === "contract" ? "Nome da contratação" : "Nome"}
            <input
              name="name"
              required
              minLength={2}
              maxLength={120}
              autoFocus
              placeholder={
                kind === "client"
                  ? "Ex.: Aurora Studio"
                  : kind === "product"
                    ? "Ex.: Make Ads"
                    : kind === "contract"
                      ? "Ex.: Make Ads · Aurora"
                      : ""
              }
            />
          </label>
        )}
        {kind === "client" && (
          <label>
            E-mail de contato
            <input
              name="email"
              type="email"
              placeholder="contato@cliente.com.br"
            />
          </label>
        )}
        {kind === "project" && (
          <>
            {contractSelect}
            <label>
              Prazo do projeto
              <input name="due" type="date" />
            </label>
          </>
        )}
        {kind === "contract" && (
          <>
            <label>
              Cliente
              <select name="client" required>
                {!data.clients.length && (
                  <option value="">Cadastre um cliente primeiro</option>
                )}
                {data.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Produto
              <select name="product" required>
                {!data.products.length && (
                  <option value="">Cadastre um produto primeiro</option>
                )}
                {data.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Equipe com acesso
              <select name="team">
                <option value="">Somente administradores por enquanto</option>
                {data.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {kind === "team" && (
          <fieldset>
            <legend>Pessoas da equipe</legend>
            {data.members
              .filter((m) => m.active)
              .map((m) => (
                <label className="checkbox-label" key={m.user_id}>
                  <input type="checkbox" name="members" value={m.user_id} />
                  {m.name}
                </label>
              ))}
          </fieldset>
        )}
        {kind === "time" && (
          <>
            <label>
              Tarefa
              <select name="task" required>
                {data.tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-columns">
              <label>
                Início
                <input type="datetime-local" name="start" required />
              </label>
              <label>
                Fim
                <input type="datetime-local" name="end" required />
              </label>
            </div>
            <label>
              Observação
              <textarea name="note" rows={3} />
            </label>
            <small>
              Os períodos não podem se sobrepor a outros apontamentos.
            </small>
          </>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <button className="btn primary" disabled={busy}>
            {busy
              ? "Salvando…"
              : kind === "time"
                ? "Registrar horas"
                : "Salvar"}
            <Check size={17} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function TaskDetail({
  task,
  data,
  user,
  busy,
  demo,
  demoStore,
  refresh,
  mutate,
  onClose,
  notify,
}: {
  task: Task;
  data: Snapshot;
  user: string;
  busy: boolean;
  demo: boolean;
  demoStore: DemoStore;
  refresh: number;
  mutate: Mutate;
  onClose: () => void;
  notify: (s: string) => void;
}) {
  const [tab, setTab] = useState("comments"),
    [extras, setExtras] = useState<{
      comments: Comment[];
      attachments: Attachment[];
      events: TaskEvent[];
    }>({ comments: [], attachments: [], events: [] }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [editing, setEditing] = useState(false),
    [localRefresh, setLocalRefresh] = useState(0),
    [note, setNote] = useState(""),
    [action, setAction] = useState(""),
    [uploading, setUploading] = useState(false);
  const n = names(data, task),
    member = data.members.find((m) => m.user_id === user),
    manager =
      member?.role === "manager" &&
      data.teamMembers.some(
        (t) => t.team_id === task.team_id && t.user_id === user,
      ),
    canApprove = task.creator_id === user || manager,
    canEdit =
      canApprove || task.assignee_id === user || member?.role === "admin";
  const running = data.hours.find((h) => h.user_id === user && !h.ended_at),
    taskHours = data.hours
      .filter((h) => h.task_id === task.id)
      .reduce((s, h) => s + minutes(h), 0);
  useEffect(() => {
    let alive = true;
    if (demo) {
      setExtras({
        comments: demoStore.comments.filter((c) => c.task_id === task.id),
        attachments: [],
        events: demoStore.events.filter((e) => e.task_id === task.id),
      });
      return;
    }
    setLoading(true);
    taskExtras(task.id)
      .then((x) => {
        if (alive) setExtras(x);
      })
      .catch((e) => setError(e.message))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [task.id, demo, demoStore, refresh, localRefresh]);
  async function transition(value: string, message = "") {
    try {
      setError("");
      await mutate("transition_task", {
        p_task: task.id,
        p_version: task.version,
        p_action: value,
        p_note: message,
      });
      setAction("");
      setNote("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function comment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget,
      body = String(new FormData(form).get("body") ?? "").trim();
    if (!body) return;
    try {
      await mutate("add_comment", { p_task: task.id, p_body: body });
      form.reset();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function edit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await mutate("update_task", {
        p_task: task.id,
        p_version: task.version,
        p_title: fd.get("title"),
        p_description: fd.get("description"),
        p_due: fd.get("due"),
        p_estimated: Number(fd.get("estimated")) * 60,
        p_priority: fd.get("priority"),
      });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function upload(file: File) {
    if (!supabase || demo) return;
    setUploading(true);
    setError("");
    let attachment: Attachment | undefined;
    try {
      if (file.size > 20971520 || file.size === 0)
        throw Error("Escolha um arquivo de até 20 MB.");
      attachment = await rpc("prepare_attachment", {
        p_task: task.id,
        p_name: file.name,
        p_size: file.size,
      });
      const { error } = await supabase.storage
        .from("mavi-attachments")
        .upload(attachment!.path, file, { upsert: false });
      if (error) throw error;
      setLocalRefresh((v) => v + 1);
      notify("Arquivo anexado.");
    } catch (e) {
      if (attachment) {
        try {
          await rpc("discard_pending_attachment", {
            p_attachment: attachment.id,
          });
        } catch {
          /* retain record for reconciliation */
        }
      }
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function download(a: Attachment) {
    try {
      const { data: blob, error } = await supabase!.storage
        .from("mavi-attachments")
        .download(a.path);
      if (error) throw error;
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = a.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Modal title="Detalhes da tarefa" onClose={onClose} wide>
      <div className="task-detail">
        <div className="detail-breadcrumb">
          {n.client?.name}
          <span>/</span>
          {n.product?.name}
          <span>/</span>
          {n.project?.name ?? "Manutenção"}
        </div>
        <div className="detail-title">
          <h2>{task.title}</h2>
          <Badge status={task.status} />
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="task-properties">
          <div>
            <span>
              <UserRound size={16} /> Responsável
            </span>
            <strong>
              <Avatar name={n.member?.name ?? "?"} size="small" />
              {n.member?.name}
            </strong>
          </div>
          <div>
            <span>
              <CalendarDays size={16} /> Prazo combinado
            </span>
            <strong>{dateLabel(task.due_date)}</strong>
          </div>
          <div>
            <span>
              <Flag size={16} /> Prioridade
            </span>
            <strong>{priorities[task.priority]}</strong>
          </div>
          <div>
            <span>
              <Clock3 size={16} /> Tempo
            </span>
            <strong>
              {duration(taskHours)}{" "}
              <small>/ {duration(task.estimated_minutes)} estimadas</small>
            </strong>
          </div>
        </div>
        {editing ? (
          <form className="entity-form inline-edit" onSubmit={edit}>
            <label>
              Título
              <input
                name="title"
                defaultValue={task.title}
                minLength={2}
                maxLength={240}
                required
              />
            </label>
            <label>
              Descrição
              <textarea
                name="description"
                defaultValue={task.description}
                rows={4}
              />
            </label>
            <div className="form-columns">
              <label>
                Prazo
                <input
                  type="date"
                  name="due"
                  defaultValue={task.due_date}
                  required
                />
              </label>
              <label>
                Estimativa em horas
                <input
                  type="number"
                  name="estimated"
                  defaultValue={task.estimated_minutes / 60}
                  min="0"
                  step="0.25"
                />
              </label>
            </div>
            <label>
              Prioridade
              <select name="priority" defaultValue={task.priority}>
                {Object.entries(priorities).map(([k, v]) => (
                  <option value={k} key={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <div className="form-footer">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setEditing(false)}
              >
                Cancelar
              </button>
              <button className="btn primary" disabled={busy}>
                <Save size={16} /> Salvar alterações
              </button>
            </div>
          </form>
        ) : (
          <section className="detail-description">
            <div>
              <h3>Descrição</h3>
              {canEdit && task.status !== "done" && (
                <button className="text-btn" onClick={() => setEditing(true)}>
                  Editar tarefa
                </button>
              )}
            </div>
            <p>{task.description || "Nenhuma descrição adicionada."}</p>
          </section>
        )}
        <div className="approval-state">
          <Check size={17} />
          <span>
            Aprovação interna:{" "}
            <strong>
              {task.internal_approved_by ? "aprovada" : "pendente"}
            </strong>
            {task.requires_client_approval && (
              <>
                {" "}
                · Cliente:{" "}
                <strong>
                  {task.client_approved_by ? "aprovada" : "pendente"}
                </strong>
              </>
            )}
          </span>
        </div>
        <div className="detail-actions">
          {canEdit && (
            <>
              {["open", "returned"].includes(task.status) && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void transition("start")}
                >
                  <Play size={15} /> Iniciar tarefa
                </button>
              )}
              {["open", "progress", "returned"].includes(task.status) && (
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={() => void transition("submit")}
                >
                  <Check size={16} /> Enviar para validação
                </button>
              )}
              {task.status === "review" && canApprove && (
                <>
                  {!task.internal_approved_by && (
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void transition("approve_internal")}
                    >
                      <Check size={16} /> Aprovar internamente
                    </button>
                  )}
                  {task.requires_client_approval &&
                    !task.client_approved_by && (
                      <button
                        className="btn secondary"
                        disabled={busy}
                        onClick={() => setAction("approve_client")}
                      >
                        Registrar aprovação do cliente
                      </button>
                    )}
                  <button
                    className="btn secondary"
                    disabled={busy}
                    onClick={() => setAction("reject")}
                  >
                    Solicitar ajustes
                  </button>
                </>
              )}
              {["open", "progress", "review"].includes(task.status) && (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setAction("return")}
                >
                  Devolver ao criador
                </button>
              )}
              {task.status === "done" && canApprove && (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setAction("reopen")}
                >
                  Reabrir tarefa
                </button>
              )}
            </>
          )}
          {task.status !== "done" && (
            <button
              className="btn secondary"
              disabled={busy || (!!running && running.task_id !== task.id)}
              onClick={() =>
                void mutate(
                  running ? "stop_timer" : "start_timer",
                  running ? { p_entry: running.id } : { p_task: task.id },
                ).catch((e) => setError(e.message))
              }
            >
              {running?.task_id === task.id ? (
                <>
                  <Square size={14} /> Parar cronômetro
                </>
              ) : (
                <>
                  <Clock3 size={16} /> Cronometrar
                </>
              )}
            </button>
          )}
        </div>
        {action && (
          <form
            className="action-note"
            onSubmit={(e) => {
              e.preventDefault();
              void transition(action, note);
            }}
          >
            <label>
              {action === "approve_client"
                ? "Quem aprovou, quando e por qual meio?"
                : "Descreva o motivo"}
              <textarea
                required
                minLength={action === "approve_client" ? 5 : 3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </label>
            <div className="form-footer">
              <button
                type="button"
                className="btn secondary"
                onClick={() => setAction("")}
              >
                Cancelar
              </button>
              <button className="btn primary" disabled={busy}>
                Confirmar
              </button>
            </div>
          </form>
        )}
        <div className="detail-tabs">
          {[
            { id: "comments", label: "Comentários", icon: MessageSquare },
            { id: "files", label: "Arquivos", icon: Paperclip },
            { id: "activity", label: "Histórico", icon: History },
          ].map((t) => (
            <button
              className={tab === t.id ? "selected" : ""}
              key={t.id}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              {t.label}
            </button>
          ))}
        </div>
        {loading ? (
          <p>Carregando…</p>
        ) : tab === "comments" ? (
          <>
            <form className="comment-form" onSubmit={comment}>
              <Avatar
                name={
                  data.members.find((m) => m.user_id === user)?.name ??
                  "Usuário"
                }
              />
              <textarea
                name="body"
                required
                rows={2}
                maxLength={10000}
                placeholder="Adicione contexto ou compartilhe uma atualização…"
              />
              <button
                className="icon-btn"
                disabled={busy}
                aria-label="Enviar comentário"
              >
                <Send size={19} />
              </button>
            </form>
            <div className="comment-list">
              {extras.comments.map((c) => (
                <article key={c.id}>
                  <Avatar
                    name={
                      data.members.find((m) => m.user_id === c.author_id)
                        ?.name ?? "Usuário"
                    }
                  />
                  <div>
                    <strong>
                      {
                        data.members.find((m) => m.user_id === c.author_id)
                          ?.name
                      }
                      <small>
                        {new Date(c.created_at).toLocaleString("pt-BR")}
                      </small>
                    </strong>
                    <p>{c.body}</p>
                  </div>
                </article>
              ))}
              {!extras.comments.length && (
                <p className="muted centered">
                  A conversa sobre esta entrega começa aqui.
                </p>
              )}
            </div>
          </>
        ) : tab === "files" ? (
          <>
            <label className={`upload-zone ${demo ? "disabled" : ""}`}>
              <Paperclip size={24} />
              <strong>
                {demo
                  ? "Arquivos disponíveis após conectar ao Supabase"
                  : uploading
                    ? "Enviando…"
                    : "Clique para anexar um arquivo"}
              </strong>
              <small>
                PDF, imagens, documentos, planilhas ou ZIP · até 20 MB
              </small>
              <input
                type="file"
                disabled={demo || uploading}
                accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.zip,.docx,.xlsx,.pptx"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void upload(file);
                  e.target.value = "";
                }}
              />
            </label>
            {extras.attachments.map((a) => (
              <div className="file-row" key={a.id}>
                <Paperclip size={17} />
                <span>
                  {a.name}
                  <small>{(a.size_bytes / 1024).toFixed(0)} KB</small>
                </span>
                <button
                  className="icon-btn"
                  aria-label={`Baixar ${a.name}`}
                  onClick={() => void download(a)}
                >
                  <Download size={18} />
                </button>
              </div>
            ))}
          </>
        ) : (
          <div className="event-list">
            {extras.events.map((e) => (
              <div key={e.id}>
                <span className="event-dot" />
                <div>
                  <strong>
                    {(
                      {
                        created: "Tarefa criada",
                        start: "Trabalho iniciado",
                        submit: "Enviada para validação",
                        return: "Devolvida ao criador",
                        reject: "Ajustes solicitados",
                        approve_internal: "Aprovação interna registrada",
                        approve_client: "Aprovação do cliente registrada",
                        reopen: "Tarefa reaberta",
                        edited: "Tarefa editada",
                      } as Record<string, string>
                    )[e.action] ?? e.action}
                  </strong>
                  <small>
                    {new Date(e.created_at).toLocaleString("pt-BR")}
                  </small>
                  {!!e.detail.note && <p>{String(e.detail.note)}</p>}
                </div>
              </div>
            ))}
            {!extras.events.length && (
              <p className="muted centered">
                As próximas alterações aparecerão aqui.
              </p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
