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
  History,
  Save,
  LockKeyhole,
  Copy,
  Pause,
  KeyRound,
  Mail,
  HardDrive,
} from "lucide-react";
import { Modal, Avatar, Badge, Empty, Loading } from "./components";
import {
  type Snapshot,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
  type ProjectApprover,
  priorities,
} from "./types";
import {
  dateLabel,
  defaultContractName,
  duration,
  durationWithSeconds,
  names,
  taskTimerSeconds,
  formatClock,
  projectReview,
  taskActions,
  type BlockedAction,
} from "./domain";
import { useNow } from "./useClock";
import { supabase } from "./supabase";
import { rpc, taskExtras, invalidateTaskExtras } from "./api";
import { getGcsPublicUrl } from "./gcs";
import type { DemoStore } from "./demo-store";
import { RichTextContent } from "./RichTextContent";
import {
  parseDescription,
  richTextPlain,
  serializeDescription,
} from "./rich-text";
import { ContractPicker } from "./ContractPicker";
import { TaskDrive } from "./DrivePage";
import { TeamPicker } from "./TeamPicker";
import { ReviewSettings } from "./ReviewSettings";
import { attachmentAccept, uploadAttachment } from "./attachments";
const RichTextEditor = lazy(() => import("./RichTextEditor"));
type Mutate = (name: string, args: Record<string, unknown>) => Promise<any>;
export type FormPreset = {
  client?: string;
  product?: string;
  contract?: string;
  project?: string;
  team?: string;
};
export function CreateForm({
  kind,
  preset = {},
  data,
  company,
  busy,
  mutate,
  onClose,
}: {
  kind: string;
  preset?: FormPreset;
  data: Snapshot;
  company: string;
  busy: boolean;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [contract, setContract] = useState(
      data.contracts.some((c) => c.id === preset.contract)
        ? preset.contract!
        : (data.contracts.find((c) => !c.archived)?.id ?? ""),
    ),
    [error, setError] = useState("");
  const [linkClient, setLinkClient] = useState(
    preset.client ?? data.clients[0]?.id ?? "",
  );
  const [linkProduct, setLinkProduct] = useState(
    () =>
      preset.product ??
      (
        data.products.find(
          (p) =>
            !data.contracts.some(
              (c) =>
                !c.archived &&
                c.client_id === linkClient &&
                c.product_id === p.id,
            ),
        ) ?? data.products[0]
      )?.id ??
      "",
  );
  const clientName = data.clients.find((c) => c.id === linkClient)?.name ?? "";
  const productName =
    data.products.find((p) => p.id === linkProduct)?.name ?? "";
  const alreadyLinked = data.contracts.some(
    (c) =>
      !c.archived && c.client_id === linkClient && c.product_id === linkProduct,
  );
  const [clientTeams, setClientTeams] = useState<string[]>([]);
  const [requiresReview, setRequiresReview] = useState(true);
  const [approver, setApprover] = useState<ProjectApprover>("creator");
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  const close = () => {
    if (!submitting.current) onClose();
  };
  const titles: Record<string, string> = {
    client: "Novo cliente",
    product: "Novo produto",
    contract: "Adicionar produto ao cliente",
    project: "Novo projeto",
    time: "Registrar horas",
    user: "Convidar usuário",
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
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
        Object.assign(a, {
          p_name: s("name"),
          p_email: s("email"),
          p_teams: clientTeams,
        });
        break;
      case "product":
        fn = "create_product";
        a.p_name = s("name");
        break;
      case "contract":
        fn = "create_contract";
        Object.assign(a, {
          p_client: linkClient,
          p_product: linkProduct,
          p_name:
            s("name").trim() || defaultContractName(productName, clientName),
        });
        break;
      case "project":
        fn = "create_project";
        Object.assign(a, {
          p_contract: contract,
          p_name: s("name"),
          p_due: s("due") || null,
          p_requires_review: requiresReview,
          p_approver: approver,
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
      await mutate(fn, a);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  return (
    <Modal title={titles[kind]} onClose={close} busy={saving}>
      <form className="entity-form" onSubmit={submit}>
        <fieldset className="create-fields" disabled={saving}>
          {["client", "product", "project"].includes(kind) && (
            <label>
              {kind === "project" ? "Nome do projeto" : "Nome"}
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
                      ? "Ex.: Gestão de tráfego, Social media"
                      : kind === "project"
                        ? "Ex.: Campanha Black Friday, Lançamento do site"
                        : ""
                }
              />
            </label>
          )}
          {kind === "client" && (
            <>
              <label>
                E-mail de contato
                <Input
                  name="email"
                  type="email"
                  placeholder="contato@cliente.com.br"
                />
              </label>
              <TeamPicker
                teams={data.teams}
                value={clientTeams}
                onChange={setClientTeams}
              />
            </>
          )}
          {kind === "project" &&
            (contract ? (
              <ContractPicker
                data={data}
                contract={contract}
                onContractChange={setContract}
              />
            ) : (
              <p className="form-error" role="alert">
                Adicione um produto a um cliente (em Clientes) antes de criar
                projetos.
              </p>
            ))}
          {kind === "project" && (
            <>
              <small>
                Projetos agrupam as entregas de um produto do cliente, como uma
                campanha ou um lançamento. Tarefas do dia a dia podem ficar sem
                projeto.
              </small>
              <label>
                Prazo do projeto
                <Input name="due" type="date" />
              </label>
              {contract && (
                <ReviewSettings
                  data={data}
                  contractId={contract}
                  required={requiresReview}
                  approver={approver}
                  onRequiredChange={setRequiresReview}
                  onApproverChange={setApprover}
                />
              )}
            </>
          )}
          {kind === "contract" && (
            <>
              <div className="form-columns">
                <label>
                  Cliente
                  <Select
                    required
                    value={linkClient}
                    onValueChange={setLinkClient}
                  >
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
                    required
                    value={linkProduct}
                    onValueChange={setLinkProduct}
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
              </div>
              {alreadyLinked && (
                <small className="form-hint" role="status">
                  {clientName} já contrata {productName}. Se for um segundo
                  contrato (outra unidade ou período), dê uma identificação
                  abaixo para diferenciar.
                </small>
              )}
              <label>
                Identificação (opcional)
                <Input
                  name="name"
                  maxLength={120}
                  placeholder="Ex.: Unidade Centro, Contrato 2026"
                />
              </label>
            </>
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
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            disabled={busy || saving}
            loading={busy || saving}
            onClick={close}
          >
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={busy || saving}
            loading={busy || saving}
          >
            {kind === "user"
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
const blocked = (value: unknown): value is BlockedAction =>
  typeof value === "object" && value !== null && "blocked" in value;
/** Field label, submit label and confirmation for each action that takes a note. */
const noteForm: Record<
  string,
  { label: string; submit: string; confirm?: string }
> = {
  start: {
    label: "Parecer para reenviar ao responsável",
    submit: "Enviar novamente",
  },
  submit: {
    label: "Descreva o que foi entregue para a validação",
    submit: "Confirmar solicitação",
  },
  approve_internal: {
    label: "Observações da validação",
    submit: "Aprovar tarefa",
  },
  approve_client: {
    label: "Quem aprovou, quando e por qual meio?",
    submit: "Registrar aprovação",
  },
  reject: {
    label: "Descreva o motivo da reprovação",
    submit: "Reprovar tarefa",
    confirm: "Reprovar esta tarefa e devolvê-la para ajustes?",
  },
  return: {
    label: "Descreva o motivo da devolução",
    submit: "Confirmar devolução",
    confirm: "Devolver esta tarefa ao criador?",
  },
  reopen: {
    label: "Descreva o motivo da reabertura",
    submit: "Confirmar reabertura",
    confirm: "Reabrir esta tarefa?",
  },
};
/** Adds plain paragraphs (e.g. questionnaire answers) before a rich-text note. */
function prependParagraphs(note: string, lines: string[]) {
  return serializeDescription({
    type: "doc",
    content: [
      ...lines.map((text) => ({
        type: "paragraph",
        content: [{ type: "text", text }],
      })),
      ...(parseDescription(note).content ?? []),
    ],
  });
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
    [action, setAction] = useState(""),
    [uploading, setUploading] = useState(false);
  const [editorUploading, setEditorUploading] = useState(false);
  const [commentRevision, setCommentRevision] = useState(0);
  const n = names(data, task),
    member = data.members.find((m) => m.user_id === user),
    isAdmin = member?.role === "admin",
    isManager = member?.role === "manager",
    isLeader = isAdmin || isManager,
    canEdit = isLeader || task.creator_id === user,
    acts = taskActions(data, task, user);
  const review = projectReview(
    data.projects.find((p) => p.id === task.project_id),
  );
  // Tasks outside a project keep the default: validation by creator or leader.
  const reviewer = !task.project_id
    ? "o criador ou um gestor"
    : review.approver === "supervisor"
      ? "o supervisor da equipe"
      : "o criador da tarefa";
  const running = currentRunning;
  const isRunning = running?.task_id === task.id;
  const now = useNow(isRunning);
  const totalSeconds = taskTimerSeconds(data.hours, task.id, running, now);
  const clock = formatClock(totalSeconds);
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
          {n.project?.name ?? "Sem projeto"}
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
              <Avatar
                name={n.member?.name ?? "?"}
                src={n.member?.avatar_url}
                size="small"
              />
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
              {durationWithSeconds(totalSeconds)}{" "}
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
            {review.required ? (
              <>
                Validação por {reviewer}:{" "}
                <strong>
                  {task.internal_approved_by ? "aprovada" : "pendente"}
                </strong>
              </>
            ) : (
              <>Este projeto não tem etapa de validação</>
            )}
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
        {!action && (
          <div className="detail-actions">
            {acts.start && (
              <Button
                className="btn primary"
                disabled={busy}
                loading={busy}
                onClick={() => void transition("start")}
              >
                <Check size={15} /> Marcar em andamento
              </Button>
            )}
            {acts.resend && (
              <Button
                className="btn primary"
                disabled={busy}
                loading={busy}
                onClick={() => setAction("start")}
              >
                <Send size={15} /> Enviar novamente
              </Button>
            )}
            {acts.submit && (
              <Button
                className="btn primary"
                disabled={busy || blocked(acts.submit)}
                loading={busy}
                onClick={() =>
                  acts.submitNeedsNote
                    ? setAction("submit")
                    : void transition("submit")
                }
              >
                <Check size={16} />{" "}
                {blocked(acts.submit)
                  ? acts.submit.blocked
                  : review.required
                    ? "Enviar para validação"
                    : "Concluir tarefa"}
              </Button>
            )}
            {acts.approveInternal && (
              <Button
                className="btn primary"
                disabled={busy}
                loading={busy}
                onClick={() => setAction("approve_internal")}
              >
                <Check size={16} /> Aprovar internamente
              </Button>
            )}
            {acts.approveClient && (
              <Button
                className="btn secondary"
                disabled={busy}
                loading={busy}
                onClick={() => setAction("approve_client")}
              >
                Registrar aprovação do cliente
              </Button>
            )}
            {acts.reject && (
              <Button
                className="btn secondary"
                disabled={busy}
                loading={busy}
                onClick={() => setAction("reject")}
              >
                Solicitar ajustes
              </Button>
            )}
            {acts.return && (
              <Button
                className="btn secondary"
                disabled={busy || blocked(acts.return)}
                loading={busy}
                onClick={() => setAction("return")}
              >
                {blocked(acts.return)
                  ? acts.return.blocked
                  : "Devolver ao criador"}
              </Button>
            )}
            {acts.reopen && (
              <Button
                className="btn secondary"
                disabled={busy || blocked(acts.reopen)}
                loading={busy}
                title={blocked(acts.reopen) ? acts.reopen.blocked : undefined}
                onClick={() => setAction("reopen")}
              >
                Reabrir tarefa
              </Button>
            )}
          </div>
        )}
        {blocked(acts.reopen) && (
          <p className="muted action-hint">{acts.reopen.blocked}</p>
        )}
        {action && (
          <form
            className="action-note"
            onSubmit={(e) => {
              e.preventDefault();
              if (editorUploading) return;
              const fd = new FormData(e.currentTarget);
              let note = String(fd.get("note") ?? "");
              const min = action === "approve_client" ? 5 : 3;
              if (richTextPlain(note).length < min) {
                setError(
                  `Escreva ao menos ${min} caracteres no campo "${noteForm[action].label}".`,
                );
                return;
              }
              if (action === "reopen") {
                const kind = fd.get("reopen_kind"),
                  origin = fd.get("reopen_origin");
                if (!kind || !origin) {
                  setError("Responda às duas perguntas da reabertura.");
                  return;
                }
                note = prependParagraphs(note, [
                  `Foi realizado o que foi solicitado? ${
                    kind === "change" ? "Sim (alteração)" : "Não (correção)"
                  }`,
                  `Pedido de quem? ${origin === "client" ? "Cliente" : "Interno"}`,
                ]);
              }
              if (
                ["return", "reject", "reopen"].includes(action) &&
                !window.confirm(noteForm[action].confirm)
              )
                return;
              void transition(action, note);
            }}
          >
            {action === "reopen" && (
              <div className="reopen-questions">
                <fieldset>
                  <legend>Foi realizado o que foi solicitado?</legend>
                  <label className="radio-option">
                    <input type="radio" name="reopen_kind" value="change" />
                    Sim — é uma alteração
                  </label>
                  <label className="radio-option">
                    <input type="radio" name="reopen_kind" value="fix" />
                    Não — é uma correção
                  </label>
                </fieldset>
                <fieldset>
                  <legend>É um pedido do cliente ou um pedido seu?</legend>
                  <label className="radio-option">
                    <input type="radio" name="reopen_origin" value="client" />
                    Cliente
                  </label>
                  <label className="radio-option">
                    <input type="radio" name="reopen_origin" value="internal" />
                    Meu
                  </label>
                </fieldset>
              </div>
            )}
            <Suspense fallback={<Loading compact />}>
              <RichTextEditor
                key={action}
                company={task.company_id}
                demo={demo}
                name="note"
                label={noteForm[action].label}
                disabled={busy}
                onUploading={setEditorUploading}
              />
            </Suspense>
            <small>
              Este texto também será publicado nos comentários da tarefa.
            </small>
            <div className="form-footer">
              <Button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setAction("");
                  setError("");
                }}
              >
                Cancelar
              </Button>
              <Button
                className="btn primary"
                disabled={busy || editorUploading}
                loading={busy || editorUploading}
              >
                {noteForm[action].submit}
              </Button>
            </div>
          </form>
        )}
        <div className="detail-tabs">
          {[
            { id: "comments", label: "Comentários", icon: MessageSquare },
            { id: "files", label: "Arquivos", icon: Paperclip },
            ...(n.client
              ? [{ id: "drive", label: "Drive", icon: HardDrive }]
              : []),
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
                src={data.members.find((m) => m.user_id === user)?.avatar_url}
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
                    src={
                      data.members.find((m) => m.user_id === c.author_id)
                        ?.avatar_url
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
        ) : tab === "drive" && n.client ? (
          <TaskDrive
            root={{ client: n.client.id }}
            demo={demo}
            data={data}
            company={task.company_id}
            user={user}
            isLeader={isLeader}
            notify={notify}
          />
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
                    {e.action === "submit" && e.detail.to === "done"
                      ? "Tarefa concluída"
                      : e.action === "start" && e.detail.from === "returned"
                        ? "Reenviada ao responsável"
                        : ((
                            {
                              created: "Tarefa criada",
                              start: "Trabalho iniciado",
                              submit: "Enviada para validação",
                              return: "Devolvida ao criador",
                              reject: "Reprovada na validação",
                              approve_internal: "Aprovada na validação",
                              approve_client: "Aprovação do cliente registrada",
                              reopen: "Tarefa reaberta",
                              edited: "Tarefa editada",
                            } as Record<string, string>
                          )[e.action] ?? e.action)}
                  </strong>
                  <small>
                    {new Date(e.created_at).toLocaleString("pt-BR")}
                  </small>
                  {!!e.detail.note && (
                    <RichTextContent value={String(e.detail.note)} />
                  )}
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
