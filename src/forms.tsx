import {
  Input,
  Textarea,
  Select,
  SelectOption,
  Checkbox,
  Button,
  Skeleton,
} from "./ui";
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
import { Modal, Avatar, Badge, Empty, Loading } from "./components";
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
      <Select required value={contract} onValueChange={setContract}>
        {!data.contracts.length && (
          <SelectOption value="">
            Vincule um produto a um cliente primeiro
          </SelectOption>
        )}
        {data.contracts.map((c) => (
          <SelectOption value={c.id} key={c.id}>
            {c.name}
          </SelectOption>
        ))}
      </Select>
    </label>
  );
  return (
    <Modal title={titles[kind]} onClose={onClose}>
      <form className="entity-form" onSubmit={submit}>
        {kind === "task" ? (
          <>
            <label>
              Nome da tarefa
              <Input
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
                <Select name="project" key={contract}>
                  <SelectOption value="">Sem projeto · manutenção</SelectOption>
                  {data.projects
                    .filter((p) => p.contract_id === contract)
                    .map((p) => (
                      <SelectOption key={p.id} value={p.id}>
                        {p.name}
                      </SelectOption>
                    ))}
                </Select>
              </label>
              <label>
                Equipe
                <Select name="team" key={contract}>
                  <SelectOption value="">Sem equipe principal</SelectOption>
                  {data.teams
                    .filter((t) =>
                      data.contractTeams.some(
                        (ct) =>
                          ct.contract_id === contract && ct.team_id === t.id,
                      ),
                    )
                    .map((t) => (
                      <SelectOption key={t.id} value={t.id}>
                        {t.name}
                      </SelectOption>
                    ))}
                </Select>
              </label>
            </div>
            <div className="form-columns">
              <label>
                Responsável
                <Select name="assignee" defaultValue={user} required>
                  {data.members
                    .filter((m) => m.active)
                    .map((m) => (
                      <SelectOption key={m.user_id} value={m.user_id}>
                        {m.name}
                      </SelectOption>
                    ))}
                </Select>
              </label>
              <label>
                Prazo combinado
                <Input
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
                <Select name="priority" defaultValue="normal">
                  {Object.entries(priorities).map(([id, label]) => (
                    <SelectOption key={id} value={id}>
                      {label}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                Estimativa em horas
                <Input
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
              <Select name="parent" key={contract}>
                <SelectOption value="">
                  Esta é uma tarefa principal
                </SelectOption>
                {data.tasks
                  .filter((t) => t.contract_id === contract)
                  .map((t) => (
                    <SelectOption key={t.id} value={t.id}>
                      {t.title}
                    </SelectOption>
                  ))}
              </Select>
            </label>
            <label>
              Descrição
              <Textarea
                name="description"
                placeholder="Contexto, referências e critérios de entrega"
                rows={3}
              />
            </label>
            <label className="checkbox-label">
              <Checkbox name="client_approval" /> Exigir aprovação do cliente
              além da aprovação interna
            </label>
          </>
        ) : null}
        {["client", "product", "project", "team", "contract"].includes(
          kind,
        ) && (
          <label>
            {kind === "contract" ? "Nome da contratação" : "Nome"}
            <Input
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
            <Input
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
              <Input name="due" type="date" />
            </label>
          </>
        )}
        {kind === "contract" && (
          <>
            <label>
              Cliente
              <Select name="client" required>
                {!data.clients.length && (
                  <SelectOption value="">
                    Cadastre um cliente primeiro
                  </SelectOption>
                )}
                {data.clients.map((c) => (
                  <SelectOption key={c.id} value={c.id}>
                    {c.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              Produto
              <Select name="product" required>
                {!data.products.length && (
                  <SelectOption value="">
                    Cadastre um produto primeiro
                  </SelectOption>
                )}
                {data.products.map((p) => (
                  <SelectOption key={p.id} value={p.id}>
                    {p.name}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <label>
              Equipe com acesso
              <Select name="team">
                <SelectOption value="">
                  Somente administradores por enquanto
                </SelectOption>
                {data.teams.map((t) => (
                  <SelectOption key={t.id} value={t.id}>
                    {t.name}
                  </SelectOption>
                ))}
              </Select>
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
                  <Checkbox name="members" value={m.user_id} />
                  {m.name}
                </label>
              ))}
          </fieldset>
        )}
        {kind === "time" && (
          <>
            <label>
              Tarefa
              <Select name="task" required>
                {data.tasks.map((t) => (
                  <SelectOption key={t.id} value={t.id}>
                    {t.title}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <div className="form-columns">
              <label>
                Início
                <Input type="datetime-local" name="start" required />
              </label>
              <label>
                Fim
                <Input type="datetime-local" name="end" required />
              </label>
            </div>
            <label>
              Observação
              <Textarea name="note" rows={3} />
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
          <Button
            type="button"
            className="btn secondary"
            disabled={busy}
            loading={busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button className="btn primary" disabled={busy} loading={busy}>
            {kind === "time" ? "Registrar horas" : "Salvar"}
            <Check size={17} />
          </Button>
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
              <Input
                name="title"
                defaultValue={task.title}
                minLength={2}
                maxLength={240}
                required
              />
            </label>
            <label>
              Descrição
              <Textarea
                name="description"
                defaultValue={task.description}
                rows={4}
              />
            </label>
            <div className="form-columns">
              <label>
                Prazo
                <Input
                  type="date"
                  name="due"
                  defaultValue={task.due_date}
                  required
                />
              </label>
              <label>
                Estimativa em horas
                <Input
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
              <Select name="priority" defaultValue={task.priority}>
                {Object.entries(priorities).map(([k, v]) => (
                  <SelectOption value={k} key={k}>
                    {v}
                  </SelectOption>
                ))}
              </Select>
            </label>
            <div className="form-footer">
              <Button
                type="button"
                className="btn secondary"
                onClick={() => setEditing(false)}
              >
                Cancelar
              </Button>
              <Button className="btn primary" disabled={busy} loading={busy}>
                <Save size={16} /> Salvar alterações
              </Button>
            </div>
          </form>
        ) : (
          <section className="detail-description">
            <div>
              <h3>Descrição</h3>
              {canEdit && task.status !== "done" && (
                <Button className="text-btn" onClick={() => setEditing(true)}>
                  Editar tarefa
                </Button>
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
                <Button
                  className="btn primary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => void transition("start")}
                >
                  <Play size={15} /> Iniciar tarefa
                </Button>
              )}
              {["open", "progress", "returned"].includes(task.status) && (
                <Button
                  className="btn primary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => void transition("submit")}
                >
                  <Check size={16} /> Enviar para validação
                </Button>
              )}
              {task.status === "review" && canApprove && (
                <>
                  {!task.internal_approved_by && (
                    <Button
                      className="btn primary"
                      disabled={busy}
                      loading={busy}
                      onClick={() => void transition("approve_internal")}
                    >
                      <Check size={16} /> Aprovar internamente
                    </Button>
                  )}
                  {task.requires_client_approval &&
                    !task.client_approved_by && (
                      <Button
                        className="btn secondary"
                        disabled={busy}
                        loading={busy}
                        onClick={() => setAction("approve_client")}
                      >
                        Registrar aprovação do cliente
                      </Button>
                    )}
                  <Button
                    className="btn secondary"
                    disabled={busy}
                    loading={busy}
                    onClick={() => setAction("reject")}
                  >
                    Solicitar ajustes
                  </Button>
                </>
              )}
              {["open", "progress", "review"].includes(task.status) && (
                <Button
                  className="btn secondary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => setAction("return")}
                >
                  Devolver ao criador
                </Button>
              )}
              {task.status === "done" && canApprove && (
                <Button
                  className="btn secondary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => setAction("reopen")}
                >
                  Reabrir tarefa
                </Button>
              )}
            </>
          )}
          {task.status !== "done" && (
            <Button
              className="btn secondary"
              loading={busy}
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
            </Button>
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
              <Textarea
                required
                minLength={action === "approve_client" ? 5 : 3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
              />
            </label>
            <div className="form-footer">
              <Button
                type="button"
                className="btn secondary"
                onClick={() => setAction("")}
              >
                Cancelar
              </Button>
              <Button className="btn primary" disabled={busy} loading={busy}>
                Confirmar
              </Button>
            </div>
          </form>
        )}
        <div className="detail-tabs">
          {[
            { id: "comments", label: "Comentários", icon: MessageSquare },
            { id: "files", label: "Arquivos", icon: Paperclip },
            { id: "activity", label: "Histórico", icon: History },
          ].map((t) => (
            <Button
              className={tab === t.id ? "selected" : ""}
              key={t.id}
              onClick={() => setTab(t.id)}
            >
              <t.icon size={16} />
              {t.label}
            </Button>
          ))}
        </div>
        {loading ? (
          <Loading compact />
        ) : tab === "comments" ? (
          <>
            <form className="comment-form" onSubmit={comment}>
              <Avatar
                name={
                  data.members.find((m) => m.user_id === user)?.name ??
                  "Usuário"
                }
              />
              <Textarea
                name="body"
                aria-label="Comentário"
                required
                rows={2}
                maxLength={10000}
                placeholder="Adicione contexto ou compartilhe uma atualização…"
              />
              <Button
                className="icon-btn"
                disabled={busy}
                loading={busy}
                aria-label="Enviar comentário"
              >
                <Send size={19} />
              </Button>
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
                {demo ? (
                  "Arquivos disponíveis após conectar ao Supabase"
                ) : uploading ? (
                  <span role="status" aria-busy="true">
                    <Skeleton className="skeleton-upload" />
                    <span className="sr-only">Enviando arquivo…</span>
                  </span>
                ) : (
                  "Clique para anexar um arquivo"
                )}
              </strong>
              <small>
                PDF, imagens, documentos, planilhas ou ZIP · até 20 MB
              </small>
              <Input
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
                <Button
                  className="icon-btn"
                  aria-label={`Baixar ${a.name}`}
                  onClick={() => void download(a)}
                >
                  <Download size={18} />
                </Button>
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
