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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  CalendarDays,
  Check,
  CircleDot,
  Download,
  Flag,
  ListChecks,
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
  ChevronsLeft,
  ChevronsRight,
  UserRoundPen,
  Users,
  Eye,
  Reply,
  Repeat,
  CircleX,
  Pencil,
  X,
  Minus,
  ArrowUpRight,
  ChevronRight,
} from "lucide-react";
import { Modal, Avatar, Empty, Loading } from "./components";
import {
  type Snapshot,
  type Task,
  type Comment,
  type Attachment,
  type TaskEvent,
  type TaskRecurrence,
  type TaskChecklist,
  type ProjectApprover,
  type Status,
  priorities,
  recurrenceFrequencies,
  statuses,
  workingStatuses,
} from "./types";
import {
  canApproveTask,
  canCreateTaskIn,
  canTimeTask,
  contractOpen,
  contractProductLabel,
  dateLabel,
  defaultContractName,
  isLate,
  duration,
  names,
  formatClock,
  projectReview,
  shortSpan,
  statusDurations,
  suggestedAssignee,
  taskActions,
  type BlockedAction,
} from "./domain";
import { StatusMenu, StatusPill, type StatusChoice } from "./StatusMenu";
import { useTaskSeconds } from "./useTaskTime";
import { supabase } from "./supabase";
import {
  rpc,
  taskExtras,
  invalidateTaskExtras,
  checklistHistory,
} from "./api";
import { TaskChecklistPanel } from "./TaskChecklist";
import {
  checklistGateMessage,
  checklistLogLabel,
  openChecklistItems,
} from "./checklist";
import { getGcsPublicUrl } from "./gcs";
import type { DemoStore } from "./demo-store";
import { RichTextContent } from "./RichTextContent";
import {
  AudioCard,
  RecordingPreview,
  TaskAudioList,
  useTaskAudios,
} from "./TaskAudios";
import { AudioRecorder, type Recording } from "./AudioRecorder";
import type { TaskUnsaved } from "./TaskTray";
import { AudioPlayer } from "./AudioPlayer";
import { formatBytes } from "./drive";
import {
  addAudioComment,
  audioTranscripts,
  deleteAudio,
  editAudioTranscript,
  processAudio,
  uploadRecordedAudio,
  type TaskAudio,
} from "./task-audio";
import {
  parseDescription,
  richTextPlain,
  serializeDescription,
} from "./rich-text";
import { commentThreads, replyRoot } from "./comment-threads";
import { ContractPicker } from "./ContractPicker";
import { TaskDrive } from "./DrivePage";
import { TeamPicker } from "./TeamPicker";
import { ReviewSettings } from "./ReviewSettings";
import { ATTACHMENT_HINT, uploadAttachment } from "./attachments";
import { attachmentType } from "./upload-types";
import { FileViewer } from "./FileViewer";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import { TaskCustomFieldsPanel } from "./CustomFieldsForm";
import { postOfTask, taskPostPath, type TaskPost } from "./social-leads-task";
import { SL_MODULES } from "./social-leads-module";
import { navigate, routeParts } from "./router";
import { canOpenPage } from "./modules";
import { CopilotBadge, TaskCopilot, useCopilotFeedback } from "./TaskCopilot";
import { TaskDueEdit } from "./DueRuleHint";
import { DueRiskNote, ReplanModal } from "./DueAssist";
import { TaskDueValue } from "./TaskDueChange";
import { TaskPriorityValue } from "./TaskPriority";
import {
  PRIORITY_RULE,
  mayPrioritize,
  canSetPriority,
  isPrioritized,
} from "./task-priority";
import { dueSources } from "./task-due";
import { canManageDueScope } from "./dueRules";
import { MIN_REVIEW, copilotExtras, useTaskCopilot } from "./copilot";
const RichTextEditor = lazy(() => import("./RichTextEditor"));
type Mutate = (name: string, args: Record<string, unknown>) => Promise<any>;
export type FormPreset = {
  client?: string;
  product?: string;
  contract?: string;
  project?: string;
  team?: string;
  /** New task only: prefilled from a recording's next steps. */
  title?: string;
  description?: string;
  due?: string;
  /** New task only (a MAVI proposal): who and how urgent. */
  assignee?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  /** New task only: called with the id once the task is saved. */
  onCreated?: (task: string) => void;
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
        : (data.contracts.find((c) => contractOpen(data, c))?.id ?? ""),
    ),
    [error, setError] = useState("");
  // Archived clients take no new products.
  const openClients = data.clients.filter((c) => !c.archived);
  const [linkClient, setLinkClient] = useState(
    preset.client ?? openClients[0]?.id ?? "",
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
                    {!openClients.length && (
                      <SelectOption value="">
                        Cadastre um cliente primeiro
                      </SelectOption>
                    )}
                    {openClients.map((c) => (
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
const PANEL_KEY = "mavi:task-panel";
const statusLabel = (value: unknown) =>
  statuses[value as Status]?.label ?? String(value);
const priorityLabel = (value: unknown) =>
  priorities[value as Task["priority"]] ?? String(value);
/** How the history names each event, old linear-flow actions included. */
function eventLabel(e: TaskEvent) {
  const { from, to } = e.detail;
  // Alterações em massa (lista de tarefas): o prazo, e o desfazer do lote.
  if (e.action === "due_changed")
    return `Prazo alterado · ${dateLabel(String(e.detail.old_due))} → ${dateLabel(String(e.detail.new_due))}`;
  if (e.action === "bulk_undone") return "Alteração em massa desfeita";
  // Checklist (migração 20270220090000): o principal do registro dele.
  if (e.action === "checklist")
    return checklistLogLabel({ action: String(e.detail.kind), detail: e.detail });
  // Prioridades (migração 20270130090000): quem mudou vai na linha de baixo.
  if (e.action === "priority")
    return e.detail.system
      ? `Prioridade ajustada pela regra de prioridades · ${priorityLabel(from)} → ${priorityLabel(to)}`
      : `Prioridade · ${priorityLabel(from)} → ${priorityLabel(to)}`;
  // Editar tarefa: o cliente (produto contratado) trocado.
  if (e.action === "edited" && e.detail.new_client)
    return `Cliente alterado · ${String(e.detail.old_client)} (${String(e.detail.old_product)}) → ${String(e.detail.new_client)} (${String(e.detail.new_product)})`;
  // Prazo padrão: antes do mínimo da regra (com o motivo), e a subtarefa
  // que empurrou o prazo da principal.
  if (e.action === "due_below_minimum")
    return `Prazo antes do mínimo da regra (${dateLabel(String(e.detail.min))}) · ${String(e.detail.reason ?? "")}`;
  if (e.action === "due_extended_by_subtask")
    return `Prazo acompanhou a subtarefa “${String(e.detail.title ?? "")}” · ${dateLabel(String(e.detail.old_due))} → ${dateLabel(String(e.detail.new_due))}`;
  if (to === "done" && from !== "done") return "Tarefa entregue";
  if (e.action === "move")
    return from === to ? "Responsável alterado" : `Status: ${statusLabel(to)}`;
  if (e.action === "reopen") return `Tarefa reaberta · ${statusLabel(to)}`;
  if (e.action === "attachment_deleted")
    return `Anexo excluído · ${String(e.detail.name ?? "")}`;
  if (e.action === "start" && from === "returned")
    return "Reenviada ao responsável";
  if (e.action === "recurrence_started")
    return `Repetição programada · ${recurrenceFrequencies[e.detail.frequency as keyof typeof recurrenceFrequencies] ?? ""}`;
  if (e.action === "created" && e.detail.recurrence)
    return "Tarefa aberta pela repetição";
  return (
    (
      {
        created: "Tarefa criada",
        start: "Trabalho iniciado",
        submit: "Enviada para validação",
        return: "Devolvida ao criador",
        reject: "Reprovada na validação",
        approve_internal: "Aprovada na validação",
        approve_client: "Aprovação do cliente registrada",
        edited: "Tarefa editada",
        recurrence_stopped: "Repetição cancelada",
      } as Record<string, string>
    )[e.action] ?? e.action
  );
}
/**
 * A task's repetition in its details: how often, when the next copy opens
 * and, for whoever set it up or a leader, a button to cancel it (confirmed;
 * the copies already opened stay).
 */
function RecurrenceRow({
  recurrence,
  canStop,
  busy,
  onStop,
}: {
  recurrence: TaskRecurrence;
  canStop: boolean;
  busy: boolean;
  onStop: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="property-row">
      <span className="property-label">
        <Repeat size={15} /> Repetição
      </span>
      <div className="property-value recurrence-value">
        <span>
          {recurrenceFrequencies[recurrence.frequency]}
          {recurrence.active ? (
            <small> · próxima em {dateLabel(recurrence.next_run)}</small>
          ) : (
            <small> · cancelada</small>
          )}
        </span>
        {recurrence.active && recurrence.last_error && (
          <small className="late" title={recurrence.last_error}>
            A última cópia não abriu: {recurrence.last_error}
          </small>
        )}
        {recurrence.active &&
          canStop &&
          (confirming ? (
            <div className="recurrence-confirm" role="alertdialog">
              <small>
                Nenhuma nova cópia será aberta. As tarefas já abertas continuam.
              </small>
              <span>
                <Button
                  type="button"
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  Voltar
                </Button>
                <Button
                  type="button"
                  className="btn danger"
                  loading={busy}
                  onClick={() => onStop().finally(() => setConfirming(false))}
                >
                  Cancelar repetição
                </Button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="recurrence-cancel"
              onClick={() => setConfirming(true)}
            >
              <CircleX size={14} /> Cancelar repetição
            </button>
          ))}
      </div>
    </div>
  );
}
const blocked = (value: unknown): value is BlockedAction =>
  typeof value === "object" && value !== null && "blocked" in value;
/**
 * The note field of each action: its label, the shortest note accepted (0 =
 * optional) and the submit label. Moves ask for the missing information
 * (Devolvida) or the requested change (Alteração); the rest is optional.
 */
function noteForm(action: string, target: Status | null, current: Status) {
  if (action === "approve_internal")
    return {
      label: "Observações da validação",
      min: 3,
      submit: "Aprovar entrega",
    };
  if (action === "approve_client")
    return {
      label: "Quem aprovou, quando e por qual meio?",
      min: 5,
      submit: "Registrar aprovação",
    };
  if (action === "reopen")
    return {
      label: "Descreva o motivo da reabertura",
      min: 3,
      submit: "Confirmar reabertura",
    };
  if (!target || target === current)
    return {
      label: "Comentário (opcional)",
      min: 0,
      submit: "Trocar responsável",
    };
  if (target === "returned")
    return {
      label: "Quais informações faltam?",
      min: 3,
      submit: "Mover para Devolvida",
    };
  if (target === "rejected")
    return {
      label: "O que precisa ser alterado?",
      min: 3,
      submit: "Mover para Alteração",
    };
  if (target === "correction")
    return {
      label: "O que precisa ser corrigido?",
      min: 3,
      submit: "Mover para Correção",
    };
  return {
    label: "Comentário (opcional)",
    min: 0,
    submit:
      target === "done"
        ? "Entregar tarefa"
        : `Mover para ${statuses[target].label}`,
  };
}
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
  runningTimers,
  multiTimer,
  data,
  user,
  busy,
  demo,
  demoStore,
  refresh: liveRefresh,
  mutate,
  onClose,
  notify,
  hidden = false,
  onMinimize,
  initialComment,
  onUnsaved,
  onCommentDraft,
}: {
  task: Task;
  /** The person's running timers (several with Várias tarefas ao mesmo tempo). */
  runningTimers: import("./types").TimeEntry[];
  /** Starting this one leaves the others running. */
  multiTimer: boolean;
  data: Snapshot;
  user: string;
  busy: boolean;
  demo: boolean;
  demoStore: DemoStore;
  refresh: number;
  mutate: Mutate;
  onClose: () => void;
  notify: (s: string) => void;
  /** Minimizada no rodapé: fica montada, escondida, com o que estava sendo feito. */
  hidden?: boolean;
  onMinimize?: () => void;
  /** O comentário em rascunho guardado no rodapé (TaskTray). */
  initialComment?: string;
  /** O que há por enviar (comentário, edição, mudança de status, áudio). */
  onUnsaved?: (state: TaskUnsaved) => void;
  /** O comentário a cada mudança ("" depois de enviado). */
  onCommentDraft?: (value: string) => void;
}) {
  // Escondida, não recarrega a cada aviso ao vivo; ao voltar, busca tudo de
  // novo uma vez (comentários e histórico podem ter chegado nesse meio tempo).
  const shownRefresh = useRef(liveRefresh);
  if (!hidden) shownRefresh.current = liveRefresh;
  const refresh = shownRefresh.current;
  const [tab, setTab] = useState("comments"),
    [extras, setExtras] = useState<{
      comments: Comment[];
      attachments: Attachment[];
      events: TaskEvent[];
      recurrence?: TaskRecurrence | null;
      /** Da descrição e dos comentários (migration task_audio). */
      audios?: TaskAudio[];
      /** Os checklists da tarefa (migration task_checklists). */
      checklists?: TaskChecklist[];
    }>({ comments: [], attachments: [], events: [] }),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [editing, setEditing] = useState(false),
    [localRefresh, setLocalRefresh] = useState(0),
    [action, setAction] = useState(""),
    // Where a move or reopening takes the task (its status, for reassigning).
    [target, setTarget] = useState<Status | null>(null),
    [uploading, setUploading] = useState(false),
    [uploadProgress, setUploadProgress] = useState("");
  const [editorUploading, setEditorUploading] = useState(false);
  const [commentRevision, setCommentRevision] = useState(0);
  // The audio recorded in the comment composer, until it is sent.
  const [commentAudio, setCommentAudio] = useState<Recording | null>(null);
  const [commentRecording, setCommentRecording] = useState(false);
  const [sendingAudio, setSendingAudio] = useState(false);
  // The comment kept from the tray, only for the composer's first editor.
  const [savedComment] = useState(initialComment);
  const [commentFilled, setCommentFilled] = useState(!!initialComment);
  // Recording a description audio (while editing).
  const [descRecording, setDescRecording] = useState(false);
  // Assistente MAVI na edição: confere só o que a pessoa mudar.
  const [editTitle, setEditTitle] = useState(task.title);
  // The count of the due rule starts at the start date being edited.
  const [editStart, setEditStart] = useState<string | null>(null);
  // Trocar o cliente (produto contratado) e o projeto dele; as subtarefas
  // seguem a principal (public.update_task).
  const [editContract, setEditContract] = useState(task.contract_id);
  const [editProject, setEditProject] = useState(task.project_id ?? "");
  // Prazos (Fase 4): replanning the assignee's tasks from the risk warning.
  const [replanning, setReplanning] = useState(false);
  const canReplan = canManageDueScope(data, user, {
    project_id: null,
    client_id: null,
    team_id: null,
    user_id: task.assignee_id,
  });
  const [editText, setEditText] = useState<string | null>(null);
  const appendToDescription = useRef<((text: string) => void) | null>(null);
  // Áudios da descrição: cada gravação entra na tarefa na hora (quem edita
  // a tarefa grava, corrige a transcrição e tira).
  const audio = useTaskAudios({
    company: task.company_id,
    task: task.id,
    audios: extras.audios,
    onChanged: () => {
      invalidateTaskExtras(task.id);
      setLocalRefresh((v) => v + 1);
    },
    onError: setError,
  });
  const descriptionAudios = audio.items;
  const copilotOn =
    editing &&
    editText !== null &&
    !data.members
      .find((m) => m.user_id === user)
      ?.hidden_pages?.includes("assistant");
  const copilot = useTaskCopilot(
    {
      company: task.company_id,
      contract: editContract,
      task: task.id,
      title: editTitle,
      description: editText ?? "",
      audio: audioTranscripts(descriptionAudios),
      due: task.due_date,
      ...copilotExtras(data, {
        assignee: task.assignee_id,
        parent: task.parent_id,
        task: task.id,
        files: extras.attachments.map((a) => a.name),
        fields: task.custom_fields,
      }),
    },
    copilotOn,
    demo,
    true,
  );
  const copilotFeedback = useCopilotFeedback(copilot, {
    company: task.company_id,
    contract: task.contract_id,
    task: task.id,
    title: editTitle,
    demo,
  });
  // The comment being answered from the composer.
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const composer = useRef<HTMLFormElement>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  // An art task from Social Leads ("Liberar produção") opens its post.
  const [slPost, setSlPost] = useState<TaskPost | null>(null);
  useEffect(() => {
    let alive = true;
    setSlPost(null);
    if (!demo && task.contract_id)
      void postOfTask(task.id).then((p) => {
        if (alive) setSlPost(p);
      });
    return () => {
      alive = false;
    };
  }, [task.id, task.contract_id, demo]);
  const n = names(data, task),
    member = data.members.find((m) => m.user_id === user),
    isAdmin = member?.role === "admin",
    isManager = member?.role === "manager",
    isLeader = isAdmin || isManager,
    canEdit = isLeader || task.creator_id === user,
    acts = taskActions(data, task, user),
    creator = data.members.find((m) => m.user_id === task.creator_id);
  // Subtasks stay in their main task's client; a Social Leads post's task in
  // its plan's client (public.update_task says the same).
  const clientLocked = task.parent_id
    ? "Subtarefa fica no cliente da tarefa principal. Para trocar, edite a principal."
    : slPost
      ? "Tarefa de post do Social Leads fica no cliente do plano."
      : "";
  const movedClient = !clientLocked && editContract !== task.contract_id;
  const hasSubtasks = data.tasks.some((t) => t.parent_id === task.id);
  const review = projectReview(
    data.projects.find((p) => p.id === task.project_id),
  );
  // Tasks outside a project keep the default: validation by creator or leader.
  const usualReviewer = !task.project_id
    ? "pelo criador ou por um gestor"
    : review.approver === "supervisor"
      ? "pelo supervisor da equipe"
      : "pelo criador da tarefa";
  // In validation, whoever is responsible for it validates it too.
  const validator =
    task.status === "review" && !canApproveTask(data, task, task.assignee_id)
      ? data.members.find((m) => m.user_id === task.assignee_id)?.name
      : undefined;
  const reviewer = validator
    ? `por ${validator}, ${usualReviewer}`
    : usualReviewer;
  // Side panel (comments, history, files, Drive): the open/closed choice is
  // a per-viewer convenience kept in the browser.
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return localStorage.getItem(PANEL_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  function togglePanel(open: boolean) {
    setPanelOpen(open);
    try {
      localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
    } catch {
      // Blocked storage: the choice just won't persist.
    }
  }
  const openItems = openChecklistItems(extras.checklists);
  // Com "Só entregar com o checklist concluído", Em validação e Entregue
  // esperam os itens (mavi_private.checklist_gate diz o mesmo).
  const checklistGate =
    task.checklist_required && openItems > 0
      ? checklistGateMessage(openItems)
      : undefined;
  /** A checklist function: demo store or database; the panel gets the lists. */
  async function runChecklist(name: string, args: Record<string, unknown>) {
    const lists = (
      demo ? demoStore.mutate(name, args) : await rpc(name, args)
    ) as TaskChecklist[];
    invalidateTaskExtras(task.id);
    setExtras((x) => ({ ...x, checklists: lists }));
    // The Histórico picks up what was recorded.
    if (demo) setLocalRefresh((v) => v + 1);
    return lists;
  }
  const loadChecklistHistory = useCallback(
    () =>
      demo
        ? Promise.resolve(
            demoStore.checklistLog.filter((e) => e.task_id === task.id),
          )
        : checklistHistory(task.id),
    [demo, demoStore, task.id],
  );
  const panels = [
    {
      id: "comments",
      label: "Comentários",
      icon: MessageSquare,
      count: extras.comments.length,
    },
    // Itens em aberto, como na entrega exigida.
    { id: "checklist", label: "Checklist", icon: ListChecks, count: openItems },
    { id: "activity", label: "Histórico", icon: History, count: 0 },
    {
      id: "files",
      label: "Arquivos",
      icon: Paperclip,
      count: extras.attachments.length,
    },
    ...(n.client
      ? [{ id: "drive", label: "Drive do cliente", icon: HardDrive, count: 0 }]
      : []),
  ];
  const current = panels.find((p) => p.id === tab) ?? panels[0];
  // Comments read like a chat: newest at the bottom, next to the composer.
  const sideBody = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sideBody.current;
    if (el && tab === "comments") el.scrollTop = el.scrollHeight;
  }, [tab, panelOpen, loading, extras.comments.length]);
  // The person's timer on this task, and whether one runs on another.
  const running = runningTimers.find((e) => e.task_id === task.id) ?? null;
  const isRunning = !!running;
  const runsElsewhere = runningTimers.some((e) => e.task_id !== task.id);
  // A delivered task hides the button; a clock still running can be stopped.
  const showPlay = isRunning || task.status !== "done";
  // No play (and no description blur) while the task waits on validation, was
  // returned or delivered, or for its creator — unless the creator is doing it.
  const canPlay = canTimeTask(task, user);
  const totalSeconds = useTaskSeconds({
    company: task.company_id,
    taskId: task.id,
    hours: data.hours,
    running,
    demo,
  });
  const clock = formatClock(totalSeconds);
  const timeRatio =
    task.estimated_minutes > 0 ? totalSeconds / 60 / task.estimated_minutes : 0;
  const late = Boolean(task.due_date) && isLate(task);
  useEffect(() => {
    let alive = true;
    if (demo) {
      setExtras({
        comments: demoStore.comments.filter((c) => c.task_id === task.id),
        attachments: [],
        // O principal do registro do checklist entra no histórico, como em
        // public.task_extras.
        events: [
          ...demoStore.events.filter((e) => e.task_id === task.id),
          ...demoStore.checklistLog
            .filter(
              (e) =>
                e.task_id === task.id &&
                !["item_added", "item_edited", "checklist_renamed"].includes(
                  e.action,
                ),
            )
            .map((e) => ({
              ...e,
              action: "checklist",
              detail: { ...e.detail, kind: e.action },
            })),
        ].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        checklists: demoStore.checklistsOf(task.id),
        recurrence: demoStore.recurrences.find(
          (r) => r.id === task.recurrence_id,
        ),
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
  const wasHidden = useRef(hidden);
  useEffect(() => {
    if (wasHidden.current && !hidden) {
      invalidateTaskExtras(task.id);
      setLocalRefresh((v) => v + 1);
    }
    wasHidden.current = hidden;
  }, [hidden, task.id]);
  const unsavedListener = useRef(onUnsaved);
  unsavedListener.current = onUnsaved;
  const dirty =
    editing || !!action || commentFilled || !!commentAudio || commentRecording;
  const recording = commentRecording || (editing && descRecording);
  useEffect(() => {
    unsavedListener.current?.({ dirty: dirty || recording, recording });
  }, [dirty, recording]);
  const durations = useMemo(
    () => statusDurations(task, extras.events),
    // Recomputed when the task or its history changes, not on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [task.status, task.status_changed_at, task.created_at, extras.events],
  );
  const activeMembers = data.members.filter((m) => m.active);
  // Who can be mentioned with "@": any active person of the company (a
  // mention makes them a participant, so they can open the task).
  const mentionPeople = useMemo(
    () =>
      activeMembers
        .filter((m) => m.user_id !== user)
        .map((m) => ({ id: m.user_id, label: m.name, avatar: m.avatar_url })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.members, user],
  );
  // Past assignees and people mentioned, besides the current assignee.
  const participants = (task.participant_ids ?? [])
    .filter((id) => id !== task.assignee_id)
    .map((id) => data.members.find((m) => m.user_id === id))
    .filter((m): m is NonNullable<typeof m> => !!m);
  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Usuário removido";
  const moveHint =
    "Somente o responsável, o criador, o supervisor da equipe do responsável ou um gestor muda o status";
  const statusChoices: StatusChoice[] = [
    ...workingStatuses.map((status) => ({
      status,
      disabled:
        task.status === "done"
          ? acts.reopen === true
            ? undefined
            : blocked(acts.reopen)
              ? acts.reopen.blocked
              : "Sem permissão para reabrir"
          : acts.move
            ? status === "review" && task.status !== "review"
              ? checklistGate
              : undefined
            : moveHint,
    })),
    {
      status: "done" as Status,
      disabled:
        task.status === "done"
          ? undefined
          : acts.approveInternal || acts.deliver
          ? checklistGate
          : review.required
            ? task.status === "review" && task.internal_approved_by
              ? "Aguardando a aprovação do cliente"
              : `A entrega é aprovada ${reviewer}, com a tarefa em validação`
            : moveHint,
    },
  ];
  // The form opens below the description: bring it into view and focus
  // its first field.
  const actionForm = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const form = actionForm.current;
    if (!action || !form) return;
    form.scrollIntoView({ block: "nearest", behavior: "smooth" });
    form
      .querySelector<HTMLElement>("button, [contenteditable=true]")
      ?.focus({ preventScroll: true });
  }, [action, target]);
  function pickStatus(next: Status) {
    setError("");
    if (checklistGate && next !== task.status && (next === "review" || next === "done")) {
      setError(checklistGate);
      setTab("checklist");
      togglePanel(true);
      return;
    }
    if (next === "done") {
      if (task.status === "done") return;
      // Whoever created the task for themselves just delivers it.
      const ownTask = task.creator_id === user && task.assignee_id === user;
      if (acts.approveInternal && !ownTask) {
        setTarget(null);
        setAction("approve_internal");
        return;
      }
    }
    setTarget(next);
    setAction(task.status === "done" ? "reopen" : "move");
  }
  async function transition(
    value: string,
    message = "",
    move: { p_status?: Status | null; p_assignee?: string | null } = {},
  ) {
    try {
      setError("");
      await mutate("transition_task", {
        p_task: task.id,
        p_version: task.version,
        p_action: value,
        p_note: message,
        ...move,
      });
      setAction("");
      setTarget(null);
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
    if (editorUploading || sendingAudio) return;
    const form = e.currentTarget,
      body = String(new FormData(form).get("body") ?? "").trim();
    if (commentRecording) {
      setError("Termine a gravação: use o áudio ou descarte antes de enviar.");
      return;
    }
    if (commentAudio) {
      void sendAudioComment(form, richTextPlain(body) ? body : "");
      return;
    }
    if (!body) return;
    try {
      const result = await mutate("add_comment", {
        p_task: task.id,
        p_body: body,
        // Sent only for replies: plain comments keep the original call.
        ...(replyTo ? { p_parent: replyRoot(replyTo) } : {}),
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
      setReplyTo(null);
      setCommentRevision((v) => v + 1);
      setCommentFilled(false);
      onCommentDraft?.("");
      setLocalRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // A comment with audio: the recording goes up as a draft, becomes the
  // comment and then the MAVI transcribes it (everyone sees it arrive).
  async function sendAudioComment(form: HTMLFormElement, body: string) {
    if (!commentAudio) return;
    setSendingAudio(true);
    setError("");
    try {
      const a = await uploadRecordedAudio(
        task.company_id,
        "comment",
        commentAudio.blob,
        commentAudio.mime,
        commentAudio.seconds,
      );
      const result = (await addAudioComment(
        task.id,
        body,
        replyTo ? replyRoot(replyTo) : null,
        a.id,
      )) as Comment;
      setExtras((x) => ({
        ...x,
        comments: [result, ...x.comments],
        audios: [
          ...(x.audios ?? []),
          { ...a, task_id: task.id, comment_id: result.id },
        ],
      }));
      setCommentAudio(null);
      form.reset();
      setReplyTo(null);
      setCommentRevision((v) => v + 1);
      setCommentFilled(false);
      onCommentDraft?.("");
      void processAudio(a.id)
        .catch(() => {})
        .finally(refreshExtras);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSendingAudio(false);
    }
  }
  function refreshExtras() {
    invalidateTaskExtras(task.id);
    setLocalRefresh((v) => v + 1);
  }
  function commentAudios(c: Comment) {
    const own = (extras.audios ?? []).filter((a) => a.comment_id === c.id);
    const mayManage = c.author_id === user || isLeader;
    return own.map((a) => (
      <AudioCard
        key={a.id}
        audio={a}
        label="áudio do comentário"
        variant="comment"
        canManage={mayManage}
        nameOf={memberName}
        onRetry={() => {
          setExtras((x) => ({
            ...x,
            audios: (x.audios ?? []).map((y) =>
              y.id === a.id
                ? { ...y, status: "transcribing", status_at: new Date().toISOString(), error: null }
                : y,
            ),
          }));
          void processAudio(a.id)
            .catch((e) => setError((e as Error).message))
            .finally(refreshExtras);
        }}
        onEdit={async (text) => {
          try {
            await editAudioTranscript(a.id, text);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            refreshExtras();
          }
        }}
        onDelete={async () => {
          try {
            await deleteAudio(a.id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            refreshExtras();
          }
        }}
      />
    ));
  }
  function startReply(c: Comment) {
    setReplyTo(c);
    composer.current
      ?.querySelector<HTMLElement>("[contenteditable=true]")
      ?.focus();
  }
  function commentItem(c: Comment, orphan = false) {
    const author = data.members.find((m) => m.user_id === c.author_id);
    return (
      <article
        key={c.id}
        className={replyTo?.id === c.id ? "replying" : undefined}
      >
        <Avatar
          name={author?.name ?? "Usuário"}
          src={author?.avatar_url}
          size="small"
          person={author?.user_id}
        />
        <div>
          <strong>
            <span data-person={author?.user_id}>{author?.name}</span>
            <small>{new Date(c.created_at).toLocaleString("pt-BR")}</small>
          </strong>
          {orphan && (
            <span className="comment-context">
              <Reply size={12} /> Em resposta a um comentário anterior
            </span>
          )}
          {c.body.trim() && <RichTextContent value={c.body} />}
          {commentAudios(c)}
          <button
            type="button"
            className="comment-reply"
            onClick={() => startReply(c)}
            disabled={busy}
          >
            <Reply size={13} /> Responder
          </button>
        </div>
      </article>
    );
  }
  async function edit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (editorUploading || !canEdit) return;
    const fd = new FormData(e.currentTarget);
    try {
      await mutate("update_task", {
        p_task: task.id,
        p_version: task.version,
        p_title: fd.get("title"),
        p_description: fd.get("description"),
        p_due: fd.get("due"),
        // "Aplicar" the rule: the database counts the date and it follows the rule.
        p_due_manual: fd.get("due_rule") === "1" ? false : null,
        p_due_reason: String(fd.get("due_reason") ?? "").trim() || null,
        // "Usar" the MAVI's date: the database counts it again.
        p_due_smart: fd.get("due_smart") === "1" ? true : null,
        p_due_effort: String(fd.get("due_effort") ?? "") || null,
        p_start: fd.get("start_date") || null,
        p_estimated: Number(fd.get("estimated")) * 60,
        p_priority: fd.get("priority"),
        // Only when it changes: the database moves the subtasks along.
        ...(movedClient && {
          p_contract: editContract,
          p_project: editProject || null,
        }),
      });
      setEditing(false);
      if (movedClient) notify("Cliente da tarefa alterado.");
      copilotFeedback.flush(
        task.company_id,
        data.contracts.find((c) => c.id === editContract)?.client_id ??
          null,
        task.id,
      );
      invalidateTaskExtras(task.id);
      setLocalRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  // One after the other; a file that fails doesn't stop the rest.
  async function upload(files: File[]) {
    if (!supabase || demo || !files.length) return;
    setUploading(true);
    setError("");
    const failed: string[] = [];
    let sent = 0;
    for (const [i, file] of files.entries()) {
      setUploadProgress(files.length > 1 ? `${i + 1} de ${files.length}` : "");
      try {
        await uploadAttachment(task.id, file);
        sent++;
      } catch (e) {
        failed.push((e as Error).message);
      }
    }
    invalidateTaskExtras(task.id);
    setLocalRefresh((v) => v + 1);
    setUploading(false);
    setUploadProgress("");
    if (failed.length) setError(failed.join(" "));
    if (sent)
      notify(sent === 1 ? "Arquivo anexado." : `${sent} arquivos anexados.`);
  }
  // Files dropped anywhere on the task become attachments; the panel opens
  // on Anexos to show them arriving.
  const drop = useFileDrop((files) => {
    setTab("files");
    setPanelOpen(true);
    void upload(files);
  }, !demo && !uploading);
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
      hidden={hidden}
      actions={
        onMinimize && (
          <button
            type="button"
            className="icon-btn modal-head-action"
            onClick={onMinimize}
            aria-label="Minimizar"
            title="Minimizar: a tarefa fica no rodapé enquanto você navega pelo sistema"
          >
            <Minus size={20} />
          </button>
        )
      }
    >
      <div
        className={`task-detail task-workspace${panelOpen ? "" : " panel-collapsed"}`}
        data-panel={tab}
        {...drop.handlers}
      >
        {drop.active && (
          <DropOverlay
            label="Solte para anexar à tarefa"
            hint={ATTACHMENT_HINT}
          />
        )}
        <div className="task-main">
          <div className="detail-breadcrumb">
            {n.client?.name}
            <span>/</span>
            {n.product?.name}
            <span>/</span>
            {n.project?.name ?? "Sem projeto"}
          </div>
          {isPrioritized(task.priority) && (
            <span
              className={`priority-banner priority-tag-${task.priority}`}
              role="note"
            >
              <Flag size={13} fill="currentColor" aria-hidden="true" />
              Prioridade {priorities[task.priority]}
            </span>
          )}
          <div className="detail-title">
            <h2>{task.title}</h2>
            <div className="detail-title-actions">
              {/* Whoever created the task (or a leader) edits it any time,
                  without starting the timer first. */}
              {canEdit && !editing && (
                <button
                  type="button"
                  className="share-task edit-task"
                  title="Editar tarefa"
                  onClick={() => {
                    setEditTitle(task.title);
                    setEditText(null);
                    setEditStart(null);
                    setEditContract(task.contract_id);
                    setEditProject(task.project_id ?? "");
                    setEditing(true);
                  }}
                >
                  <Pencil size={15} /> <span>Editar</span>
                </button>
              )}
              <button
                type="button"
                className="share-task"
                title="Copiar link da tarefa"
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
                <Copy size={15} /> <span>Copiar link</span>
              </button>
            </div>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <DueRiskNote
            task={task}
            data={data}
            demo={demo}
            refresh={refresh}
            onReplan={canReplan ? () => setReplanning(true) : undefined}
          />
          {replanning && (
            <ReplanModal
              company={task.company_id}
              user={task.assignee_id}
              data={data}
              demo={demo}
              mutate={mutate}
              notify={notify}
              onClose={() => setReplanning(false)}
            />
          )}
          <div className="task-properties">
            <div className="property-group">
              <div className="property-row">
                <span className="property-label">
                  <CircleDot size={15} /> Status
                </span>
                <div className="property-value">
                  <StatusMenu
                    current={task.status}
                    choices={statusChoices}
                    durations={durations}
                    onPick={pickStatus}
                  />
                  {durations[task.status] ? (
                    <small>há {shortSpan(durations[task.status]!)}</small>
                  ) : null}
                </div>
              </div>
              <div className="property-row">
                <span className="property-label">
                  <CalendarDays size={15} /> Prazo
                </span>
                <TaskDueValue
                  task={task}
                  data={data}
                  user={user}
                  late={late}
                  mutate={mutate}
                  notify={notify}
                />
              </div>
              <div className="property-row">
                <span className="property-label">
                  <Flag size={15} /> Prioridade
                </span>
                <TaskPriorityValue
                  task={task}
                  data={data}
                  user={user}
                  mutate={mutate}
                  notify={notify}
                />
              </div>
              {extras.recurrence && (
                <RecurrenceRow
                  recurrence={extras.recurrence}
                  canStop={isLeader || extras.recurrence.creator_id === user}
                  busy={busy}
                  onStop={() =>
                    mutate("stop_task_recurrence", { p_task: task.id }).then(
                      () => setLocalRefresh((v) => v + 1),
                    )
                  }
                />
              )}
            </div>
            <div className="property-group">
              <div className="property-row">
                <span className="property-label">
                  <UserRound size={15} /> Responsável
                </span>
                <div className="property-value">
                  {acts.move ? (
                    <button
                      type="button"
                      className="property-button"
                      title="Trocar responsável"
                      onClick={() => pickStatus(task.status)}
                    >
                      <Avatar
                        name={n.member?.name ?? "?"}
                        src={n.member?.avatar_url}
                        size="small"
                        person={n.member?.user_id}
                      />
                      {n.member?.name}
                      <UserRoundPen size={14} />
                    </button>
                  ) : (
                    <span className="property-person" data-person={n.member?.user_id}>
                      <Avatar
                        name={n.member?.name ?? "?"}
                        src={n.member?.avatar_url}
                        size="small"
                      />
                      {n.member?.name}
                    </span>
                  )}
                </div>
              </div>
              <div className="property-row">
                <span className="property-label">
                  <UserRoundPen size={15} /> Criado por
                </span>
                <div className="property-value">
                  <span className="property-person" data-person={creator?.user_id}>
                    <Avatar
                      name={creator?.name ?? "?"}
                      src={creator?.avatar_url}
                      size="small"
                    />
                    {creator?.name ?? "Usuário removido"}
                  </span>
                </div>
              </div>
              <div className="property-row">
                <span className="property-label">
                  <Users size={15} /> Participantes
                </span>
                <div className="property-value participant-list">
                  {participants.length ? (
                    participants.map((m) => (
                      <span key={m.user_id} data-person={m.user_id}>
                        <Avatar name={m.name} src={m.avatar_url} size="small" />
                        {participants.length <= 3 && m.name}
                      </span>
                    ))
                  ) : (
                    <small>Mencione com @ nos comentários</small>
                  )}
                </div>
              </div>
            </div>
          </div>
          <TaskCustomFieldsPanel
            task={task}
            canEdit={canEdit}
            busy={busy}
            onSave={(values, version) =>
              mutate("set_task_custom_fields", {
                p_task: task.id,
                p_version: version,
                p_values: values,
              })
            }
          />
          <section
            className={`focus-timer${isRunning ? " is-running" : ""}${showPlay ? "" : " no-play"}`}
            aria-label="Controle de execução"
          >
            {showPlay && (
              <Button
                className={`timer-play${isRunning ? " timer-stop" : ""}`}
                loading={busy}
                disabled={busy || editorUploading || (!isRunning && !canPlay)}
                onClick={() =>
                  void mutate(
                    running ? "stop_timer" : "start_timer",
                    running ? { p_entry: running.id } : { p_task: task.id },
                  )
                    .then(() => {
                      // Play and pause are posted as comments.
                      invalidateTaskExtras(task.id);
                      setLocalRefresh((v) => v + 1);
                    })
                    .catch((e) => setError(e.message))
                }
              >
                {isRunning ? (
                  <Pause size={20} fill="currentColor" />
                ) : (
                  <Play size={20} fill="currentColor" />
                )}
                <span>{isRunning ? "Parar" : "Iniciar"}</span>
              </Button>
            )}
            <div className="timer-body">
              <div className="timer-head">
                <span className="timer-clock">
                  <strong>{clock}</strong>
                  <small>
                    {task.estimated_minutes > 0
                      ? `de ${duration(task.estimated_minutes)} estimadas`
                      : "sem estimativa"}
                  </small>
                </span>
                <span
                  className={`timer-state${isRunning ? " running" : totalSeconds > 0 ? " paused" : ""}`}
                >
                  <i aria-hidden="true" />
                  {isRunning
                    ? "Em andamento"
                    : totalSeconds > 0
                      ? "Pausado"
                      : "Não iniciado"}
                </span>
              </div>
              {task.estimated_minutes > 0 && (
                <span
                  className={`time-meter${timeRatio > 1 ? " over" : ""}`}
                  role="meter"
                  aria-label="Tempo usado da estimativa"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(Math.min(timeRatio, 1) * 100)}
                >
                  <i style={{ width: `${Math.min(timeRatio, 1) * 100}%` }} />
                </span>
              )}
              <p>
                {isRunning
                  ? timeRatio > 1
                    ? "Seu tempo está sendo registrado — a estimativa já foi ultrapassada."
                    : "Seu tempo está sendo registrado nesta tarefa."
                  : !canPlay
                    ? task.status === "done"
                      ? "Tarefa entregue — o tempo registrado fica aqui."
                      : task.creator_id === user
                        ? "Você criou esta tarefa; o tempo é registrado por quem a executa."
                        : "Sem registro de tempo enquanto a tarefa está nesta etapa."
                    : runsElsewhere
                      ? multiTimer
                        ? "Ao iniciar, suas outras tarefas em andamento continuam rodando."
                        : "Ao iniciar, sua outra tarefa em andamento é pausada automaticamente."
                      : totalSeconds > 0
                        ? "Clique em Iniciar para continuar registrando."
                        : "Inicie para ver a descrição e registrar seu tempo."}
              </p>
            </div>
          </section>
          {editing ? (
            <>
              <form className="entity-form inline-edit" onSubmit={edit}>
                <label>
                  Título
                  <Input
                    name="title"
                    defaultValue={task.title}
                    onChange={(e) => setEditTitle(e.target.value)}
                    minLength={2}
                    maxLength={240}
                    required
                  />
                </label>
                {clientLocked ? (
                  <div className="task-client-locked">
                    <p className="contract-path">
                      <span>{n.client?.name}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                      <span>{contractProductLabel(data, task.contract_id)}</span>
                    </p>
                    <small>{clientLocked}</small>
                  </div>
                ) : (
                  <>
                    <ContractPicker
                      data={data}
                      contract={editContract}
                      onContractChange={setEditContract}
                      project={editProject}
                      onProjectChange={setEditProject}
                      disabled={busy}
                      allowed={(id) => canCreateTaskIn(data, id, user)}
                    />
                    {movedClient && hasSubtasks && (
                      <small>As subtarefas vão junto para o novo cliente.</small>
                    )}
                  </>
                )}
                <Suspense
                  fallback={
                    <>
                      <input
                        type="hidden"
                        name="description"
                        value={task.description}
                      />
                      <Loading variant="editor" />
                    </>
                  }
                >
                  <RichTextEditor
                    company={task.company_id}
                    demo={demo}
                    defaultValue={task.description}
                    disabled={busy}
                    onUploading={setEditorUploading}
                    onTextChange={setEditText}
                    appendRef={appendToDescription}
                  />
                </Suspense>
                <TaskAudioList
                  state={audio}
                  canManage={canEdit}
                  demo={demo}
                  disabled={busy}
                  nameOf={memberName}
                  onRecording={setDescRecording}
                />
                <label>
                  Início planejado (opcional)
                  <Input
                    type="date"
                    name="start_date"
                    defaultValue={task.start_date ?? ""}
                    onChange={(e) => setEditStart(e.target.value)}
                  />
                </label>
                <div className="form-columns">
                  <TaskDueEdit
                    data={data}
                    task={task}
                    start={editStart ?? task.start_date ?? ""}
                    demo={demo}
                    effort={copilotOn && !copilot.stale ? copilot.effort : null}
                  />
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
                      <SelectOption
                        value={k}
                        key={k}
                        disabled={
                          !canSetPriority(data, task, k as Task["priority"], user)
                        }
                      >
                        {v}
                      </SelectOption>
                    ))}
                  </Select>
                  {!mayPrioritize(data, user) && (
                    <small>{PRIORITY_RULE}</small>
                  )}
                </label>
                {copilotOn && <CopilotBadge state={copilot} />}
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
              {copilotOn && (
                <TaskCopilot
                  state={copilot}
                  feedback={copilotFeedback}
                  members={data.members}
                  onApplyFix={(text) => appendToDescription.current?.(text)}
                  typedEnough={
                    `${editTitle} ${editText ?? ""}`.trim().length >= MIN_REVIEW
                  }
                />
              )}
            </>
          ) : !isRunning && canPlay ? (
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
          ) : (
            <section className="detail-description">
              <div>
                <h3>Descrição</h3>
              </div>
              <RichTextContent value={task.description} />
              {/* Gravar é de quem escreve o pedido: só ao criar ou editar. */}
              <TaskAudioList
                state={audio}
                canManage={canEdit}
                canRecord={false}
                demo={demo}
                disabled={busy}
                nameOf={memberName}
              />
              {slPost &&
                (canOpenPage(
                  SL_MODULES[slPost.module].page,
                  member?.role,
                  member?.hidden_pages,
                ) ? (
                  <Button
                    className="btn primary detail-post-link"
                    onClick={() => {
                      const company = routeParts(
                        window.location.pathname,
                      ).company;
                      navigate(
                        (company ? `/agencias/${company}` : "") +
                          taskPostPath(slPost),
                      );
                    }}
                  >
                    <ArrowUpRight size={16} /> Abrir o post no plano
                  </Button>
                ) : (
                  <p className="detail-post-hint">
                    Para subir as artes no post, peça acesso ao módulo
                    Planejamento › {SL_MODULES[slPost.module].name} a um
                    administrador.
                  </p>
                ))}
            </section>
          )}
          <div className="approval-state">
            <Check size={17} />
            <span>
              {review.required ? (
                <>
                  Validação {reviewer}:{" "}
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
          {!action && (acts.approveInternal || acts.approveClient) && (
            <div className="detail-actions">
              {acts.approveInternal && (
                <Button
                  className="btn primary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => pickStatus("done")}
                >
                  <Check size={16} /> Aprovar entrega
                </Button>
              )}
              {acts.approveInternal && (
                <Button
                  className="btn secondary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => pickStatus("rejected")}
                >
                  Pedir alteração
                </Button>
              )}
              {acts.approveClient && (
                <Button
                  className="btn secondary"
                  disabled={busy}
                  loading={busy}
                  onClick={() => {
                    setTarget(null);
                    setAction("approve_client");
                  }}
                >
                  Registrar aprovação do cliente
                </Button>
              )}
            </div>
          )}
          {blocked(acts.reopen) && (
            <p className="muted action-hint">{acts.reopen.blocked}</p>
          )}
          {action && (
            <form
              ref={actionForm}
              className="action-note"
              key={`${action}-${target ?? ""}`}
              onSubmit={(e) => {
                e.preventDefault();
                if (editorUploading) return;
                const fd = new FormData(e.currentTarget);
                const form = noteForm(action, target, task.status);
                let note = String(fd.get("note") ?? "");
                const written = richTextPlain(note).trim().length;
                if (written < form.min) {
                  setError(
                    `Escreva ao menos ${form.min} caracteres no campo "${form.label}".`,
                  );
                  return;
                }
                // An empty optional note posts no comment.
                if (!written) note = "";
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
                  if (!window.confirm("Reabrir esta tarefa?")) return;
                }
                const moving = action === "move" || action === "reopen";
                void transition(
                  action,
                  note,
                  moving
                    ? {
                        p_status: target,
                        p_assignee: String(fd.get("assignee") ?? "") || null,
                      }
                    : {},
                );
              }}
            >
              {(action === "move" || action === "reopen") && target && (
                <>
                  <div className="move-head">
                    {action === "move" && target === task.status ? (
                      <>Trocar o responsável, mantendo</>
                    ) : action === "reopen" ? (
                      <>Reabrir em</>
                    ) : (
                      <>Mover para</>
                    )}
                    <StatusPill status={target} />
                  </div>
                  {target !== "done" && (
                    <label className="move-assignee">
                      Responsável a partir de agora
                      <Select
                        name="assignee"
                        aria-label="Responsável a partir de agora"
                        defaultValue={suggestedAssignee(
                          data,
                          task,
                          target,
                          extras.events,
                        )}
                      >
                        {activeMembers.map((m) => (
                          <SelectOption key={m.user_id} value={m.user_id}>
                            {m.name}
                            {m.user_id === task.assignee_id
                              ? " (responsável atual)"
                              : m.user_id === task.creator_id
                                ? " (criador)"
                                : ""}
                          </SelectOption>
                        ))}
                      </Select>
                      <small>
                        Sugerido pelo novo status. Troque se outra pessoa
                        cuidará da tarefa agora.
                      </small>
                    </label>
                  )}
                </>
              )}
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
                      <input
                        type="radio"
                        name="reopen_origin"
                        value="internal"
                      />
                      Meu
                    </label>
                  </fieldset>
                </div>
              )}
              <Suspense fallback={<Loading variant="editor" />}>
                <RichTextEditor
                  key={`${action}-${target ?? ""}`}
                  company={task.company_id}
                  demo={demo}
                  mentions={mentionPeople}
                  name="note"
                  label={noteForm(action, target, task.status).label}
                  disabled={busy}
                  onUploading={setEditorUploading}
                />
              </Suspense>
              <small>
                O texto escrito também é publicado nos comentários da tarefa.
              </small>
              <div className="form-footer">
                <Button
                  type="button"
                  className="btn secondary"
                  onClick={() => {
                    setAction("");
                    setTarget(null);
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
                  {noteForm(action, target, task.status).submit}
                </Button>
              </div>
            </form>
          )}
        </div>
        <nav className="task-rail" aria-label="Painel lateral da tarefa">
          <Button
            className="icon-btn task-rail-toggle"
            aria-label={panelOpen ? "Recolher painel" : "Expandir painel"}
            title={panelOpen ? "Recolher painel" : "Expandir painel"}
            aria-expanded={panelOpen}
            onClick={() => togglePanel(!panelOpen)}
          >
            {panelOpen ? (
              <ChevronsRight size={18} />
            ) : (
              <ChevronsLeft size={18} />
            )}
          </Button>
          {panels.map((t) => (
            <Button
              key={t.id}
              className={`icon-btn${tab === t.id && panelOpen ? " selected" : ""}`}
              aria-label={t.label}
              title={t.label}
              aria-pressed={tab === t.id && panelOpen}
              onClick={() => {
                setTab(t.id);
                togglePanel(true);
              }}
            >
              <t.icon size={18} />
              {!!t.count && <span className="task-rail-count">{t.count}</span>}
            </Button>
          ))}
        </nav>
        {panelOpen && (
          <aside className="task-side" aria-label={current.label}>
            <header className="task-side-head">
              <h3>{current.label}</h3>
            </header>
            <div className="task-side-body" ref={sideBody}>
              {loading ? (
                <Loading compact />
              ) : tab === "comments" ? (
                <div className="comment-list">
                  {commentThreads(extras.comments).map((t) => (
                    <div className="comment-thread" key={t.comment.id}>
                      {commentItem(t.comment, t.orphan)}
                      {t.replies.length > 0 && (
                        <div
                          className="comment-replies"
                          aria-label={`${t.replies.length} ${t.replies.length === 1 ? "resposta" : "respostas"}`}
                        >
                          {t.replies.map((r) => commentItem(r))}
                        </div>
                      )}
                    </div>
                  ))}
                  {!extras.comments.length && (
                    <p className="muted centered">
                      A conversa sobre esta entrega começa aqui.
                    </p>
                  )}
                </div>
              ) : tab === "checklist" ? (
                <TaskChecklistPanel
                  task={task}
                  data={data}
                  user={user}
                  company={task.company_id}
                  lists={extras.checklists ?? []}
                  canManage={canEdit}
                  isLeader={isLeader}
                  run={runChecklist}
                  mutate={mutate}
                  notify={notify}
                  loadHistory={loadChecklistHistory}
                  onLists={(checklists) =>
                    setExtras((x) => ({ ...x, checklists }))
                  }
                />
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
                          <span className="sr-only">
                            Enviando arquivo {uploadProgress}…
                          </span>
                        </span>
                      ) : (
                        "Clique ou arraste arquivos para anexar"
                      )}
                    </strong>
                    <small>{ATTACHMENT_HINT}</small>
                    <Input
                      type="file"
                      multiple
                      disabled={demo || uploading}
                      onChange={(e) => {
                        void upload(Array.from(e.target.files ?? []));
                        e.target.value = "";
                      }}
                    />
                  </label>
                  {extras.attachments.map((a, i) => (
                    <div className="file-row" key={a.id}>
                      <Paperclip size={17} />
                      <span>
                        <button
                          type="button"
                          className="file-row-name"
                          title="Visualizar"
                          onClick={() => setViewing(i)}
                        >
                          {a.name}
                        </button>
                        <small>{formatBytes(a.size_bytes)}</small>
                        {attachmentType(a.name)?.startsWith("audio/") && (
                          <span className="file-row-player">
                            <AudioPlayer
                              src={getGcsPublicUrl(a.path)}
                              duration={0}
                              label={a.name}
                            />
                          </span>
                        )}
                      </span>
                      <Button
                        className="icon-btn"
                        aria-label={`Visualizar ${a.name}`}
                        title="Visualizar"
                        onClick={() => setViewing(i)}
                      >
                        <Eye size={18} />
                      </Button>
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
                        <strong>{eventLabel(e)}</strong>
                        {typeof e.detail.assignee_to === "string" &&
                          e.detail.assignee_to !== e.detail.assignee_from && (
                            <span className="event-assignee">
                              Responsável:{" "}
                              <span data-person={String(e.detail.assignee_from)}>
                                {memberName(String(e.detail.assignee_from))}
                              </span>{" "}
                              →{" "}
                              <span data-person={String(e.detail.assignee_to)}>
                                {memberName(String(e.detail.assignee_to))}
                              </span>
                            </span>
                          )}
                        <small>
                          {new Date(e.created_at).toLocaleString("pt-BR")}
                        </small>
                        {!!e.detail.note && (
                          <RichTextContent value={String(e.detail.note)} />
                        )}
                        {e.action === "priority" && !e.detail.system && (
                          <span className="event-reason">
                            {isPrioritized(String(e.detail.to)) ? "Marcada" : "Alterada"} por{" "}
                            <span data-person={e.actor_id}>{memberName(e.actor_id)}</span>
                          </span>
                        )}
                        {e.action === "checklist" && (
                          <span className="event-reason">
                            por{" "}
                            <span data-person={e.actor_id}>{memberName(e.actor_id)}</span>
                          </span>
                        )}
                        {/* Mudança de prazo (migration 20270110090000): quem, onde e por quê. */}
                        {e.action === "due_changed" && !!e.detail.reason && (
                          <span className="event-reason">
                            <span data-person={e.actor_id}>{memberName(e.actor_id)}</span>
                            {e.detail.source && e.detail.source !== "task"
                              ? ` (${dueSources[e.detail.source as keyof typeof dueSources] ?? ""})`
                              : ""}
                            : {String(e.detail.reason)}
                          </span>
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
            {tab === "comments" && (
              <form
                ref={composer}
                className="comment-form task-side-composer"
                onSubmit={comment}
              >
                {replyTo && (
                  <div className="comment-replying">
                    <Reply size={14} />
                    <span>
                      Respondendo a{" "}
                      <strong>
                        {data.members.find(
                          (m) => m.user_id === replyTo.author_id,
                        )?.name ?? "Usuário"}
                      </strong>
                      <small>
                        {richTextPlain(replyTo.body) || "Áudio"}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Cancelar resposta"
                      onClick={() => setReplyTo(null)}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                <Suspense fallback={<Loading variant="editor" />}>
                  <RichTextEditor
                    key={commentRevision}
                    company={task.company_id}
                    demo={demo}
                    mentions={mentionPeople}
                    defaultValue={
                      commentRevision === 0 ? (savedComment ?? "") : ""
                    }
                    onChange={(value) => {
                      setCommentFilled(!!value);
                      onCommentDraft?.(value);
                    }}
                    name="body"
                    label={replyTo ? "Resposta" : "Comentário"}
                    disabled={busy}
                    onUploading={setEditorUploading}
                  />
                </Suspense>
                {commentAudio && (
                  <div className="comment-audio-draft" role="group" aria-label="Áudio do comentário">
                    <RecordingPreview
                      recording={commentAudio}
                      onRemove={() => setCommentAudio(null)}
                      disabled={sendingAudio}
                    />
                  </div>
                )}
                <div className="comment-composer-actions">
                  {!demo && !commentAudio && (
                    <AudioRecorder
                      label="Gravar áudio"
                      disabled={busy || sendingAudio}
                      onUse={(r) => setCommentAudio(r)}
                      onActiveChange={setCommentRecording}
                    />
                  )}
                  <Button
                    className="btn primary"
                    disabled={busy || editorUploading || commentRecording}
                    loading={busy || editorUploading || sendingAudio}
                    aria-label={replyTo ? "Enviar resposta" : "Enviar comentário"}
                  >
                    <Send size={16} /> {replyTo ? "Responder" : "Enviar"}
                  </Button>
                </div>
              </form>
            )}
          </aside>
        )}
      </div>
      {viewing !== null && extras.attachments[viewing] && (
        <FileViewer
          files={extras.attachments.map((a) => ({
            key: a.id,
            name: a.name,
            contentType: attachmentType(a.name) ?? "",
            size: a.size_bytes,
            load: async () => getGcsPublicUrl(a.path),
            download: () => download(a),
            openOriginal: () =>
              window.open(getGcsPublicUrl(a.path), "_blank", "noopener"),
          }))}
          start={viewing}
          onClose={() => setViewing(null)}
        />
      )}
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
