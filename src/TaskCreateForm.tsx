import { Input, Select, SelectOption, Checkbox, Button, Skeleton } from "./ui";
import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Check, ChevronDown, Paperclip, X } from "lucide-react";
import { Modal, Loading } from "./components";
import { ContractPicker } from "./ContractPicker";
import { type Snapshot, priorities } from "./types";
import { canCreateTaskIn, dateKey } from "./domain";
import {
  attachmentAccept,
  validateAttachment,
  uploadAttachment,
  saveTaskWithAttachments,
  type TaskUploadState,
} from "./attachments";
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
 * Task creation keeps only what the backend requires up front (title,
 * contracted product, assignee and due date — all but the title prefilled);
 * everything else lives behind "Adicionar detalhes".
 */
export function TaskCreateForm({
  initialContract,
  initialProject,
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
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState(user);
  const [due, setDue] = useState(dateKey());
  const [showDetails, setShowDetails] = useState(false);
  const [detailsMounted, setDetailsMounted] = useState(false);
  const [createAnother, setCreateAnother] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [created, setCreated] = useState(0);
  const [error, setError] = useState("");
  const uploads = useRef<TaskUploadState>({ pending: [] });
  const submitting = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [editorUploading, setEditorUploading] = useState(false);
  const [, updateUploads] = useState(0);
  const redrawUploads = () => updateUploads((v) => v + 1);
  const locked = saving || !!uploads.current.taskId;
  const working = busy || saving || editorUploading;
  const activeMembers = data.members.filter((m) => m.active);
  const me = activeMembers.find((m) => m.user_id === user);

  // Modal opens the dialog in its own (later) effect, which steals focus.
  useEffect(() => {
    const id = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);
  const close = () => {
    if (!submitting.current && !editorUploading) onClose();
  };
  function toggleDetails() {
    setDetailsMounted(true);
    setShowDetails((v) => !v);
  }
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
  function resetForNext() {
    uploads.current = { pending: [] };
    setTitle("");
    setFormKey((v) => v + 1);
    setCreated((v) => v + 1);
    redrawUploads();
    requestAnimationFrame(() => titleRef.current?.focus());
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current || editorUploading) return;
    setError("");
    const f = new FormData(e.currentTarget),
      s = (key: string) => String(f.get(key) ?? "");
    const args = {
      p_company: company,
      p_contract: contract,
      p_title: title.trim(),
      p_assignee: assignee,
      p_due: due,
      p_start: s("start_date") || null,
      p_project: project || null,
      p_team: s("team") || null,
      p_description: s("description"),
      p_priority: s("priority") || "normal",
      p_estimated: Number(s("estimated")) * 60,
      p_client_approval: f.has("client_approval"),
      p_parent: s("parent") || null,
    };
    submitting.current = true;
    setSaving(true);
    try {
      await saveTaskWithAttachments(
        uploads.current,
        () => mutate("create_task", args),
        uploadAttachment,
        redrawUploads,
      );
      rememberContract(contract);
      if (createAnother) resetForNext();
      else onClose();
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
  function submitShortcut(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.currentTarget.requestSubmit();
    }
  }
  return (
    <Modal title="Nova tarefa" onClose={close} busy={saving || editorUploading}>
      <form
        className="entity-form quick-task"
        onSubmit={submit}
        onKeyDown={submitShortcut}
      >
        <fieldset className="create-fields" disabled={locked}>
          <Input
            ref={titleRef}
            className="quick-task-title"
            aria-label="Nome da tarefa"
            placeholder="O que precisa ser feito?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            minLength={2}
            maxLength={240}
          />
          {created > 0 && (
            <small className="quick-task-created" role="status">
              <Check size={14} />
              {created === 1
                ? "Tarefa criada. Pode escrever a próxima."
                : `${created} tarefas criadas. Pode escrever a próxima.`}
            </small>
          )}
          {contract ? (
            <ContractPicker
              data={data}
              contract={contract}
              onContractChange={setContract}
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
            <label>
              Responsável
              <Select required value={assignee} onValueChange={setAssignee}>
                {me && (
                  <SelectOption value={me.user_id}>Eu ({me.name})</SelectOption>
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
            </div>
          </div>
          <Suspense fallback={<Loading compact />}>
            <RichTextEditor
              key={formKey}
              company={company}
              demo={demo}
              onUploading={setEditorUploading}
              disabled={locked}
            />
          </Suspense>
        </fieldset>
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
            {!showDetails && <small>prioridade, estimativa, equipe…</small>}
          </button>
          {detailsMounted && (
            <div
              id="task-details"
              className="quick-task-details"
              hidden={!showDetails}
              key={formKey}
            >
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
                    placeholder="0"
                  />
                </label>
              </div>
              <div className="form-columns">
                <label>
                  Equipe
                  <Select name="team" key={contract}>
                    <SelectOption value="">Sem equipe principal</SelectOption>
                    {data.teams
                      .filter((t) =>
                        data.clientTeams.some(
                          (ct) =>
                            ct.client_id === contractClient &&
                            ct.team_id === t.id,
                        ),
                      )
                      .map((t) => (
                        <SelectOption key={t.id} value={t.id}>
                          {t.name}
                        </SelectOption>
                      ))}
                  </Select>
                </label>
                <label>
                  Tarefa principal
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
              </div>
              <div className="form-columns">
                <label>
                  Início planejado
                  <Input name="start_date" type="date" />
                </label>
              </div>
              <label className="checkbox-label">
                <Checkbox name="client_approval" /> Exigir aprovação do cliente
                além da aprovação interna
              </label>
            </div>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
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
            title="Enter no título ou Ctrl/⌘ + Enter"
          >
            {uploads.current.taskId
              ? uploads.current.pending.length
                ? "Reenviar anexos"
                : "Concluir"
              : "Criar tarefa"}
            <Check size={17} />
          </Button>
        </div>
      </form>
    </Modal>
  );
}
