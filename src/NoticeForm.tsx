import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  CloudUpload,
  File as FileIcon,
  HardDrive,
  Plus,
  Search,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { DropOverlay, useFileDrop } from "./useFileDrop";
import { formatBytes, searchDriveFiles } from "./drive";
import { LEVEL_ICONS, TemplateName } from "./NoticeParts";
import { NoticeMavi } from "./NoticeMavi";
import {
  ATTACHMENT_MAX_BYTES,
  audienceEstimate,
  contentOf,
  emptyNotice,
  FORMATS,
  fromTemplate,
  fromLocalInput,
  LEVELS,
  MAX_ATTACHMENTS,
  MODES,
  noticeScope,
  REPEATS,
  templateOf,
  toLocalInput,
  type NoticeContent,
  type NoticeDetail,
  type NoticeLevel,
  type NoticeSaveResult,
  type NoticesApi,
  type NoticeTarget,
  type NoticeTemplate,
  type TargetKind,
  type TargetMode,
} from "./notices";
import type { DriveFile, Snapshot } from "./types";

const RichTextEditor = lazy(() => import("./RichTextEditor"));

type Queued = { key: string; file: File; progress: number; error?: string };
type DrivePick = Pick<DriveFile, "id" | "name" | "size_bytes">;

const KIND_LABEL: Record<Exclude<TargetKind, "everyone">, string> = {
  user: "Pessoa",
  team: "Equipe",
  client: "Cliente",
  project: "Projeto",
};

/**
 * Criar ou editar um aviso do Mural. Salva o aviso primeiro (como rascunho
 * quando há anexos novos, para eles terem onde ficar), envia os anexos com o
 * progresso de cada um e só então publica — assim ninguém recebe um aviso
 * sem os arquivos. Se um envio falhar, o rascunho fica salvo: tentar de novo
 * só reenvia o que faltou.
 */
