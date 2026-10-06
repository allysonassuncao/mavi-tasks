import { Input, Select, SelectOption, Checkbox, Button, Skeleton } from "./ui";
import {
  lazy,
  useMemo,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Paperclip, Sparkles, X } from "lucide-react";
import { Modal, Loading } from "./components";
import { ContractPicker } from "./ContractPicker";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import { CustomFieldsForm } from "./CustomFieldsForm";
import { CopilotBadge, TaskCopilot, useCopilotFeedback } from "./TaskCopilot";
import { MIN_REVIEW, copilotExtras, useTaskCopilot } from "./copilot";
import {
  customFieldsError,
  teamTemplateFields,
  templateFieldsFor,
} from "./templateFields";
import {
  type RecurrenceFrequency,
  type Snapshot,
  priorities,
  recurrenceFrequencies,
} from "./types";
import {
  PRIORITY_RULE,
  mayPrioritize,
  isPrioritized,
} from "./task-priority";
import { canCreateTaskIn, dateKey, dateLabel, nextRecurrence } from "./domain";
import { suggestDue } from "./dueRules";
import { AbsenceNote, DueRuleHint, SmartDueHint } from "./DueRuleHint";
import { useSmartDue } from "./smartDue";
import { WhoDeliversFirst } from "./DueAssist";
import { dayLabel } from "./task-bulk";
import {
  ATTACHMENT_HINT,
  validateAttachment,
  uploadAttachment,
  saveTaskWithAttachments,
  type TaskUploadState,
} from "./attachments";
import { TaskAudioList, useTaskAudios } from "./TaskAudios";
import { audioTranscripts, audioWorking } from "./task-audio";
import { requestTaskTitle } from "./task-title-request";
import { suggestedChecklistTemplates, templateItemCount } from "./checklist";
import { TASK_TITLE_WAIT_MS, fallbackTaskTitle } from "./task-title";
const RichTextEditor = lazy(() => import("./RichTextEditor"));
type Mutate = (name: string, args: Record<string, unknown>) => Promise<any>;

const LAST_CONTRACT_KEY = "mavi:last-task-contract";
function readLastContract() {
  try {
    return localStorage.getItem(LAST_CONTRACT_KEY) ?? "";
  } catch {
    return "";
  }
}
function rememberContract(id: string) {
  try {
    localStorage.setItem(LAST_CONTRACT_KEY, id);
  } catch {
    // Remembering the last client is a convenience; ignore blocked storage.
  }
}
function inDays(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return dateKey(d);
}
const dueShortcuts = [
  { label: "Hoje", days: 0 },
  { label: "Amanhã", days: 1 },
  { label: "Em 1 semana", days: 7 },
];

/**
 * Task creation keeps only what the backend requires up front (contracted
 * product, assignee and due date, all prefilled); everything else lives
 * behind "Adicionar detalhes". There is no title field: on "Criar tarefa"
 * the MAVI writes the title from the description and the audios (feature
 * 'task_title'), and the task is saved with it — or, when she fails or takes
 * too long, with the start of the description. The assignee can be a
 * team instead of a person: the database hands the task to the team member
 * with the fewest open tasks (supervisors only when there is nobody else).
 * The due date follows the due rules (dueRules.ts) until picked by hand.
 */
