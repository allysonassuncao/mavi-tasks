import {
  Input,
  Textarea,
  Select,
  SelectOption,
  Checkbox,
  Button,
  Skeleton,
} from "./ui";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
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
  LockKeyhole,
  Copy,
  Pause,
  KeyRound,
  Mail,
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
import {
  dateKey,
  dateLabel,
  duration,
  minutes,
  names,
  taskTimerSeconds,
  formatClock,
} from "./domain";
import { useNow } from "./useClock";
import { supabase } from "./supabase";
import { rpc, taskExtras, invalidateTaskExtras } from "./api";
import { getGcsPublicUrl } from "./gcs";
import type { DemoStore } from "./demo-store";
import { RichTextContent } from "./RichTextContent";
import {
  attachmentAccept,
  validateAttachment,
  uploadAttachment,
  saveTaskWithAttachments,
  type TaskUploadState,
} from "./attachments";
const RichTextEditor = lazy(() => import("./RichTextEditor"));
type Mutate = (name: string, args: Record<string, unknown>) => Promise<any>;
export function CreateForm({
  kind,
  initialProduct,
  demo,
  data,
  company,
  user,
  busy,
  mutate,
  onClose,
}: {
  kind: string;
  initialProduct?: string;
  demo: boolean;
  data: Snapshot;
  company: string;
  user: string;
  busy: boolean;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [contract, setContract] = useState(data.contracts[0]?.id ?? ""),
    [error, setError] = useState("");
  const uploads = useRef<TaskUploadState>({ pending: [] });
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [editorUploading, setEditorUploading] = useState(false);
  const [, updateUploads] = useState(0);
  const redrawUploads = () => updateUploads((v) => v + 1);
  const close = () => {
    if (!submitting.current && !editorUploading) onClose();
  };
  function addFiles(files: FileList | null) {
    setError("");
    const errors: string[] = [];
    for (const file of Array.from(files ?? [])) {
      try {
        validateAttachment(file);
        if (
          !uploads.current.pending.some(
            (f) =>
              f.name === file.name &&
              f.size === file.size &&
              f.lastModified === file.lastModified,
          )
        )
          uploads.current.pending.push(file);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    setError(errors.join(" "));
    redrawUploads();
  }
  const titles: Record<string, string> = {
    task: "Nova tarefa",
    client: "Novo cliente",
    product: "Novo produto",
    contract: "Adicionar produto contratado",
    project: "Novo projeto",
    time: "Registrar horas",
    team: "Nova equipe",
    user: "Convidar usuário",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current || editorUploading) return;
    setError("");
    const f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) ?? "");
    let fn = "",
      a: Record<string, unknown> = { p_company: company };
    switch (kind) {
      case "user":
        fn = "invite_user";
        Object.assign(a, {
          p_name: s("name"),
          p_email: s("email"),
          p_role: s("role"),
          p_teams: f.getAll("teams"),
        });
        break;
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
          p_start: s("start_date") || null,
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
    submitting.current = true;
    setSaving(true);
    try {
      if (kind === "task") {
        await saveTaskWithAttachments(
          uploads.current,
          () => mutate(fn, a),
          uploadAttachment,
          redrawUploads,
        );
      } else await mutate(fn, a);
      onClose();
    } catch (e) {
      const message =
        (e as Error).message ?? "Não foi possível enviar o arquivo.";
      setError(
        uploads.current.taskId
          ? `A tarefa foi salva. ${message} Tente reenviar os anexos pendentes ou feche para continuar depois.`
          : message,
      );
    } finally {
      submitting.current = false;
      setSaving(false);
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
            {data.clients.find((client) => client.id === c.client_id)?.name} ·{" "}
            {data.products.find((p) => p.id === c.product_id)?.name} — {c.name}
          </SelectOption>
        ))}
      </Select>
    </label>
  );
  return (
    <Modal
      title={titles[kind]}
      onClose={close}
      busy={saving || editorUploading}
    >
      <form className="entity-form" onSubmit={submit}>
        <fieldset
          className="create-fields"
          disabled={saving || !!uploads.current.taskId}
        >
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
                    <SelectOption value="">
                      Sem projeto · manutenção
                    </SelectOption>
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
                Início planejado (opcional)
                <Input name="start_date" type="date" />
              </label>
              <Suspense fallback={<Loading compact />}>
                <RichTextEditor
                  company={company}
                  demo={demo}
                  onUploading={setEditorUploading}
                  disabled={saving || !!uploads.current.taskId}
                />
              </Suspense>
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
              {kind === "contract" ? "Nome do serviço contratado" : "Nome"}
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
                <Select
                  name="product"
                  required
                  defaultValue={initialProduct || undefined}
                >
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
          {kind === "user" && (
            <>
              <label>
                Nome completo
                <Input
                  name="name"
                  placeholder="Ex.: Mariana Souza"
                  minLength={2}
                  maxLength={120}
                  required
                />
              </label>
              <label>
                E-mail profissional
                <Input
                  type="email"
                  name="email"
                  placeholder="mariana@empresa.com.br"
                  required
                />
              </label>
              <label>
                Perfil de acesso
                <Select name="role" defaultValue="member" required>
                  <SelectOption value="member">
                    Colaborador — Execução de tarefas e apontamentos
                  </SelectOption>
                  <SelectOption value="manager">
                    Gestor — Gestão de equipes e aprovações
                  </SelectOption>
                  <SelectOption value="admin">
                    Administrador — Acesso total e configurações
                  </SelectOption>
                </Select>
              </label>
              {data.teams.length > 0 && (
                <fieldset>
                  <legend>Vincular a equipes (opcional)</legend>
                  {data.teams.map((t) => (
                    <label className="checkbox-label" key={t.id}>
                      <Checkbox name="teams" value={t.id} />
                      {t.name}
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
        </fieldset>
        {kind === "task" && (
          <section
            className="creation-attachments"
            aria-label="Anexos da nova tarefa"
          >
            <label
              className={`upload-zone creation-upload ${saving || demo ? "disabled" : ""}`}
            >
              <Paperclip size={17} /> Adicionar anexos
              <Input
                type="file"
                multiple
                accept={attachmentAccept}
                disabled={saving || demo}
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <small>
              {demo
                ? "Envio de arquivos disponível no ambiente conectado. O modo demonstração não armazena arquivos."
                : "Até 20 MB por arquivo. PDF, imagens, TXT, CSV, ZIP, DOCX, XLSX e PPTX."}
            </small>
            {uploads.current.pending.map((file, index) => (
              <div
                className="pending-file"
                key={`${file.name}-${file.size}-${file.lastModified}`}
              >
                <Paperclip size={15} />
                <span>
                  {file.name}
                  <small>{(file.size / 1024).toFixed(1)} KB</small>
                </span>
                <Button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remover ${file.name}`}
                  disabled={saving}
                  onClick={() => {
                    uploads.current.pending.splice(index, 1);
                    redrawUploads();
                  }}
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            {saving && uploads.current.taskId && (
              <div role="status" aria-label="Enviando anexos">
                <Skeleton className="skeleton-title" />
              </div>
            )}
            {uploads.current.taskId && (
              <small role="status">
                Tarefa criada. {uploads.current.pending.length} anexo(s)
                pendente(s).
              </small>
            )}
          </section>
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
            disabled={busy || saving || editorUploading}
            loading={busy || saving || editorUploading}
            onClick={close}
          >
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={busy || saving || editorUploading}
            loading={busy || saving || editorUploading}
          >
            {uploads.current.taskId
              ? uploads.current.pending.length
                ? "Reenviar anexos"
                : "Concluir"
              : kind === "user"
                ? "Enviar convite"
                : kind === "time"
                  ? "Registrar horas"
                  : "Salvar"}
            <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function TaskDetail({
  task,
  currentRunning,
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
  currentRunning: import("./types").TimeEntry | null;
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
  const [editorUploading, setEditorUploading] = useState(false);
  const [commentRevision, setCommentRevision] = useState(0);
  const n = names(data, task),
    member = data.members.find((m) => m.user_id === user),
    isAdmin = member?.role === "admin",
    isManager = member?.role === "manager",
    isLeader = isAdmin || isManager,
    canApprove = isLeader,
    canEdit = isLeader || task.creator_id === user,
    canWork = isLeader || task.creator_id === user || task.assignee_id === user;
  const running = currentRunning;
  const isRunning = running?.task_id === task.id;
  const now = useNow(isRunning);
  const totalSeconds = taskTimerSeconds(data.hours, task.id, running, now);
  const clock = formatClock(totalSeconds);
  const taskHours = data.hours
    .filter((h) => h.task_id === task.id)
    .reduce((s, h) => s + minutes(h, now), 0);
  useEffect(() => {
    if (!isRunning) setEditing(false);
  }, [isRunning]);
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
    taskExtras(task.id, refresh > 0 || localRefresh > 0)
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
      invalidateTaskExtras(task.id);
      // The task itself is patched optimistically by mutate(); only the
      // activity/history tab still needs a (small, scoped) refetch.
      setLocalRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function comment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (editorUploading) return;
    const form = e.currentTarget,
      body = String(new FormData(form).get("body") ?? "").trim();
    if (!body) return;
    try {
      const result = await mutate("add_comment", {
        p_task: task.id,
        p_body: body,
      });
      invalidateTaskExtras(task.id);
      // Demo mode already re-syncs extras from the demo store whenever
      // mutate() bumps `refresh`; appending here too would double it up.
      if (!demo && result)
        setExtras((x) => ({
          ...x,
          comments: [result as Comment, ...x.comments],
        }));
      form.reset();
      setCommentRevision((v) => v + 1);
      setLocalRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function edit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (editorUploading || !isRunning || !canEdit) return;
    const fd = new FormData(e.currentTarget);
    try {
      await mutate("update_task", {
        p_task: task.id,
        p_version: task.version,
        p_title: fd.get("title"),
        p_description: fd.get("description"),
        p_due: fd.get("due"),
        p_start: fd.get("start_date") || null,
        p_estimated: Number(fd.get("estimated")) * 60,
        p_priority: fd.get("priority"),
      });
      setEditing(false);
      invalidateTaskExtras(task.id);
      setLocalRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function upload(file: File) {
    if (!supabase || demo) return;
    setUploading(true);
    setError("");
    try {
      await uploadAttachment(task.id, file);
      invalidateTaskExtras(task.id);
      setLocalRefresh((v) => v + 1);
      notify("Arquivo anexado.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  async function download(a: Attachment) {
    try {
      const publicUrl = getGcsPublicUrl(a.path);
      const res = await fetch(publicUrl);
      if (!res.ok) throw new Error("Não foi possível baixar o arquivo do GCS.");
      const blob = await res.blob();
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
    <Modal
      title="Detalhes da tarefa"
      onClose={onClose}
      busy={busy || uploading || editorUploading}
      wide
    >
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
        <section
          className={`focus-timer ${isRunning ? "is-running" : ""}`}
          aria-label="Controle de execução"
        >
          <Button
            className={`timer-play ${isRunning ? "timer-stop" : ""}`}
            loading={busy}
            disabled={busy || editorUploading}
            onClick={() =>
              void mutate(
                isRunning ? "stop_timer" : "start_timer",
                isRunning ? { p_entry: running.id } : { p_task: task.id },
              ).catch((e) => setError(e.message))
            }
          >
            {isRunning ? (
              <Pause size={27} fill="currentColor" />
            ) : (
              <Play size={27} fill="currentColor" />
            )}
            <span>{isRunning ? "Parar" : "Iniciar"}</span>
          </Button>
          <div>
            <strong>{clock}</strong>
            <p>
              {isRunning
                ? "Tempo sendo registrado nesta tarefa."
                : running
                  ? "Ao iniciar, sua outra tarefa será pausada automaticamente."
                  : totalSeconds > 0
                    ? "Cronômetro pausado. Clique em Iniciar para continuar."
                    : "Inicie para ler a descrição e registrar seu tempo."}
            </p>
          </div>
          <Button
            className="btn secondary share-task"
            onClick={() =>
              void navigator.clipboard
                .writeText(window.location.href)
                .then(() => notify("Link da tarefa copiado."))
                .catch(() =>
                  setError(
                    "Copie o endereço da barra do navegador para compartilhar.",
                  ),
                )
            }
          >
            <Copy size={16} /> Copiar link
          </Button>
        </section>
        {!isRunning ? (
          <section
            className="description-locked"
            aria-label="Descrição bloqueada até iniciar"
          >
            <div className="blurred-placeholder" aria-hidden="true">
              <p>
                Contexto, referências e orientações para realizar esta tarefa.
              </p>
              <p>
                Instruções e detalhes do trabalho aparecem nesta área de
                leitura.
              </p>
              <p>Entregáveis e critérios para validação.</p>
            </div>
            <div className="description-unlock">
              <LockKeyhole size={24} />
              <strong>Inicie a tarefa para visualizar a descrição</strong>
              <span>Use o botão Iniciar acima.</span>
            </div>
          </section>
        ) : editing ? (
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
            <Suspense
              fallback={
                <>
                  <input
                    type="hidden"
                    name="description"
                    value={task.description}
                  />
                  <Loading compact />
                </>
              }
            >
              <RichTextEditor
                company={task.company_id}
                demo={demo}
                defaultValue={task.description}
                disabled={busy}
                onUploading={setEditorUploading}
              />
            </Suspense>
            <label>
              Início planejado (opcional)
              <Input
                type="date"
                name="start_date"
                defaultValue={task.start_date ?? ""}
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
              <Button
                className="btn primary"
                disabled={busy || editorUploading}
                loading={busy || editorUploading}
              >
                <Save size={16} /> Salvar alterações
              </Button>
            </div>
          </form>
        ) : (
          <section className="detail-description">
            <div>
              <h3>Descrição</h3>
              {canEdit && (
                <Button className="text-btn" onClick={() => setEditing(true)}>
                  Editar tarefa
                </Button>
              )}
            </div>
            <RichTextContent value={task.description} />
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
          {canWork && (
            <>
              {["open", "returned"].includes(task.status) && (
                <Button
                  className="btn primary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => void transition("start")}
                >
                  <Check size={15} /> Marcar em andamento
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
              <Suspense fallback={<Loading compact />}>
                <RichTextEditor
                  key={commentRevision}
                  company={task.company_id}
                  demo={demo}
                  name="body"
                  label="Comentário"
                  disabled={busy}
                  onUploading={setEditorUploading}
                />
              </Suspense>
              <Button
                className="icon-btn"
                disabled={busy || editorUploading}
                loading={busy || editorUploading}
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
                    <RichTextContent value={c.body} />
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
                accept={attachmentAccept}
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

export function ResetPasswordModal({
  member,
  busy,
  onSubmit,
  onClose,
}: {
  member: { user_id: string; name: string; email?: string };
  busy: boolean;
  onSubmit: (
    mode: "send_link" | "set_password",
    newPassword?: string,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"send_link" | "set_password">("send_link");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || busy) return;
    setError("");

    if (mode === "set_password") {
      if (newPassword.trim().length < 8) {
        setError("A nova senha deve ter no mínimo 8 caracteres.");
        return;
      }
    }

    setSubmitting(true);
    try {
      await onSubmit(
        mode,
        mode === "set_password" ? newPassword.trim() : undefined,
      );
      onClose();
    } catch (err) {
      setError((err as Error).message || "Erro ao redefinir senha.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`Redefinir senha · ${member.name}`}
      onClose={onClose}
      busy={submitting || busy}
    >
      <form className="entity-form" onSubmit={handleSubmit}>
        <fieldset className="create-fields" disabled={submitting || busy}>
          <label>
            Colaborador
            <Input
              value={
                member.email ? `${member.name} (${member.email})` : member.name
              }
              disabled
              readOnly
            />
          </label>

          <label>
            Método de redefinição
            <Select
              value={mode}
              onValueChange={(val) =>
                setMode(val as "send_link" | "set_password")
              }
            >
              <SelectOption value="send_link">
                Enviar link de recuperação por e-mail
              </SelectOption>
              <SelectOption value="set_password">
                Definir nova senha diretamente
              </SelectOption>
            </Select>
          </label>

          {mode === "send_link" ? (
            <small>
              {member.email
                ? `Um e-mail será enviado para ${member.email} com o link seguro para cadastrar uma nova senha.`
                : "O colaborador receberá o link seguro de redefinição no e-mail cadastrado."}
            </small>
          ) : (
            <>
              <label>
                Nova senha
                <Input
                  type="password"
                  placeholder="Mínimo de 8 caracteres"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  minLength={8}
                  required
                  autoFocus
                />
              </label>
              <small>
                Cadastre uma nova senha provisória ou definitiva caso o
                colaborador não tenha acesso ao e-mail.
              </small>
            </>
          )}
        </fieldset>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            disabled={submitting || busy}
            loading={submitting || busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={submitting || busy}
            loading={submitting || busy}
          >
            {mode === "send_link" ? "Enviar link" : "Salvar nova senha"}
            <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function UpdateEmailModal({
  member,
  busy,
  onSubmit,
  onClose,
}: {
  member: { user_id: string; name: string; email?: string };
  busy: boolean;
  onSubmit: (newEmail: string) => Promise<void>;
  onClose: () => void;
}) {
  const [newEmail, setNewEmail] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || busy) return;
    setError("");

    const emailTrimmed = newEmail.trim().toLowerCase();
    if (!emailTrimmed || !/^\S+@\S+\.\S+$/.test(emailTrimmed)) {
      setError("Informe um endereço de e-mail válido.");
      return;
    }

    if (member.email && emailTrimmed === member.email.toLowerCase()) {
      setError("O novo e-mail deve ser diferente do e-mail atual.");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit(emailTrimmed);
      onClose();
    } catch (err) {
      setError((err as Error).message || "Erro ao atualizar e-mail.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={`Alterar e-mail · ${member.name}`}
      onClose={onClose}
      busy={submitting || busy}
    >
      <form className="entity-form" onSubmit={handleSubmit}>
        <fieldset className="create-fields" disabled={submitting || busy}>
          <label>
            Colaborador
            <Input value={member.name} disabled readOnly />
          </label>

          <div className="form-columns">
            <label>
              E-mail atual
              <Input
                value={member.email || "Não informado"}
                disabled
                readOnly
              />
            </label>

            <label>
              Novo e-mail profissional
              <Input
                type="email"
                placeholder="colaborador@empresa.com.br"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                required
                autoFocus
              />
            </label>
          </div>

          <small>
            O colaborador passará a utilizar este novo e-mail para acesso à
            plataforma.
          </small>
        </fieldset>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            disabled={submitting || busy}
            loading={submitting || busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={submitting || busy}
            loading={submitting || busy}
          >
            Atualizar e-mail
            <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