export function NoticeForm({
  api,
  company,
  data,
  user,
  demo,
  detail,
  preset,
  template: startTemplate,
  onClose,
  onSaved,
}: {
  api: NoticesApi;
  company: string;
  data: Snapshot;
  user: string;
  demo: boolean;
  /** O aviso em edição (null: um novo). */
  detail: NoticeDetail | null;
  /** Um aviso novo que já começa preenchido (modelo ou duplicado). */
  preset?: NoticeContent;
  /** O modelo de onde veio (quem pode editá-lo também o atualiza daqui). */
  template?: NoticeTemplate;
  onClose: () => void;
  onSaved: (result: NoticeSaveResult, published: boolean) => void;
}) {
  const [form, setForm] = useState<NoticeContent>(
    detail ? contentOf(detail) : (preset ?? emptyNotice()),
  );
  // O editor não é controlado: trocar o texto por fora o monta de novo.
  const [editorKey, setEditorKey] = useState(0);
  const [templates, setTemplates] = useState<NoticeTemplate[]>([]);
  const [template, setTemplate] = useState<NoticeTemplate | undefined>(
    startTemplate,
  );
  const [naming, setNaming] = useState(false);
  const [replaceTemplate, setReplaceTemplate] = useState(true);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateNote, setTemplateNote] = useState("");
  const [when, setWhen] = useState<"now" | "later">(
    detail?.status === "scheduled" ? "later" : "now",
  );
  const [renotify, setRenotify] = useState(false);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [drive, setDrive] = useState<DrivePick[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saved = useRef<{ id: string; version: number } | null>(
    detail ? { id: detail.id, version: detail.version } : null,
  );
  const formRef = useRef<HTMLFormElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const scope = useMemo(() => noticeScope(data, user), [data, user]);
  const status = detail?.status ?? "draft";
  const live = status === "live";
  const existing = (detail?.attachments ?? []).filter(
    (a) => !remove.includes(a.id),
  );
  const count =
    existing.length + queue.filter((q) => !q.error).length + drive.length;
  const set = <K extends keyof NoticeContent>(k: K, v: NoticeContent[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const estimate = audienceEstimate(form, data, detail?.created_by ?? user);
  const readBody = () =>
    (formRef.current?.elements.namedItem("body") as HTMLInputElement | null)
      ?.value ?? form.body;
  // Um aviso novo pode começar de um modelo da agência.
  useEffect(() => {
    if (detail || preset) return;
    let alive = true;
    api
      .templates(company)
      .then((list) => alive && setTemplates(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, company, detail, preset]);
  function startFromTemplate(id: string) {
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    setForm(fromTemplate(t.content));
    setTemplate(t);
    setEditorKey((k) => k + 1);
  }
  async function saveAsTemplate(name: string) {
    setSavingTemplate(true);
    setTemplateNote("");
    try {
      const content = templateOf({ ...form, body: readBody() });
      const replace = !!template?.can_edit && replaceTemplate;
      await api.saveTemplate(
        company,
        replace ? template!.id : null,
        name,
        content,
      );
      setNaming(false);
      setTemplateNote(
        replace ? `Modelo “${name}” atualizado.` : `Modelo “${name}” salvo.`,
      );
    } catch (e) {
      setTemplateNote(
        (e as Error).message || "Não foi possível salvar o modelo.",
      );
    } finally {
      setSavingTemplate(false);
    }
  }

  const addFiles = (files: File[]) => {
    const bad = files.filter(
      (f) => f.size === 0 || f.size > ATTACHMENT_MAX_BYTES,
    );
    if (bad.length)
      setError(
        `${bad.map((f) => f.name).join(", ")}: envie arquivos não vazios de até 500 MB.`,
      );
    const room = Math.max(0, MAX_ATTACHMENTS - count);
    const good = files.filter((f) => !bad.includes(f)).slice(0, room);
    if (files.length - bad.length > room)
      setError(`Um aviso pode ter até ${MAX_ATTACHMENTS} anexos.`);
    setQueue((q) => [
      ...q,
      ...good.map((file) => ({
        key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        progress: 0,
      })),
    ]);
  };
  const drop = useFileDrop(addFiles, !busy);

  function pickLevel(level: NoticeLevel) {
    // O nível sugere os formatos; quem cria ainda ajusta um a um.
    setForm((f) => ({
      ...f,
      level,
      ...LEVELS[level].formats,
      require_ack: LEVELS[level].ack,
    }));
  }

  async function submit(publish: boolean) {
    setError("");
    const body = readBody();
    const content: NoticeContent = {
      ...form,
      title: form.title.trim(),
      body,
      publish_at: when === "later" ? form.publish_at : "",
      repeat: publish ? form.repeat : "",
    };
    if (content.title.length < 2) return setError("Dê um título ao aviso.");
    if (!content.targets.length)
      return setError("Escolha quem recebe o aviso.");
    if (publish && when === "later" && !content.publish_at)
      return setError("Escolha quando o aviso é publicado.");
    if (
      content.expires_at &&
      new Date(content.expires_at).getTime() <=
        (content.publish_at
          ? new Date(content.publish_at).getTime()
          : Date.now())
    )
      return setError("A saída do ar precisa ser depois da publicação.");
    const files =
      queue.some((q) => q.progress < 1 || !!q.error) || drive.length > 0;
    setBusy(true);
    try {
      if (!saved.current && !files) {
        const r = await api.save(company, null, content, publish, false);
        saved.current = { id: r.id, version: r.version };
        return onSaved(r, publish);
      }
      // Anexos num aviso que ainda não existe: primeiro um rascunho, para
      // ninguém receber o aviso sem os arquivos.
      if (!saved.current) {
        const r = await api.save(company, null, content, false, false);
        saved.current = { id: r.id, version: r.version };
      }
      const id = saved.current.id;
      for (const a of remove) await api.removeAttachment(a);
      setRemove([]);
      for (const f of drive) await api.addDriveFile(id, f.id);
      setDrive([]);
      for (const item of queue) {
        if (item.progress === 1 && !item.error) continue;
        try {
          await api.upload(id, item.file, (progress) =>
            setQueue((q) =>
              q.map((x) => (x.key === item.key ? { ...x, progress } : x)),
            ),
          );
          setQueue((q) =>
            q.map((x) =>
              x.key === item.key ? { ...x, progress: 1, error: undefined } : x,
            ),
          );
        } catch (e) {
          setQueue((q) =>
            q.map((x) =>
              x.key === item.key
                ? { ...x, progress: 0, error: (e as Error).message }
                : x,
            ),
          );
          throw Error(
            `${live ? "O aviso continua no ar" : "O aviso ficou salvo como rascunho"}, mas ${item.file.name} não foi enviado: ${(e as Error).message} Tente de novo.`,
          );
        }
      }
      const r = await api.save(
        company,
        id,
        content,
        publish,
        live && renotify,
        saved.current.version,
      );
      saved.current = { id: r.id, version: r.version };
      onSaved(r, publish);
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar o aviso.");
    } finally {
      setBusy(false);
    }
  }

  const title = !detail
    ? "Novo aviso"
    : live
      ? "Editar aviso no ar"
      : "Editar aviso";
  const primary = live
    ? renotify
      ? "Salvar e avisar de novo"
      : "Salvar"
    : when === "later"
      ? "Agendar"
      : "Publicar agora";

  return (
    <Modal
      title={title}
      onClose={onClose}
      busy={busy}
      className="notice-form-modal"
    >
      <form
        ref={formRef}
        className="entity-form notice-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(true);
        }}
        {...drop.handlers}
      >
        {drop.active && (
          <DropOverlay
            label="Solte para anexar ao aviso"
            hint="Imagens, PDFs, qualquer arquivo"
          />
        )}
        {!detail && !preset && templates.length > 0 && (
          <label>
            Começar de um modelo
            <Select
              value={template?.id ?? ""}
              onValueChange={startFromTemplate}
              aria-label="Começar de um modelo"
              disabled={busy}
            >
              <SelectOption value="">Aviso em branco</SelectOption>
              {templates.map((t) => (
                <SelectOption key={t.id} value={t.id}>
                  {t.name}
                </SelectOption>
              ))}
            </Select>
          </label>
        )}
        <NoticeMavi
          api={api}
          company={company}
          data={data}
          scope={scope}
          demo={demo}
          title={form.title}
          readBody={readBody}
          onText={(title, body) => {
            setForm((f) => ({
              ...f,
              title: title ?? f.title,
              body: body ?? readBody(),
            }));
            if (body !== undefined) setEditorKey((k) => k + 1);
          }}
          onFormats={({ level, formats, require_ack }) =>
            setForm((f) => ({
              ...f,
              level: level ?? f.level,
              ...(formats ?? {}),
              require_ack: require_ack ?? f.require_ack,
            }))
          }
          onTargets={(targets) =>
            setForm((f) => {
              const everyone = targets.some((t) => t.kind === "everyone");
              const merged = everyone
                ? [{ kind: "everyone" as const }]
                : [
                    ...f.targets.filter((t) => t.kind !== "everyone"),
                    ...targets.filter(
                      (t) =>
                        !f.targets.some(
                          (x) => x.kind === t.kind && x.id === t.id,
                        ),
                    ),
                  ];
              return { ...f, body: readBody(), targets: merged };
            })
          }
        />
        <label>
          Título
          <input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Ex.: Sexta-feira não teremos expediente"
            maxLength={160}
            required
            disabled={busy}
            autoFocus={!detail}
          />
        </label>
        <Suspense
          fallback={
            <>
              <input type="hidden" name="body" value={form.body} />
              <Loading compact />
            </>
          }
        >
          <RichTextEditor
            key={editorKey}
            name="body"
            label="Mensagem"
            company={company}
            demo={demo}
            images={false}
            defaultValue={form.body}
            disabled={busy}
          />
        </Suspense>

        <fieldset className="notice-block">
          <legend>Nível</legend>
          <div
            className="notice-levels"
            role="radiogroup"
            aria-label="Nível do aviso"
          >
            {(Object.keys(LEVELS) as NoticeLevel[]).map((l) => {
              const Icon = LEVEL_ICONS[l];
              return (
                <button
                  type="button"
                  key={l}
                  role="radio"
                  aria-checked={form.level === l}
                  className={`notice-level-pick ${l} ${form.level === l ? "selected" : ""}`}
                  onClick={() => pickLevel(l)}
                  disabled={busy}
                >
                  <Icon size={16} aria-hidden="true" />
                  <strong>{LEVELS[l].label}</strong>
                  <small>{LEVELS[l].hint}</small>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="notice-block">
          <legend>Como chega</legend>
          <small>Todo aviso também fica no Mural de quem o recebe.</small>
          <div className="notice-formats">
            {FORMATS.map((f) => (
              <label className="notice-format" key={f.key}>
                <Checkbox
                  checked={form[f.key]}
                  onCheckedChange={(v) => set(f.key, v === true)}
                  disabled={busy}
                  aria-label={f.label}
                />
                <span>
                  <strong>{f.label}</strong>
                  <small>{f.hint}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="notice-options">
            <label className="checkbox-label">
              <Checkbox
                checked={form.require_ack}
                onCheckedChange={(v) => set("require_ack", v === true)}
                disabled={busy}
              />
              Pedir “Li e entendi” (o popup volta até a pessoa confirmar; ela
              pode adiar para o dia seguinte)
            </label>
            <label className="checkbox-label">
              <Checkbox
                checked={form.pinned}
                onCheckedChange={(v) => set("pinned", v === true)}
                disabled={busy}
              />
              Fixar no topo do Mural enquanto estiver no ar
            </label>
          </div>
        </fieldset>

        <AudiencePicker
          data={data}
          scope={scope}
          targets={form.targets}
          exclude={form.exclude}
          creator={detail?.created_by ?? user}
          disabled={busy}
          onTargets={(t) => set("targets", t)}
          onExclude={(x) => set("exclude", x)}
          estimate={estimate}
        />

        <fieldset className="notice-block">
          <legend>Quando</legend>
          {live ? (
            <small>
              No ar desde{" "}
              {new Date(detail!.publish_at!).toLocaleString("pt-BR")}.
            </small>
          ) : (
            <div className="notice-when">
              <div
                className="notice-segment"
                role="radiogroup"
                aria-label="Quando publicar"
              >
                {(
                  [
                    ["now", "Publicar agora"],
                    ["later", "Agendar"],
                  ] as const
                ).map(([value, text]) => (
                  <button
                    type="button"
                    key={value}
                    role="radio"
                    aria-checked={when === value}
                    className={when === value ? "selected" : ""}
                    onClick={() => setWhen(value)}
                    disabled={busy}
                  >
                    {text}
                  </button>
                ))}
              </div>
              {when === "later" && (
                <Input
                  type="datetime-local"
                  aria-label="Publicar em"
                  value={toLocalInput(form.publish_at)}
                  onChange={(e) =>
                    set("publish_at", fromLocalInput(e.target.value))
                  }
                  disabled={busy}
                />
              )}
            </div>
          )}
          <div className="form-columns">
            <label>
              Sai do ar em (opcional)
              <Input
                type="datetime-local"
                value={toLocalInput(form.expires_at)}
                onChange={(e) =>
                  set("expires_at", fromLocalInput(e.target.value))
                }
                disabled={busy}
              />
            </label>
            <label>
              Repetir
              <Select
                value={form.repeat}
                onValueChange={(v) =>
                  set("repeat", v as NoticeContent["repeat"])
                }
                aria-label="Repetir"
                disabled={busy}
              >
                <SelectOption value="">Não repetir</SelectOption>
                {REPEATS.map((r) => (
                  <SelectOption key={r.value} value={r.value}>
                    {r.label}
                  </SelectOption>
                ))}
              </Select>
            </label>
          </div>
          {!!form.repeat && (
            <small>
              A cada repetição, no horário da publicação, o aviso volta como não
              visto para todos, até sair do ar ou ser encerrado.
            </small>
          )}
        </fieldset>

        <fieldset className="notice-block">
          <legend>Anexos</legend>
          <small>
            Imagens aparecem no aviso; outros arquivos viram um botão de baixar.
            Até {MAX_ATTACHMENTS} anexos de 500 MB.
          </small>
          <ul className="case-upload-list">
            {(detail?.attachments ?? []).map((a) => {
              const off = remove.includes(a.id);
              return (
                <li key={a.id} className={off ? "removing" : ""}>
                  {a.source === "drive" ? (
                    <HardDrive size={16} />
                  ) : (
                    <FileIcon size={16} />
                  )}
                  <span>
                    {a.name}
                    <small>
                      {formatBytes(a.size_bytes)}
                      {a.source === "drive" ? " · do Drive" : ""}
                      {off ? " · será removido" : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={off ? `Manter ${a.name}` : `Tirar ${a.name}`}
                    onClick={() =>
                      setRemove((r) =>
                        off ? r.filter((x) => x !== a.id) : [...r, a.id],
                      )
                    }
                    disabled={busy}
                  >
                    {off ? <Undo2 size={15} /> : <Trash2 size={15} />}
                  </button>
                </li>
              );
            })}
            {drive.map((f) => (
              <li key={f.id}>
                <HardDrive size={16} />
                <span>
                  {f.name}
                  <small>{formatBytes(f.size_bytes)} · do Drive</small>
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Não anexar ${f.name}`}
                  onClick={() =>
                    setDrive((d) => d.filter((x) => x.id !== f.id))
                  }
                  disabled={busy}
                >
                  <X size={15} />
                </button>
              </li>
            ))}
            {queue.map((q) => (
              <li
                key={q.key}
                className={q.error ? "failed" : q.progress === 1 ? "sent" : ""}
              >
                <CloudUpload size={16} />
                <span>
                  {q.file.name}
                  <small>
                    {formatBytes(q.file.size)}
                    {q.error
                      ? ` · ${q.error}`
                      : q.progress === 1
                        ? " · enviado"
                        : busy && q.progress > 0
                          ? ` · ${Math.round(q.progress * 100)}%`
                          : " · novo"}
                  </small>
                  {busy && q.progress > 0 && q.progress < 1 && (
                    <span
                      className="case-progress"
                      style={{ ["--p" as string]: q.progress }}
                    />
                  )}
                </span>
                {q.progress < 1 && (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Não enviar ${q.file.name}`}
                    onClick={() =>
                      setQueue((list) => list.filter((x) => x.key !== q.key))
                    }
                    disabled={busy}
                  >
                    <X size={15} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="notice-attach-actions">
            <button
              type="button"
              className="case-drop"
              onClick={() => fileInput.current?.click()}
              disabled={busy || count >= MAX_ATTACHMENTS}
            >
              <CloudUpload size={20} />
              <span>
                <strong>Enviar arquivos</strong> ou arraste para cá
              </span>
            </button>
            {!demo && (
              <DriveSearch
                company={company}
                disabled={busy || count >= MAX_ATTACHMENTS}
                picked={drive.map((d) => d.id)}
                onPick={(f) =>
                  setDrive((d) =>
                    d.some((x) => x.id === f.id) ? d : [...d, f],
                  )
                }
              />
            )}
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </fieldset>

        {naming && (
          <div className="notice-template-save">
            {template?.can_edit && (
              <label className="checkbox-label">
                <Checkbox
                  checked={replaceTemplate}
                  onCheckedChange={(v) => setReplaceTemplate(v === true)}
                  disabled={savingTemplate}
                />
                Atualizar o modelo “{template.name}” (senão, cria outro)
              </label>
            )}
            <TemplateName
              initial={template?.name ?? form.title}
              busy={savingTemplate}
              onCancel={() => setNaming(false)}
              onSave={(name) => void saveAsTemplate(name)}
            />
          </div>
        )}
        {templateNote && <p className="notice-template-note">{templateNote}</p>}
        {error && <p className="form-error">{error}</p>}
        <div className="form-footer notice-form-footer">
          {!naming && (
            <button
              type="button"
              className="text-btn notice-save-template"
              onClick={() => {
                setTemplateNote("");
                setNaming(true);
              }}
              disabled={busy}
              title="Guarda o texto, os formatos e o público (sem datas nem anexos) para os líderes reusarem"
            >
              Salvar como modelo
            </button>
          )}
          {live && (
            <label className="checkbox-label notice-renotify">
              <Checkbox
                checked={renotify}
                onCheckedChange={(v) => setRenotify(v === true)}
                disabled={busy}
              />
              Avisar todos de novo (volta como não visto)
            </label>
          )}
          <Button
            type="button"
            className="btn secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancelar
          </Button>
          {!live && (
            <Button
              type="button"
              className="btn secondary"
              onClick={() => void submit(false)}
              disabled={busy}
            >
              Salvar rascunho
            </Button>
          )}
          <Button type="submit" className="btn primary" loading={busy}>
            {primary}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Quem recebe: soma de pessoas, equipes, clientes e projetos, com exclusões. */
function AudiencePicker({
  data,
  scope,
  targets,
  exclude,
  creator,
  disabled,
  onTargets,
  onExclude,
  estimate,
}: {
  data: Snapshot;
  scope: ReturnType<typeof noticeScope>;
  targets: NoticeTarget[];
  exclude: string[];
  creator: string;
  disabled: boolean;
  onTargets: (t: NoticeTarget[]) => void;
  onExclude: (x: string[]) => void;
  estimate: { people: number; assignees: boolean };
}) {
  const [kind, setKind] = useState<Exclude<TargetKind, "everyone">>(
    scope.teams.length ? "team" : "user",
  );
  const [mode, setMode] = useState<TargetMode>("both");
  const everyone = targets.some((t) => t.kind === "everyone");
  const has = (k: TargetKind, id: string) =>
    targets.some((t) => t.kind === k && t.id === id);
  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Pessoa";
  const projectLabel = (id: string) => {
    const p = data.projects.find((x) => x.id === id);
    const k = data.contracts.find((c) => c.id === p?.contract_id);
    const c = data.clients.find((x) => x.id === k?.client_id);
    return p ? `${p.name}${c ? ` · ${c.name}` : ""}` : "Projeto";
  };
  const label = (t: NoticeTarget) =>
    t.kind === "everyone"
      ? "Todos da agência"
      : t.kind === "user"
        ? memberName(t.id!)
        : t.kind === "team"
          ? (data.teams.find((x) => x.id === t.id)?.name ?? "Equipe")
          : t.kind === "client"
            ? (data.clients.find((x) => x.id === t.id)?.name ?? "Cliente")
            : projectLabel(t.id!);
  const options: { value: string; label: string }[] = (
    kind === "user"
      ? scope.users
          .filter((u) => u !== creator)
          .map((u) => ({ value: u, label: memberName(u) }))
      : kind === "team"
        ? scope.teams.map((id) => ({
            value: id,
            label: data.teams.find((t) => t.id === id)?.name ?? "Equipe",
          }))
        : kind === "client"
          ? scope.clients.map((id) => ({
              value: id,
              label: data.clients.find((c) => c.id === id)?.name ?? "Cliente",
            }))
          : scope.projects.map((id) => ({ value: id, label: projectLabel(id) }))
  )
    .filter((o) => !has(kind, o.value))
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  const add = (id: string) => {
    if (!id) return;
    onTargets([
      ...targets,
      {
        kind,
        id,
        ...(kind === "client" || kind === "project" ? { mode } : {}),
      },
    ]);
  };
  const excludable = data.members
    .filter(
      (m) => m.active && m.user_id !== creator && !exclude.includes(m.user_id),
    )
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <fieldset className="notice-block">
      <legend>Quem recebe</legend>
      <small>
        Os públicos se somam. Quem entrar depois numa equipe, cliente ou projeto
        escolhido também recebe enquanto o aviso estiver no ar.
      </small>
      {scope.everyone && (
        <label className="checkbox-label">
          <Checkbox
            checked={everyone}
            onCheckedChange={(v) =>
              onTargets(
                v === true
                  ? [{ kind: "everyone" }]
                  : targets.filter((t) => t.kind !== "everyone"),
              )
            }
            disabled={disabled}
          />
          Todos da agência
        </label>
      )}
      {!everyone && (
        <div className="notice-audience-add">
          <Select
            value={kind}
            onValueChange={(v) => setKind(v as typeof kind)}
            aria-label="Tipo de público"
            disabled={disabled}
          >
            {(Object.keys(KIND_LABEL) as (keyof typeof KIND_LABEL)[]).map(
              (k) => (
                <SelectOption key={k} value={k}>
                  {KIND_LABEL[k]}
                </SelectOption>
              ),
            )}
          </Select>
          {(kind === "client" || kind === "project") && (
            <Select
              value={mode}
              onValueChange={(v) => setMode(v as TargetMode)}
              aria-label="Quem do cliente ou projeto"
              disabled={disabled}
            >
              {MODES.map((m) => (
                <SelectOption key={m.value} value={m.value}>
                  {m.label}
                </SelectOption>
              ))}
            </Select>
          )}
          <Select
            key={`${kind}-${targets.length}`}
            value=""
            onValueChange={add}
            aria-label={`Adicionar ${KIND_LABEL[kind].toLowerCase()}`}
            disabled={disabled || !options.length}
          >
            <SelectOption value="">
              {options.length
                ? `Adicionar ${KIND_LABEL[kind].toLowerCase()}…`
                : "Nada a adicionar"}
            </SelectOption>
            {options.map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
        </div>
      )}
      {!everyone && !!targets.length && (
        <ul className="notice-chips" aria-label="Público escolhido">
          {targets.map((t, i) => (
            <li key={`${t.kind}-${t.id}`}>
              <span className="notice-chip-kind">
                {t.kind !== "everyone" && KIND_LABEL[t.kind]}
              </span>
              {label(t)}
              {t.mode && (
                <Select
                  value={t.mode}
                  onValueChange={(v) =>
                    onTargets(
                      targets.map((x, j) =>
                        j === i ? { ...x, mode: v as TargetMode } : x,
                      ),
                    )
                  }
                  aria-label={`Quem de ${label(t)}`}
                  disabled={disabled}
                >
                  {MODES.map((m) => (
                    <SelectOption key={m.value} value={m.value}>
                      {m.label}
                    </SelectOption>
                  ))}
                </Select>
              )}
              <button
                type="button"
                className="icon-btn"
                aria-label={`Tirar ${label(t)}`}
                onClick={() => onTargets(targets.filter((_, j) => j !== i))}
                disabled={disabled}
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="notice-exclude">
        <Select
          key={`x-${exclude.length}`}
          value=""
          onValueChange={(v) => v && onExclude([...exclude, v])}
          aria-label="Excluir alguém"
          disabled={disabled || !targets.length}
        >
          <SelectOption value="">Excluir alguém…</SelectOption>
          {excludable.map((m) => (
            <SelectOption key={m.user_id} value={m.user_id}>
              {m.name}
            </SelectOption>
          ))}
        </Select>
        {exclude.map((u) => (
          <span key={u} className="chip notice-excluded">
            sem {memberName(u)}
            <button
              type="button"
              aria-label={`Voltar a incluir ${memberName(u)}`}
              onClick={() => onExclude(exclude.filter((x) => x !== u))}
              disabled={disabled}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      {!!targets.length && (
        <p className="notice-estimate">
          <Users size={15} aria-hidden="true" />
          Hoje:{" "}
          {estimate.people === 1 ? "1 pessoa" : `${estimate.people} pessoas`}
          {estimate.assignees ? " + os responsáveis pelas tarefas abertas" : ""}
        </p>
      )}
    </fieldset>
  );
}

/** Anexar um arquivo que já está no Drive (busca pelo nome). */
function DriveSearch({
  company,
  disabled,
  picked,
  onPick,
}: {
  company: string;
  disabled: boolean;
  picked: string[];
  onPick: (f: DrivePick) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState<DriveFile[] | null>(null);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) return setFound(null);
    let alive = true;
    const t = setTimeout(() => {
      searchDriveFiles(company, q)
        .then((list) => alive && setFound(list.slice(0, 8)))
        .catch(() => alive && setFound([]));
    }, 280);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [company, text]);
  if (!open)
    return (
      <button
        type="button"
        className="case-drop"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <HardDrive size={20} />
        <span>
          <strong>Do Drive</strong> um arquivo que já está lá
        </span>
      </button>
    );
  return (
    <div className="notice-drive">
      <Input
        type="search"
        icon={Search}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Nome do arquivo no Drive"
        aria-label="Buscar no Drive"
        autoFocus
        disabled={disabled}
      />
      {found && (
        <ul>
          {found.length ? (
            found.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => onPick(f)}
                  disabled={disabled || picked.includes(f.id)}
                >
                  <FileIcon size={15} aria-hidden="true" />
                  <span>
                    {f.name}
                    <small>{formatBytes(f.size_bytes)}</small>
                  </span>
                  {picked.includes(f.id) ? (
                    <small>anexado</small>
                  ) : (
                    <Plus size={15} />
                  )}
                </button>
              </li>
            ))
          ) : (
            <li className="notice-drive-empty">
              Nenhum arquivo com esse nome.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