export function TaskCreateForm({
  initialContract,
  initialProject,
  initialTitle,
  initialDescription,
  initialDue,
  initialAssignee,
  initialTeam,
  initialPriority,
  onCreated,
  demo,
  data,
  company,
  user,
  busy,
  mutate,
  onClose,
}: {
  initialContract?: string;
  initialProject?: string;
  /**
   * Handed in from elsewhere (a recording's next step): the MAVI starts from
   * it, and it becomes the description when there is none.
   */
  initialTitle?: string;
  /** HTML for the description editor. */
  initialDescription?: string;
  /** yyyy-mm-dd. */
  initialDue?: string;
  /** A person of the company (a MAVI proposal). */
  initialAssignee?: string;
  /** A team instead of a person (a MAVI proposal; the database picks who). */
  initialTeam?: string;
  initialPriority?: keyof typeof priorities;
  /** The task was saved (the MAVI marks its proposal as confirmed). */
  onCreated?: (task: string) => void;
  demo: boolean;
  data: Snapshot;
  company: string;
  user: string;
  busy: boolean;
  mutate: Mutate;
  onClose: () => void;
}) {
  const [contract, setContract] = useState(() => {
    const usable = (id?: string) =>
      !!id &&
      data.contracts.some(
        (c) => c.id === id && !c.archived && canCreateTaskIn(data, c.id, user),
      );
    const last = readLastContract();
    if (usable(initialContract)) return initialContract!;
    if (usable(last)) return last;
    return data.contracts.find((c) => usable(c.id))?.id ?? "";
  });
  const contractClient = data.contracts.find(
    (c) => c.id === contract,
  )?.client_id;
  const [project, setProject] = useState(
    initialContract && contract === initialContract
      ? (initialProject ?? "")
      : "",
  );
  // The title handed in from elsewhere: only for the first task created here.
  const [presetTitle, setPresetTitle] = useState(initialTitle ?? "");
  const [lastTitle, setLastTitle] = useState("");
  const [assignee, setAssignee] = useState(() =>
    initialAssignee &&
    data.members.some((m) => m.user_id === initialAssignee && m.active)
      ? initialAssignee
      : user,
  );
  const [assignMode, setAssignMode] = useState<"person" | "team">(() =>
    initialTeam && !initialAssignee && data.teams.some((t) => t.id === initialTeam) ? "team" : "person",
  );
  const [assignTeam, setAssignTeam] = useState(() =>
    initialTeam && !initialAssignee && data.teams.some((t) => t.id === initialTeam) ? initialTeam : "",
  );
  // The due date follows the rule until picked by hand (a date handed in
  // from elsewhere counts as picked).
  const [pickedDue, setPickedDue] = useState(initialDue || dateKey());
  const [dueByHand, setDueByHand] = useState(!!initialDue);
  const [dueReason, setDueReason] = useState("");
  const [start, setStart] = useState("");
  const [clientApproval, setClientApproval] = useState(false);
  const [parent, setParent] = useState("");
  const [pickedPriority, setPriority] = useState<keyof typeof priorities>(
    initialPriority ?? "normal",
  );
  const [estimated, setEstimated] = useState("");
  // Which suggestion the date follows: "auto" is the company's choice (the
  // rule, or the MAVI in "fill" mode); "Aplicar"/"Usar" pick one.
  const [duePick, setDuePick] = useState<"auto" | "rule" | "smart">("auto");
  // The size the MAVI read in the description (from its analysis, below):
  // the smart due date takes a day off or adds a quarter.
  const [dueEffort, setDueEffort] = useState<{
    level: "simple" | "complex";
    why: string;
  } | null>(null);
  const [repeat, setRepeat] = useState<RecurrenceFrequency | "">("");
  // Checklist: the models picked by hand (null follows the product's and the
  // team's suggestions) and "só entregar com o checklist concluído".
  const [pickedChecklists, setPickedChecklists] = useState<string[] | null>(
    null,
  );
  const [checklistRequired, setChecklistRequired] = useState(false);
  // Applied once per task, even when sending the attachments again.
  const checklistsApplied = useRef("");
  const [showDetails, setShowDetails] = useState(false);
  const [detailsMounted, setDetailsMounted] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [created, setCreated] = useState(0);
  const [error, setError] = useState("");
  const uploads = useRef<TaskUploadState>({ pending: [] });
  const submitting = useRef(false);
  const [saving, setSaving] = useState(false);
  // Waiting for the MAVI's title (the button says so); then the task is saved.
  const [naming, setNaming] = useState(false);
  const [editorUploading, setEditorUploading] = useState(false);
  const [, updateUploads] = useState(0);
  const redrawUploads = () => updateUploads((v) => v + 1);
  const locked = saving || !!uploads.current.taskId;
  const working = busy || saving || editorUploading;
  const activeMembers = data.members.filter((m) => m.active);
  // Teams that serve this client (create_task accepts only those). One with
  // nobody active can't receive a task, so it shows why and can't be picked.
  const clientTeams = useMemo(
    () =>
      data.teams
        .filter((t) =>
          data.clientTeams.some(
            (ct) => ct.client_id === contractClient && ct.team_id === t.id,
          ),
        )
        .map((t) => {
          const people = data.teamMembers.filter((tm) => tm.team_id === t.id);
          const active = people.some((tm) =>
            data.members.some((m) => m.user_id === tm.user_id && m.active),
          );
          return {
            team: t,
            unavailable: active
              ? ""
              : people.length
                ? "ninguém ativo"
                : "sem pessoas",
          };
        }),
    [data, contractClient],
  );
  const byTeam = assignMode === "team";
  // A team chosen for another client no longer applies.
  const team = clientTeams.some(
    (ct) => ct.team.id === assignTeam && !ct.unavailable,
  )
    ? assignTeam
    : "";
  // Alta e Urgente só por gestor, admin ou quem tem o recurso "Marcar
  // prioridade" (src/task-priority.ts).
  const canMark = mayPrioritize(data, user);
  const priority =
    !canMark && isPrioritized(pickedPriority) ? "normal" : pickedPriority;
  const dueSuggestion = useMemo(
    () =>
      contract
        ? suggestDue(data, {
            contract,
            project: project || null,
            team: byTeam ? team || null : null,
            assignee: byTeam ? null : assignee,
            base: start || dateKey(),
            approval: clientApproval,
          })
        : null,
    [data, contract, project, byTeam, team, assignee, start, clientApproval],
  );
  // Prazo inteligente: the MAVI's date beside the rule's (smartDue.ts).
  const companyRow = data.companies.find((c) => c.id === company);
  const smartMode = companyRow?.smart_due ?? "suggest";
  const smart = useSmartDue(
    contract && smartMode !== "off" && (!byTeam || team)
      ? {
          company,
          contract,
          project: project || null,
          team: byTeam ? team || null : null,
          assignee: byTeam ? null : assignee,
          start: start || null,
          approval: clientApproval,
          priority,
          estimated: Math.round(Number(estimated || 0) * 60),
          timezone: companyRow?.timezone ?? "America/Sao_Paulo",
          today: dateKey(),
          effort: dueEffort?.level ?? null,
        }
      : null,
    demo,
    data,
  ).state;
  const smartDate = smart?.available ? (smart.due ?? null) : null;
  const followSmart =
    !!smartDate &&
    (duePick === "smart" || (duePick === "auto" && smartMode === "fill"));
  const due = dueByHand
    ? pickedDue
    : followSmart
      ? smartDate!
      : (dueSuggestion?.due ?? pickedDue);
  const setDue = (value: string) => {
    setPickedDue(value);
    setDueByHand(true);
  };
  // The MAVI's date, followed or picked by hand (when it isn't also the rule's).
  const usingSmart =
    !!smartDate &&
    due === smartDate &&
    (dueByHand ? due !== dueSuggestion?.due : followSmart);
  // The date the rule (or the MAVI) gives is still theirs, even if picked by hand.
  const dueManual = dueByHand && due !== dueSuggestion?.due && !usingSmart;
  // A main task chosen for another product no longer applies.
  const parentTask = parent
    ? data.tasks.find((t) => t.id === parent && t.contract_id === contract)
    : null;
  // Template fields for this product and assignee (or team): they change as
  // either does (values typed for fields still shown are kept).
  const customFields = useMemo(
    () =>
      !contract
        ? []
        : byTeam
          ? team
            ? teamTemplateFields(data, contract, team)
            : []
          : templateFieldsFor(data, contract, assignee),
    [data, contract, assignee, byTeam, team],
  );
  const [customValues, setCustomValues] = useState<Record<string, unknown>>({});
  const checklistModels = useMemo(
    () =>
      (data.checklistTemplates ?? [])
        .filter((t) => t.active)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.checklistTemplates],
  );
  const suggestedChecklists = useMemo(
    () =>
      contract && (!byTeam || team)
        ? suggestedChecklistTemplates(
            data,
            contract,
            byTeam ? { team } : { assignee },
            project || null,
          ).map((t) => t.id)
        : [],
    [data, contract, project, byTeam, team, assignee],
  );
  const chosenChecklists = (pickedChecklists ?? suggestedChecklists).filter(
    (id) => checklistModels.some((m) => m.id === id),
  );
  const toggleChecklist = (id: string, on: boolean) =>
    setPickedChecklists(
      on
        ? [...chosenChecklists.filter((x) => x !== id), id]
        : chosenChecklists.filter((x) => x !== id),
    );
  const me = activeMembers.find((m) => m.user_id === user);
  // Assistente MAVI: lê o rascunho enquanto a pessoa escreve (desligado junto
  // com o módulo "Assistente MAVI" da pessoa).
  const [descriptionText, setDescriptionText] = useState("");
  const appendToDescription = useRef<((text: string) => void) | null>(null);
  // Áudios da descrição: gravados e transcritos aqui mesmo (o Assistente
  // MAVI já lê o que foi dito) e ligados à tarefa ao criar.
  const audio = useTaskAudios({
    company,
    task: null,
    contract: contract || null,
    onError: setError,
  });
  const [recording, setRecording] = useState(false);
  const copilotOn = !data.members
    .find((m) => m.user_id === user)
    ?.hidden_pages?.includes("assistant");
  const copilot = useTaskCopilot(
    {
      company,
      contract: contract || null,
      title: presetTitle,
      description: descriptionText,
      audio: audioTranscripts(audio.items),
      due,
      ...copilotExtras(data, {
        assignee: byTeam ? null : assignee,
        team: byTeam ? team || null : null,
        parent: parentTask?.id ?? null,
        files: uploads.current.pending.map((f) => f.name),
        fields: customFields.map((f) => ({
          label: f.label,
          required: f.required,
          value: customValues[`${f.template_id}.${f.id}`],
        })),
      }),
    },
    copilotOn && !locked,
    demo,
  );
  const readEffort =
    copilotOn && !copilot.stale && copilot.effort?.level !== "normal"
      ? (copilot.effort ?? null)
      : null;
  useEffect(() => {
    setDueEffort(
      readEffort && readEffort.level !== "normal"
        ? { level: readEffort.level, why: readEffort.why }
        : null,
    );
  }, [readEffort?.level, readEffort?.why]);
  const copilotFeedback = useCopilotFeedback(copilot, {
    company,
    contract: contract || null,
    title: presetTitle,
    demo,
  });

  const close = () => {
    if (submitting.current || editorUploading) return;
    // Closed without creating: the recorded drafts go away.
    audio.discardAll();
    onClose();
  };
  function toggleDetails() {
    setDetailsMounted(true);
    setShowDetails((v) => !v);
  }
  function addFiles(files: FileList | File[] | null) {
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
  // Files dropped on the form join the attachments sent with the task.
  const drop = useFileDrop(addFiles, !demo && !saving);
  function resetForNext() {
    uploads.current = { pending: [] };
    setPresetTitle("");
    setRepeat("");
    setPickedChecklists(null);
    setChecklistRequired(false);
    setCustomValues({});
    setStart("");
    setClientApproval(false);
    setParent("");
    setDueReason("");
    setPriority("normal");
    setEstimated("");
    setDuePick("auto");
    setFormKey((v) => v + 1);
    setCreated((v) => v + 1);
    redrawUploads();
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current || editorUploading) return;
    setError("");
    const f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) ?? "");
    if (byTeam && !team) {
      setError("Escolha a equipe que vai receber a tarefa.");
      return;
    }
    if (recording) {
      setError("Termine a gravação: use o áudio ou descarte antes de criar a tarefa.");
      return;
    }
    if (audio.uploading) {
      setError("Espere o áudio terminar de enviar.");
      return;
    }
    const fieldsProblem = customFieldsError(customFields, customValues);
    if (fieldsProblem) {
      setError(fieldsProblem);
      return;
    }
    // What the MAVI writes the title from.
    const written = descriptionText.trim();
    const spoken = audioTranscripts(audio.items);
    if (!uploads.current.taskId && !written && !spoken && !presetTitle.trim()) {
      setError(
        audio.items.some((a) => audioWorking(a))
          ? "Espere a MAVI transcrever o áudio: ela usa o que foi dito para criar o título."
          : "Descreva a tarefa ou grave um áudio: a MAVI cria o título a partir deles.",
      );
      return;
    }
    const args = {
      p_company: company,
      p_contract: contract,
      // Without an assignee, the database picks one from the team.
      p_assignee: byTeam ? null : assignee,
      p_due: due,
      // Without it the database counts the rule's date itself (in a team,
      // for whoever receives the task).
      p_due_manual: dueManual,
      // The database counts the MAVI's date again (in a team, for whoever
      // receives the task).
      p_due_smart: usingSmart,
      ...(dueEffort ? { p_due_effort: dueEffort.level } : {}),
      ...(dueManual && dueReason.trim()
        ? { p_due_reason: dueReason.trim() }
        : {}),
      p_start: start || null,
      p_project: project || null,
      p_team: byTeam ? team : null,
      p_description: s("description"),
      p_priority: priority,
      p_estimated: Math.round(Number(estimated || 0) * 60),
      p_client_approval: clientApproval,
      p_parent: parentTask?.id ?? null,
      // The database opens a copy of the task on each date of the series.
      ...(repeat ? { p_repeat: repeat } : {}),
      // Only the fields shown now; the database checks them against the
      // templates that apply and keeps its own copy in the task. Sent only
      // when there are fields, so tasks without templates never depend on it.
      ...(customFields.length
        ? {
            p_custom: Object.fromEntries(
              customFields.map((cf) => {
                const key = `${cf.template_id}.${cf.id}`;
                return [key, customValues[key] ?? null];
              }),
            ),
          }
        : {}),
    };
    submitting.current = true;
    setSaving(true);
    try {
      await saveTaskWithAttachments(
        uploads.current,
        async () => {
          // The title first, so the task reaches the list with it.
          setNaming(true);
          const title = await taskTitle({
            demo,
            company,
            contract,
            project: project || null,
            description: written,
            audio: spoken,
            hint: presetTitle.trim(),
          }).finally(() => setNaming(false));
          setLastTitle(title);
          return mutate("create_task", { ...args, p_title: title });
        },
        uploadAttachment,
        redrawUploads,
      );
      // The recorded audios go into the description of the task just saved.
      if (uploads.current.taskId) await audio.bindTo(uploads.current.taskId);
      // The checklists picked here, and whether delivery waits for them.
      const newTask = uploads.current.taskId;
      if (
        newTask &&
        checklistsApplied.current !== newTask &&
        (chosenChecklists.length || checklistRequired)
      ) {
        await mutate("apply_checklist_templates", {
          p_task: newTask,
          p_templates: chosenChecklists,
          p_required: checklistRequired || null,
        });
        checklistsApplied.current = newTask;
      }
      if (uploads.current.taskId) onCreated?.(uploads.current.taskId);
      rememberContract(contract);
      copilotFeedback.flush(
        company,
        contractClient ?? null,
        uploads.current.taskId ?? null,
      );
      if (createAnother) resetForNext();
      else onClose();
    } catch (e) {
      const message =
        (e as Error).message ?? "Não foi possível enviar o arquivo.";
      setError(
        uploads.current.taskId
          ? `A tarefa foi salva. ${message} Tente de novo para enviar os anexos e áudios pendentes, ou feche para continuar depois.`
          : message,
      );
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }
  function submitShortcut(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
  }
  return (
    <Modal
      title="Nova tarefa"
      onClose={close}
      busy={saving || editorUploading}
      className={copilotOn ? "with-copilot" : ""}
    >
      <div className="copilot-layout">
        <form
          className="entity-form quick-task"
          onSubmit={submit}
          onKeyDown={submitShortcut}
          {...drop.handlers}
        >
          <small className="quick-task-mavi-title">
            <Sparkles size={14} aria-hidden="true" />
            A MAVI cria o título ao salvar, a partir da descrição e dos áudios.
          </small>
          {drop.active && (
            <DropOverlay
              label="Solte para anexar à nova tarefa"
              hint="Os arquivos são enviados ao criar a tarefa"
            />
          )}
          <fieldset className="create-fields" disabled={locked}>
            {created > 0 && (
              <small className="quick-task-created" role="status">
                <Check size={14} />
                {created === 1
                  ? `Tarefa “${lastTitle}” criada. Pode escrever a próxima.`
                  : `${created} tarefas criadas (a última: “${lastTitle}”). Pode escrever a próxima.`}
              </small>
            )}
            {contract ? (
              <ContractPicker
                data={data}
                contract={contract}
                onContractChange={setContract}
                // Shown only when the product has projects.
                project={project}
                onProjectChange={setProject}
                allowed={(id) => canCreateTaskIn(data, id, user)}
              />
            ) : (
              <p className="form-error" role="alert">
                {data.contracts.some((c) => !c.archived)
                  ? "Você ainda não faz parte de uma equipe que atende um cliente. Peça a um gestor para incluí-lo em uma equipe."
                  : "Adicione um produto a um cliente (em Clientes) antes de criar tarefas."}
              </p>
            )}
            <div className="form-columns">
              <div className="quick-task-due">
                {byTeam ? (
                  <label>
                    Equipe responsável
                    <Select required value={team} onValueChange={setAssignTeam}>
                      <SelectOption value="">
                        {clientTeams.length
                          ? "Escolha a equipe"
                          : "Nenhuma equipe atende este cliente"}
                      </SelectOption>
                      {clientTeams.map(({ team: t, unavailable }) => (
                        <SelectOption
                          key={t.id}
                          value={t.id}
                          disabled={!!unavailable}
                        >
                          {unavailable ? `${t.name} · ${unavailable}` : t.name}
                        </SelectOption>
                      ))}
                    </Select>
                  </label>
                ) : (
                  <label>
                    Responsável
                    <Select
                      required
                      value={assignee}
                      onValueChange={setAssignee}
                    >
                      {me && (
                        <SelectOption value={me.user_id}>
                          Eu ({me.name})
                        </SelectOption>
                      )}
                      {activeMembers
                        .filter((m) => m.user_id !== user)
                        .map((m) => (
                          <SelectOption key={m.user_id} value={m.user_id}>
                            {m.name}
                          </SelectOption>
                        ))}
                    </Select>
                  </label>
                )}
                <div
                  className="due-shortcuts"
                  role="radiogroup"
                  aria-label="Enviar para"
                >
                  {(
                    [
                      ["person", "Pessoa"],
                      ["team", "Equipe"],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      type="button"
                      key={mode}
                      role="radio"
                      aria-checked={assignMode === mode}
                      className={assignMode === mode ? "selected" : ""}
                      onClick={() => setAssignMode(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {!byTeam && contract && (
                  <WhoDeliversFirst
                    input={{
                      company,
                      contract,
                      project: project || null,
                      start: start || null,
                      approval: clientApproval,
                      priority,
                      estimated: Math.round(Number(estimated || 0) * 60),
                    }}
                    demo={demo}
                    data={data}
                    current={assignee}
                    onPick={setAssignee}
                  />
                )}
                {byTeam && (
                  <small className="assign-team-hint">
                    Vai para quem da equipe tem menos tarefas em aberto.
                    Supervisores só recebem quando a equipe não tem mais
                    ninguém, e quem está de férias ou de folga hoje, só se a
                    equipe inteira estiver fora.
                  </small>
                )}
              </div>
              <div className="quick-task-due">
                <label>
                  Prazo
                  <Input
                    name="due"
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                    required
                  />
                </label>
                <div
                  className="due-shortcuts"
                  role="group"
                  aria-label="Atalhos de prazo"
                >
                  {dueShortcuts.map((option) => {
                    const value = inDays(option.days);
                    return (
                      <button
                        type="button"
                        key={option.label}
                        className={due === value ? "selected" : ""}
                        aria-pressed={due === value}
                        onClick={() => setDue(value)}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <DueRuleHint
                  data={data}
                  suggestion={dueSuggestion}
                  due={due}
                  following={!dueManual && !usingSmart}
                  alternative={usingSmart}
                  byTeam={byTeam}
                  reason={dueReason}
                  onReason={setDueReason}
                  onApply={() => {
                    setDueByHand(false);
                    setDuePick("rule");
                  }}
                />
                <SmartDueHint
                  data={data}
                  smart={smart}
                  using={usingSmart}
                  due={due}
                  byTeam={byTeam}
                  priority={priority}
                  effortWhy={dueEffort?.why}
                  onUse={() => {
                    setDueByHand(false);
                    setDuePick("smart");
                  }}
                />
                {!byTeam && (
                  <AbsenceNote data={data} assignee={assignee} due={due} />
                )}
                {parentTask &&
                  parentTask.status !== "done" &&
                  parentTask.due_date < due && (
                    <small className="due-rule-note differs" role="status">
                      A tarefa principal passa a vencer em {dayLabel(due)},
                      junto com esta subtarefa.
                    </small>
                  )}
              </div>
            </div>
            <CustomFieldsForm
              fields={customFields}
              values={customValues}
              onChange={setCustomValues}
            />
            <Suspense fallback={<Loading variant="editor" />}>
              <RichTextEditor
                key={formKey}
                defaultValue={
                  formKey === 0
                    ? initialDescription ||
                      (initialTitle ? `<p>${escapeHtml(initialTitle)}</p>` : "")
                    : ""
                }
                company={company}
                demo={demo}
                onUploading={setEditorUploading}
                disabled={locked}
                onTextChange={setDescriptionText}
                appendRef={appendToDescription}
              />
            </Suspense>
            <TaskAudioList
              state={audio}
              canManage
              demo={demo}
              disabled={locked}
              nameOf={(id) =>
                data.members.find((m) => m.user_id === id)?.name ?? "alguém"
              }
              onRecording={setRecording}
            />
          </fieldset>
          <section
            className="creation-attachments"
            aria-label="Anexos da nova tarefa"
          >
            <label
              className={`upload-zone creation-upload ${saving || demo ? "disabled" : ""}`}
            >
              <Paperclip size={17} /> Adicionar anexos{" "}
              <span className="upload-zone-hint">ou arraste para cá</span>
              <Input
                type="file"
                multiple
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
                : `${ATTACHMENT_HINT}.`}
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
          <fieldset className="create-fields" disabled={locked}>
            <button
              type="button"
              className="details-toggle"
              aria-expanded={showDetails}
              aria-controls="task-details"
              onClick={toggleDetails}
            >
              <ChevronDown size={16} className={showDetails ? "open" : ""} />
              {showDetails ? "Ocultar detalhes" : "Adicionar detalhes"}
              {!showDetails && (
                <small>
                  {chosenChecklists.length
                    ? `checklist ${chosenChecklists
                        .map(
                          (id) =>
                            `“${checklistModels.find((m) => m.id === id)?.name}”`,
                        )
                        .join(", ")} incluído · prioridade, estimativa…`
                    : "prioridade, estimativa, repetição, checklist…"}
                </small>
              )}
            </button>
            {detailsMounted && (
              <div
                id="task-details"
                className="quick-task-details"
                hidden={!showDetails}
                key={formKey}
              >
                {/* Fields fill a two-column grid; a lone last one spans it. */}
                <section className="details-section" aria-label="Organização">
                  <h4>Organização</h4>
                  <div className="details-grid">
                    <label>
                      Tarefa principal
                      <Select
                        key={contract}
                        value={parent}
                        onValueChange={setParent}
                      >
                        <SelectOption value="">Nenhuma</SelectOption>
                        {data.tasks
                          .filter((t) => t.contract_id === contract)
                          .map((t) => (
                            <SelectOption key={t.id} value={t.id}>
                              {t.title}
                            </SelectOption>
                          ))}
                      </Select>
                    </label>
                  </div>
                </section>
                <section className="details-section" aria-label="Planejamento">
                  <h4>Planejamento</h4>
                  <div className="details-grid">
                    <label>
                      Prioridade
                      <Select
                        value={priority}
                        onValueChange={(v) =>
                          setPriority(v as keyof typeof priorities)
                        }
                      >
                        {Object.entries(priorities).map(([id, label]) => (
                          <SelectOption
                            key={id}
                            value={id}
                            disabled={!canMark && isPrioritized(id)}
                          >
                            {label}
                          </SelectOption>
                        ))}
                      </Select>
                      {!canMark && <small>{PRIORITY_RULE}</small>}
                    </label>
                    <label>
                      Estimativa em horas
                      <Input
                        type="number"
                        min="0"
                        max="10000"
                        step="0.25"
                        placeholder="0"
                        value={estimated}
                        onChange={(e) => setEstimated(e.target.value)}
                      />
                    </label>
                    <label>
                      Início planejado
                      <Input
                        type="date"
                        value={start}
                        onChange={(e) => setStart(e.target.value)}
                      />
                    </label>
                    <label>
                      Programar repetição
                      <Select
                        value={repeat}
                        onValueChange={(v) =>
                          setRepeat(v as RecurrenceFrequency | "")
                        }
                      >
                        <SelectOption value="">Não repetir</SelectOption>
                        {Object.entries(recurrenceFrequencies).map(
                          ([id, label]) => (
                            <SelectOption key={id} value={id}>
                              {label}
                            </SelectOption>
                          ),
                        )}
                      </Select>
                    </label>
                  </div>
                  {repeat && <RepeatHint frequency={repeat} due={due} />}
                </section>
                <section className="details-section" aria-label="Checklist">
                  <h4>Checklist</h4>
                  {checklistModels.length > 0 ? (
                    <div
                      className="checklist-create-models"
                      role="group"
                      aria-label="Modelos de checklist"
                    >
                      {checklistModels.map((m) => {
                        const n = templateItemCount(m.items);
                        return (
                          <label className="checkbox-label" key={m.id}>
                            <Checkbox
                              checked={chosenChecklists.includes(m.id)}
                              onCheckedChange={(v) =>
                                toggleChecklist(m.id, v === true)
                              }
                            />
                            {m.name}
                            <small>
                              {n} {n === 1 ? "item" : "itens"}
                              {suggestedChecklists.includes(m.id) &&
                                " · sugerido para esta tarefa"}
                            </small>
                          </label>
                        );
                      })}
                    </div>
                  ) : (
                    <small className="checklist-create-hint">
                      Os checklists são criados no painel Checklist da tarefa,
                      depois de salvar. Gestores montam modelos em Templates de
                      tarefa.
                    </small>
                  )}
                  <label className="checkbox-label">
                    <Checkbox
                      checked={checklistRequired}
                      onCheckedChange={(v) => setChecklistRequired(v === true)}
                    />{" "}
                    Só entregar com o checklist concluído
                  </label>
                  {checklistRequired && (
                    <small className="checklist-create-hint" role="status">
                      A tarefa só vai para Em validação ou Entregue com todos os
                      itens marcados.
                      {!chosenChecklists.length &&
                        " Crie o checklist no painel da tarefa depois de salvar."}
                    </small>
                  )}
                </section>
                <section className="details-section" aria-label="Aprovação">
                  <h4>Aprovação</h4>
                  <label className="checkbox-label">
                    <Checkbox
                      checked={clientApproval}
                      onCheckedChange={(v) => setClientApproval(v === true)}
                    />{" "}
                    Exigir aprovação do cliente além da aprovação interna
                  </label>
                </section>
              </div>
            )}
          </fieldset>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {copilotOn && <CopilotBadge state={copilot} />}
          <div className="form-footer quick-task-footer">
            {!uploads.current.taskId && (
              <label className="checkbox-label create-another">
                <Checkbox
                  checked={createAnother}
                  onCheckedChange={(v) => setCreateAnother(v === true)}
                  disabled={saving}
                />
                Criar outra em seguida
              </label>
            )}
            <Button
              type="button"
              className="btn secondary"
              disabled={working}
              onClick={close}
            >
              {created > 0 ? "Fechar" : "Cancelar"}
            </Button>
            <Button
              className="btn primary"
              disabled={working || !contract}
              loading={working}
              title="Ctrl/⌘ + Enter"
            >
              {naming
                ? "Criando o título…"
                : uploads.current.taskId
                ? uploads.current.pending.length
                  ? "Reenviar anexos"
                  : "Concluir"
                : "Criar tarefa"}
              <Check size={17} />
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
              `${presetTitle} ${descriptionText}`.trim().length >= MIN_REVIEW
            }
          />
        )}
      </div>
    </Modal>
  );
}

/**
 * The MAVI's title for the task about to be saved. She has a few seconds;
 * after that (or when she fails, or in the demo) the start of what was
 * written or said is the title, so saving never gets stuck.
 */
async function taskTitle(input: {
  demo: boolean;
  company: string;
  contract: string;
  project: string | null;
  description: string;
  audio: string;
  hint: string;
}) {
  const fallback =
    fallbackTaskTitle(input.description) ||
    fallbackTaskTitle(input.audio.replace(/^Áudio \d+: /gm, "")) ||
    fallbackTaskTitle(input.hint);
  const safe = fallback.length >= 2 ? fallback : "Nova tarefa";
  if (input.demo) return safe;
  try {
    const title = await requestTaskTitle(
      {
        company: input.company,
        contract: input.contract,
        project: input.project,
        description: input.description,
        audio: input.audio,
        hint: input.hint,
      },
      TASK_TITLE_WAIT_MS,
    );
    return title.length >= 2 ? title : safe;
  } catch {
    return safe;
  }
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  );

/**
 * What a repetition will do, from today: when the first copy opens and its
 * due date (the same distance as this task's).
 */
function RepeatHint({
  frequency,
  due,
}: {
  frequency: RecurrenceFrequency;
  due: string;
}) {
  const today = dateKey();
  const first = nextRecurrence(frequency, today, today);
  const offset = Math.max(
    0,
    Math.round(
      (new Date(`${due}T12:00:00Z`).getTime() -
        new Date(`${today}T12:00:00Z`).getTime()) /
        86_400_000,
    ),
  );
  const firstDue = dateKey(
    new Date(new Date(`${first}T12:00:00Z`).getTime() + offset * 86_400_000),
  );
  return (
    <small className="repeat-hint" role="status">
      Uma cópia desta tarefa abre em {dateLabel(first)}
      {offset
        ? `, com prazo em ${dateLabel(firstDue)}`
        : ", com prazo no mesmo dia"}
      , e assim por diante até alguém parar a repetição. Anexos e imagens da
      descrição não são copiados; o checklist é copiado sem as marcações.
    </small>
  );
}
