import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Bug,
  Camera,
  Check,
  Lightbulb,
  Paperclip,
  Send,
  Settings2,
  X,
} from "lucide-react";
import { Modal, Loading } from "./components";
import { Button, Input, Select, SelectOption, Skeleton } from "./ui";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import {
  attachmentAccept,
  validateAttachment,
  uploadAttachment,
  saveTaskWithAttachments,
  type TaskUploadState,
} from "./attachments";
import { captureScreen } from "./screenshot";
import { richTextPlain } from "./rich-text";
import {
  guessResearchTeam,
  suggestionAssignees,
  suggestionKinds,
  suggestionTitle,
  withContext,
  type SuggestionKind,
} from "./suggestions";
import type { Snapshot } from "./types";
const RichTextEditor = lazy(() => import("./RichTextEditor"));
type Mutate = (name: string, args: Record<string, unknown>) => Promise<any>;

const kindIcons = { feature: Lightbulb, bug: Bug };

/**
 * "Sugestões": a new feature or a bug, for someone of the P&D team. It is
 * sent as a task (with its attachments and screenshots) in the place the
 * leaders chose in the settings.
 */
export function SuggestionDialog({
  demo,
  data,
  company,
  isLeader,
  busy,
  mutate,
  notify,
  onConfigure,
  onClose,
}: {
  demo: boolean;
  data: Snapshot;
  company: string;
  isLeader: boolean;
  busy: boolean;
  mutate: Mutate;
  notify: (message: string) => void;
  onConfigure: () => void;
  onClose: () => void;
}) {
  const configured = !!data.suggestionSettings?.length;
  const people = suggestionAssignees(data);
  const [kind, setKind] = useState<SuggestionKind>("feature");
  const [assignee, setAssignee] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [editorUploading, setEditorUploading] = useState(false);
  const uploads = useRef<TaskUploadState>({ pending: [] });
  const previews = useRef(new Map<File, string>());
  const form = useRef<HTMLFormElement>(null);
  const [, redraw] = useState(0);
  const redrawUploads = () => redraw((v) => v + 1);
  const locked = saving || !!uploads.current.taskId;
  const working = busy || saving || capturing || editorUploading;

  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  // Modal focuses the first input (here, the file picker) after mounting;
  // the choice of kind comes first.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      form.current
        ?.querySelector<HTMLElement>(".suggestion-kind.selected")
        ?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  const close = () => {
    if (!saving && !capturing && !editorUploading) onClose();
  };
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
  function remove(index: number) {
    const [file] = uploads.current.pending.splice(index, 1);
    const url = previews.current.get(file);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(file);
    redrawUploads();
  }
  const drop = useFileDrop(addFiles, !locked);
  // The picture leaves this dialog out: it shows the screen behind it.
  async function screenshot() {
    const dialog = form.current?.closest("dialog");
    setCapturing(true);
    setError("");
    try {
      const file = await captureScreen(dialog ? [dialog] : []);
      previews.current.set(file, URL.createObjectURL(file));
      addFiles([file]);
    } catch (e) {
      setError(
        `Não foi possível capturar a tela: ${(e as Error).message ?? e}`,
      );
    } finally {
      setCapturing(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (working) return;
    const description = String(
      new FormData(e.currentTarget).get("description") ?? "",
    );
    if (!richTextPlain(description)) {
      setError(
        kind === "bug"
          ? "Descreva o bug: o que você fez, o que esperava e o que aconteceu."
          : "Descreva a funcionalidade que você sugere.",
      );
      return;
    }
    if (!assignee) {
      setError("Escolha o responsável da equipe de P&D.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      await saveTaskWithAttachments(
        uploads.current,
        () =>
          mutate("submit_suggestion", {
            p_company: company,
            p_kind: kind,
            p_title: suggestionTitle(kind, description),
            p_description: withContext(description, {
              path: window.location.pathname,
              width: window.innerWidth,
              height: window.innerHeight,
              userAgent: navigator.userAgent,
            }),
            p_assignee: assignee,
          }),
        // The demo doesn't store files.
        demo ? async () => undefined : uploadAttachment,
        redrawUploads,
      );
      const name = people.find((p) => p.user_id === assignee)?.name;
      notify(
        `${kind === "bug" ? "Bug relatado" : "Sugestão enviada"}: virou uma tarefa para ${name ?? "a equipe de P&D"}.`,
      );
      onClose();
    } catch (e) {
      const message = (e as Error).message ?? "Não foi possível enviar.";
      setError(
        uploads.current.taskId
          ? `A tarefa foi criada. ${message} Tente reenviar os anexos pendentes ou feche para continuar depois.`
          : message,
      );
    } finally {
      setSaving(false);
    }
  }

  if (!configured)
    return (
      <Modal title="Sugestões" onClose={onClose}>
        <div className="suggestion-empty">
          <Lightbulb size={26} />
          <strong>As sugestões ainda não foram configuradas</strong>
          <p>
            {isLeader
              ? "Escolha a equipe de P&D e onde as tarefas de sugestão devem ficar."
              : "Peça a um administrador ou gestor para escolher a equipe de P&D em Configurações."}
          </p>
          {isLeader && (
            <Button className="btn primary" onClick={onConfigure}>
              <Settings2 size={16} /> Configurar sugestões
            </Button>
          )}
        </div>
      </Modal>
    );
  return (
    <Modal title="Sugestões" onClose={close} busy={saving || capturing}>
      <form
        ref={form}
        className="entity-form suggestion-form"
        onSubmit={submit}
        {...drop.handlers}
      >
        {drop.active && (
          <DropOverlay
            label="Solte para anexar à sugestão"
            hint="Os arquivos vão junto com a tarefa"
          />
        )}
        <fieldset className="create-fields" disabled={locked}>
          <div
            className="suggestion-kinds"
            role="radiogroup"
            aria-label="Tipo de sugestão"
          >
            {(Object.keys(suggestionKinds) as SuggestionKind[]).map((k) => {
              const Icon = kindIcons[k];
              return (
                <button
                  type="button"
                  key={k}
                  role="radio"
                  aria-checked={kind === k}
                  aria-label={suggestionKinds[k].label}
                  className={`suggestion-kind ${k} ${kind === k ? "selected" : ""}`}
                  onClick={() => setKind(k)}
                >
                  <Icon size={20} />
                  <span>
                    <strong>{suggestionKinds[k].label}</strong>
                    <small>{suggestionKinds[k].hint}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <Suspense fallback={<Loading compact />}>
            <RichTextEditor
              name="description"
              label="Descrição"
              company={company}
              demo={demo}
              onUploading={setEditorUploading}
              disabled={locked}
            />
          </Suspense>
          <small className="suggestion-hint">
            {kind === "bug"
              ? "Conte o que você fez, o que esperava e o que aconteceu. A página e o navegador vão junto."
              : "Conte o problema que a funcionalidade resolve e como imagina que funcione."}
          </small>
          <label>
            Responsável (P&D)
            <Select value={assignee} onValueChange={setAssignee} required>
              <SelectOption value="">Escolha quem vai cuidar</SelectOption>
              {people.map((m) => (
                <SelectOption key={m.user_id} value={m.user_id}>
                  {m.name}
                </SelectOption>
              ))}
            </Select>
          </label>
          {!people.length && (
            <p className="form-error" role="alert">
              A equipe de P&D não tem membros ativos. Inclua alguém nela em
              Configurações.
            </p>
          )}
        </fieldset>
        <section className="creation-attachments" aria-label="Anexos">
          <div className="suggestion-attach">
            <label
              className={`upload-zone creation-upload ${locked ? "disabled" : ""}`}
            >
              <Paperclip size={17} /> Adicionar anexos{" "}
              <span className="upload-zone-hint">ou arraste para cá</span>
              <Input
                type="file"
                multiple
                accept={attachmentAccept}
                disabled={locked}
                onChange={(e) => {
                  addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <Button
              type="button"
              className="btn secondary suggestion-shot"
              onClick={screenshot}
              disabled={locked || capturing}
              loading={capturing}
              title="Captura a tela atual, sem esta janela"
            >
              <Camera size={16} /> Screenshot
            </Button>
          </div>
          <small>
            {demo
              ? "No modo demonstração os anexos e capturas não são armazenados."
              : "Até 20 MB por arquivo. A captura mostra a tela atrás desta janela."}
          </small>
          {uploads.current.pending.map((file, index) => {
            const preview = previews.current.get(file);
            return (
              <div
                className={`pending-file ${preview ? "with-preview" : ""}`}
                key={`${file.name}-${file.size}-${file.lastModified}`}
              >
                {preview ? (
                  <img src={preview} alt={`Prévia de ${file.name}`} />
                ) : (
                  <Paperclip size={15} />
                )}
                <span>
                  {file.name}
                  <small>{(file.size / 1024).toFixed(1)} KB</small>
                </span>
                <Button
                  type="button"
                  className="icon-btn"
                  aria-label={`Remover ${file.name}`}
                  disabled={saving}
                  onClick={() => remove(index)}
                >
                  <X size={16} />
                </Button>
              </div>
            );
          })}
          {saving && uploads.current.taskId && (
            <div role="status" aria-label="Enviando anexos">
              <Skeleton className="skeleton-title" />
            </div>
          )}
        </section>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button
            type="button"
            className="btn secondary"
            disabled={saving || capturing}
            onClick={close}
          >
            Cancelar
          </Button>
          <Button
            className="btn primary"
            disabled={working || !people.length}
            loading={saving}
          >
            {uploads.current.taskId ? (
              <>
                Reenviar anexos <Check size={17} />
              </>
            ) : (
              <>
                Enviar <Send size={16} />
              </>
            )}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Settings panel (leaders): the P&D team and where suggestions go. */
export function SuggestionSettingsPanel({
  data,
  company,
  mutate,
  notify,
}: {
  data: Snapshot;
  company: string;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const current = data.suggestionSettings?.[0];
  const [team, setTeam] = useState(
    current?.team_id ?? guessResearchTeam(data) ?? "",
  );
  const [contract, setContract] = useState(current?.contract_id ?? "");
  const [project, setProject] = useState(current?.project_id ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Contracts of the clients the team serves (the same rule as tasks).
  const contracts = data.contracts.filter(
    (c) =>
      !c.archived &&
      data.clientTeams.some(
        (ct) => ct.client_id === c.client_id && ct.team_id === team,
      ),
  );
  const projects = data.projects.filter(
    (p) => p.contract_id === contract && !p.archived,
  );
  // "Cliente — produto", unless the contract's name already says the client.
  const contractLabel = (c: Snapshot["contracts"][number]) => {
    const client = data.clients.find((cl) => cl.id === c.client_id)?.name;
    return client && !c.name.includes(client)
      ? `${client} — ${c.name}`
      : c.name;
  };
  const members = data.teamMembers.filter((tm) => tm.team_id === team).length;
  const changed =
    team !== (current?.team_id ?? "") ||
    contract !== (current?.contract_id ?? "") ||
    project !== (current?.project_id ?? "");
  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await mutate("save_suggestion_settings", {
        p_company: company,
        p_team: team,
        p_contract: contract,
        p_project: project || null,
      });
      notify("Sugestões configuradas.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel" id="config-sugestoes">
      <div className="panel-heading">
        <div>
          <h2>Sugestões</h2>
          <p>Quem recebe novas funcionalidades e bugs, e onde viram tarefas</p>
        </div>
      </div>
      <form className="entity-form suggestion-settings" onSubmit={save}>
        <label>
          Equipe de P&D
          <Select
            value={team}
            onValueChange={(v) => {
              setTeam(v);
              setContract("");
              setProject("");
            }}
            required
          >
            <SelectOption value="">Escolha a equipe</SelectOption>
            {data.teams.map((t) => (
              <SelectOption key={t.id} value={t.id}>
                {t.name}
              </SelectOption>
            ))}
          </Select>
          {team && (
            <small>
              {members === 1
                ? "1 pessoa pode ser responsável."
                : `${members} pessoas podem ser responsáveis.`}
            </small>
          )}
        </label>
        <label>
          Cliente e produto das tarefas
          <Select
            value={contract}
            onValueChange={(v) => {
              setContract(v);
              setProject("");
            }}
            disabled={!team || !contracts.length}
            required
          >
            <SelectOption value="">
              {team && !contracts.length
                ? "Esta equipe não atende nenhum cliente"
                : "Escolha onde as tarefas ficam"}
            </SelectOption>
            {contracts.map((c) => (
              <SelectOption key={c.id} value={c.id}>
                {contractLabel(c)}
              </SelectOption>
            ))}
          </Select>
        </label>
        <label>
          Projeto (opcional)
          <Select
            value={project}
            onValueChange={setProject}
            disabled={!contract}
          >
            <SelectOption value="">Sem projeto</SelectOption>
            {projects.map((p) => (
              <SelectOption key={p.id} value={p.id}>
                {p.name}
              </SelectOption>
            ))}
          </Select>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <Button
            className="btn primary"
            disabled={saving || !team || !contract || !changed}
            loading={saving}
          >
            <Check size={16} /> Salvar
          </Button>
        </div>
      </form>
    </section>
  );
}
