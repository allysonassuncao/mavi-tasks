import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  EyeOff,
  History,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
  Users,
  X,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { MultiPick } from "./MultiPick";
import RichTextEditor from "./RichTextEditor";
import { RichTextContent } from "./RichTextContent";
import { parseDescription, serializeDescription } from "./rich-text";
import {
  MAX_MODULES,
  MAX_TAGS,
  ROLE_LABEL,
  TUTORIAL_MODULES,
  addTag,
  cleanLabel,
  contentOf,
  emptyTutorial,
  type TutorialAudience,
  type TutorialContent,
  type TutorialDetail,
  type TutorialFacet,
  type TutorialVersion,
  type TutorialVersionRow,
  type TutorialsApi,
} from "./tutorials";
import { fold } from "./domain";
import type { Role, Snapshot } from "./types";

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });

/**
 * Escrever um tutorial (administradores; gestores, os seus): título, resumo,
 * o texto com seções, imagens e vídeos, a organização (módulos, categoria,
 * tags) e quem vê. "Salvar rascunho" num tutorial no ar guarda a alteração
 * sem tirá-lo do ar; "Publicar" leva tudo ao ar como uma versão nova.
 */
export function TutorialEditor({
  api,
  company,
  data,
  user,
  detail,
  facets,
  demo,
  notify,
  onClose,
}: {
  api: TutorialsApi;
  company: string;
  data: Snapshot;
  user: string;
  detail: TutorialDetail | null;
  facets: TutorialFacet[];
  demo: boolean;
  notify: (message: string) => void;
  /** Leaves the editor; with an id, opens that tutorial. */
  onClose: (id: string | null) => void;
}) {
  const initial = useMemo(
    () => (detail ? contentOf(detail) : emptyTutorial()),
    [detail],
  );
  const [form, setForm] = useState<TutorialContent>(initial);
  // O texto como o editor o escreve: ligar o editor também avisa uma
  // "mudança", que não conta como alteração.
  const body = useRef(
    initial.body ? serializeDescription(parseDescription(initial.body)) : "",
  );
  const [id, setId] = useState<string | null>(detail?.id ?? null);
  const [revision, setRevision] = useState<number | null>(
    detail?.revision ?? null,
  );
  const [published, setPublished] = useState(detail?.status === "published");
  const [hasDraft, setHasDraft] = useState(!!detail?.draft);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "draft" | "publish" | "other">("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [tagText, setTagText] = useState("");
  const [versions, setVersions] = useState(false);
  const set = <K extends keyof TutorialContent>(k: K, v: TutorialContent[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };
  const knownTags = facets.filter((f) => f.kind === "tag").map((f) => f.value);
  const knownCategories = facets
    .filter((f) => f.kind === "category")
    .map((f) => f.value);

  // Sair com alterações não salvas pergunta antes (também ao fechar a aba).
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const leave = (target: string | null) => {
    if (
      dirty &&
      !window.confirm("Sair sem salvar? As alterações deste tutorial se perdem.")
    )
      return;
    onClose(target);
  };

  const content = (): TutorialContent => ({
    ...form,
    title: cleanLabel(form.title),
    summary: form.summary.trim(),
    body: body.current,
    category: cleanLabel(form.category),
    tags: tagText.trim() ? addTag(form.tags, tagText, knownTags) : form.tags,
  });

  async function save(publish: boolean) {
    setError("");
    setBusy(publish ? "publish" : "draft");
    try {
      const r = await api.save(company, id, content(), publish, revision);
      setId(r.id);
      setRevision(r.revision);
      setPublished(r.status === "published");
      setHasDraft(r.mode === "draft");
      setDirty(false);
      setTagText("");
      if (publish) {
        notify(
          r.version > 1
            ? `Alterações publicadas (versão ${r.version}).`
            : "Tutorial publicado. O público escolhido já pode ler.",
        );
        onClose(r.id);
      } else
        notify(
          r.mode === "draft"
            ? "Alteração salva como rascunho. A versão no ar continua até você publicar."
            : "Rascunho salvo. Só quem edita vê até você publicar.",
        );
      return r.id;
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar o tutorial.");
      return null;
    } finally {
      setBusy("");
    }
  }

  // O vídeo pertence ao tutorial: um tutorial novo vira rascunho antes.
  const uploadVideo = async (
    file: File,
    onProgress: (fraction: number) => void,
  ) => {
    let target = id;
    if (!target) {
      if (cleanLabel(form.title).length < 3)
        throw Error("Dê um título ao tutorial antes de enviar vídeos.");
      const r = await api.save(company, null, content(), false, null);
      target = r.id;
      setId(r.id);
      setRevision(r.revision);
    }
    return api.upload(target, file, onProgress);
  };

  async function run(
    question: string,
    action: () => Promise<unknown>,
    done: string,
    target: string | null,
  ) {
    if (!window.confirm(question)) return;
    setError("");
    setBusy("other");
    try {
      await action();
      notify(done);
      setDirty(false);
      onClose(target);
    } catch (e) {
      setError((e as Error).message || "Não foi possível concluir.");
    } finally {
      setBusy("");
    }
  }

  const locked = !!busy || uploading;
  return (
    <div className="tutorial-editor">
      <div className="tutorial-editor-bar">
        <button
          type="button"
          className="text-btn"
          onClick={() => leave(id)}
          disabled={!!busy}
        >
          <ArrowLeft size={15} /> {id ? "Voltar ao tutorial" : "Cancelar"}
        </button>
        <span className={`tutorial-status ${published ? (hasDraft ? "changed" : "published") : "draft"}`}>
          {!id
            ? "Novo tutorial"
            : !published
              ? "Rascunho"
              : hasDraft
                ? "No ar · alteração em rascunho"
                : "No ar"}
          {dirty ? " · não salvo" : ""}
        </span>
        <span className="tutorial-editor-actions">
          {id && (
            <Button
              className="btn secondary"
              onClick={() => setVersions(true)}
              disabled={locked}
            >
              <History size={15} /> Versões
            </Button>
          )}
          <Button
            className="btn secondary"
            onClick={() => void save(false)}
            loading={busy === "draft"}
            disabled={locked}
          >
            Salvar rascunho
          </Button>
          <Button
            className="btn primary"
            onClick={() => void save(true)}
            loading={busy === "publish"}
            disabled={locked}
          >
            <Send size={15} /> {published ? "Publicar alterações" : "Publicar"}
          </Button>
        </span>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="tutorial-editor-grid">
        <div className="tutorial-editor-main">
          <label className="tutorial-title-field">
            <span className="sr-only">Título</span>
            <input
              value={form.title}
              maxLength={160}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Título do tutorial"
              aria-label="Título do tutorial"
              disabled={locked}
              autoFocus={!detail}
            />
          </label>
          <label className="field">
            <span>Resumo</span>
            <Textarea
              value={form.summary}
              maxLength={600}
              rows={2}
              onChange={(e) => set("summary", e.target.value)}
              placeholder="Em uma ou duas frases: o que a pessoa aprende aqui."
              disabled={locked}
            />
          </label>
          <RichTextEditor
            name="tutorial-body"
            label="Conteúdo"
            company={company}
            demo={demo}
            defaultValue={initial.body}
            disabled={!!busy}
            headings
            videos={uploadVideo}
            onUploading={setUploading}
            onChange={(v) => {
              if (v === body.current) return;
              body.current = v;
              setDirty(true);
            }}
          />
        </div>

        <aside className="tutorial-editor-side entity-form">
          <fieldset className="notice-block">
            <legend>Organização</legend>
            <div className="field">
              <span>Módulos</span>
              <MultiPick
                label="Módulos"
                allLabel="Nenhum módulo"
                noun="módulos"
                options={TUTORIAL_MODULES.map((m) => ({
                  value: m.id,
                  label: m.label,
                }))}
                value={form.modules}
                onChange={(v) => set("modules", v.slice(0, MAX_MODULES))}
                disabled={locked}
              />
              <small>O botão “?” dessas telas mostra este tutorial.</small>
            </div>
            <label className="field">
              <span>Categoria</span>
              <Input
                value={form.category}
                maxLength={60}
                list="tutorial-categories"
                onChange={(e) => set("category", e.target.value)}
                placeholder="Ex.: Primeiros passos"
                disabled={locked}
              />
              <datalist id="tutorial-categories">
                {knownCategories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <div className="field">
              <span>Tags</span>
              <Input
                value={tagText}
                maxLength={40}
                list="tutorial-tags"
                onChange={(e) => setTagText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    if (form.tags.length >= MAX_TAGS) return;
                    set("tags", addTag(form.tags, tagText, knownTags));
                    setTagText("");
                  }
                }}
                placeholder={
                  form.tags.length >= MAX_TAGS
                    ? `Até ${MAX_TAGS} tags`
                    : "Digite e aperte Enter"
                }
                disabled={locked || form.tags.length >= MAX_TAGS}
              />
              <datalist id="tutorial-tags">
                {knownTags
                  .filter((t) => !form.tags.some((x) => fold(x) === fold(t)))
                  .map((t) => (
                    <option key={t} value={t} />
                  ))}
              </datalist>
              {!!form.tags.length && (
                <span className="tutorial-tag-chips">
                  {form.tags.map((t) => (
                    <span key={t} className="chip">
                      #{t}
                      <button
                        type="button"
                        aria-label={`Tirar a tag ${t}`}
                        onClick={() =>
                          set(
                            "tags",
                            form.tags.filter((x) => x !== t),
                          )
                        }
                        disabled={locked}
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </span>
              )}
            </div>
          </fieldset>

          <AudiencePicker
            data={data}
            user={user}
            value={form}
            disabled={locked}
            onChange={(a) => {
              setForm((f) => ({ ...f, ...a }));
              setDirty(true);
            }}
          />

          {id && detail && (
            <fieldset className="notice-block tutorial-danger">
              <legend>Mais</legend>
              {hasDraft && (
                <Button
                  className="btn secondary"
                  disabled={locked}
                  onClick={() =>
                    void run(
                      "Descartar a alteração em rascunho? A versão no ar continua como está.",
                      () => api.discardDraft(id),
                      "Alteração descartada.",
                      id,
                    )
                  }
                >
                  <Undo2 size={15} /> Descartar alteração
                </Button>
              )}
              {published && (
                <Button
                  className="btn secondary"
                  disabled={locked}
                  onClick={() =>
                    void run(
                      "Tirar o tutorial do ar? Ele volta a ser rascunho e só quem edita vê. As versões ficam guardadas.",
                      () => api.unpublish(id),
                      "Tutorial fora do ar.",
                      id,
                    )
                  }
                >
                  <EyeOff size={15} /> Tirar do ar
                </Button>
              )}
              <Button
                className="btn danger"
                disabled={locked}
                onClick={() =>
                  void run(
                    "Apagar o tutorial? O texto, as versões e os vídeos enviados saem para sempre.",
                    () => api.remove(id),
                    "Tutorial apagado.",
                    null,
                  )
                }
              >
                <Trash2 size={15} /> Apagar tutorial
              </Button>
            </fieldset>
          )}
        </aside>
      </div>

      {versions && id && (
        <VersionsDialog
          api={api}
          id={id}
          dirty={dirty}
          notify={notify}
          onClose={() => setVersions(false)}
          onRestored={() => {
            setDirty(false);
            onClose(id);
          }}
        />
      )}
    </div>
  );
}

const KINDS = { role: "Papel", team: "Equipe", user: "Pessoa" } as const;
type Kind = keyof typeof KINDS;

/** Quem vê: todos, ou a soma de papéis, equipes e pessoas, com exclusões. */
function AudiencePicker({
  data,
  user,
  value,
  disabled,
  onChange,
}: {
  data: Snapshot;
  user: string;
  value: TutorialAudience;
  disabled: boolean;
  onChange: (a: Partial<TutorialAudience>) => void;
}) {
  const [kind, setKind] = useState<Kind>("role");
  const active = data.members.filter((m) => m.active);
  const memberName = (id: string) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Pessoa";
  const teamName = (id: string) =>
    data.teams.find((t) => t.id === id)?.name ?? "Equipe";
  const options =
    kind === "role"
      ? (Object.keys(ROLE_LABEL) as Role[])
          .filter((r) => !value.aud_roles.includes(r))
          .map((r) => ({ value: r, label: ROLE_LABEL[r] }))
      : kind === "team"
        ? data.teams
            .filter((t) => !value.aud_teams.includes(t.id))
            .map((t) => ({ value: t.id, label: t.name }))
        : active
            .filter((m) => !value.aud_users.includes(m.user_id))
            .map((m) => ({ value: m.user_id, label: m.name }));
  options.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  const add = (v: string) => {
    if (!v) return;
    if (kind === "role") onChange({ aud_roles: [...value.aud_roles, v as Role] });
    else if (kind === "team") onChange({ aud_teams: [...value.aud_teams, v] });
    else onChange({ aud_users: [...value.aud_users, v] });
  };
  const chips = [
    ...value.aud_roles.map((r) => ({
      key: `r-${r}`,
      kind: "Papel",
      label: ROLE_LABEL[r],
      remove: () => onChange({ aud_roles: value.aud_roles.filter((x) => x !== r) }),
    })),
    ...value.aud_teams.map((t) => ({
      key: `t-${t}`,
      kind: "Equipe",
      label: teamName(t),
      remove: () => onChange({ aud_teams: value.aud_teams.filter((x) => x !== t) }),
    })),
    ...value.aud_users.map((u) => ({
      key: `u-${u}`,
      kind: "Pessoa",
      label: memberName(u),
      remove: () => onChange({ aud_users: value.aud_users.filter((x) => x !== u) }),
    })),
  ];
  // Quantas pessoas veem hoje (quem edita sempre vê, fora da conta).
  const people = active.filter((m) => {
    if (value.aud_exclude.includes(m.user_id)) return false;
    if (value.aud_all) return true;
    return (
      value.aud_users.includes(m.user_id) ||
      value.aud_roles.includes(m.role) ||
      data.teamMembers.some(
        (t) => t.user_id === m.user_id && value.aud_teams.includes(t.team_id),
      )
    );
  }).length;
  return (
    <fieldset className="notice-block">
      <legend>Quem vê</legend>
      <label className="checkbox-label">
        <Checkbox
          checked={value.aud_all}
          onCheckedChange={(v) => onChange({ aud_all: v === true })}
          disabled={disabled}
        />
        Todos da agência
      </label>
      {!value.aud_all && (
        <>
          <small>
            Os públicos se somam. Quem entrar depois numa equipe escolhida passa a ver na hora.
          </small>
          <div className="notice-audience-add">
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as Kind)}
              aria-label="Tipo de público"
              disabled={disabled}
            >
              {(Object.keys(KINDS) as Kind[]).map((k) => (
                <SelectOption key={k} value={k}>
                  {KINDS[k]}
                </SelectOption>
              ))}
            </Select>
            <Select
              key={`${kind}-${chips.length}`}
              value=""
              onValueChange={add}
              aria-label={`Adicionar ${KINDS[kind].toLowerCase()}`}
              disabled={disabled || !options.length}
            >
              <SelectOption value="">
                {options.length
                  ? `Adicionar ${KINDS[kind].toLowerCase()}…`
                  : "Nada a adicionar"}
              </SelectOption>
              {options.map((o) => (
                <SelectOption key={o.value} value={o.value}>
                  {o.label}
                </SelectOption>
              ))}
            </Select>
          </div>
          {!!chips.length && (
            <ul className="notice-chips" aria-label="Público escolhido">
              {chips.map((c) => (
                <li key={c.key}>
                  <span className="notice-chip-kind">{c.kind}</span>
                  {c.label}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Tirar ${c.label}`}
                    onClick={c.remove}
                    disabled={disabled}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="notice-exclude">
        <Select
          key={`x-${value.aud_exclude.length}`}
          value=""
          onValueChange={(v) => v && onChange({ aud_exclude: [...value.aud_exclude, v] })}
          aria-label="Excluir alguém"
          disabled={disabled}
        >
          <SelectOption value="">Excluir alguém…</SelectOption>
          {active
            .filter((m) => !value.aud_exclude.includes(m.user_id) && m.user_id !== user)
            .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
            .map((m) => (
              <SelectOption key={m.user_id} value={m.user_id}>
                {m.name}
              </SelectOption>
            ))}
        </Select>
        {value.aud_exclude.map((u) => (
          <span key={u} className="chip notice-excluded">
            sem {memberName(u)}
            <button
              type="button"
              aria-label={`Voltar a incluir ${memberName(u)}`}
              onClick={() =>
                onChange({ aud_exclude: value.aud_exclude.filter((x) => x !== u) })
              }
              disabled={disabled}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <p className="notice-estimate">
        <Users size={15} aria-hidden="true" />
        Hoje: {people === 1 ? "1 pessoa" : `${people} pessoas`}, além de quem edita
      </p>
    </fieldset>
  );
}

/** As versões publicadas: ler cada uma e restaurar (vira uma versão nova). */
function VersionsDialog({
  api,
  id,
  dirty,
  notify,
  onClose,
  onRestored,
}: {
  api: TutorialsApi;
  id: string;
  dirty: boolean;
  notify: (message: string) => void;
  onClose: () => void;
  onRestored: () => void;
}) {
  const [list, setList] = useState<TutorialVersionRow[] | null>(null);
  const [picked, setPicked] = useState<TutorialVersion | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .versions(id)
      .then((l) => {
        setList(l);
        if (l[0]) void api.version(id, l[0].version).then(setPicked);
      })
      .catch((e) => setError((e as Error).message));
  }, [api, id]);
  const current = list?.[0]?.version;
  const restore = async () => {
    if (!picked) return;
    if (
      !window.confirm(
        `${dirty ? "As alterações não salvas do editor se perdem. " : ""}Publicar de novo o conteúdo da versão ${picked.version}? Ela vira a versão ${(current ?? 0) + 1}; o público continua o de agora.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const r = await api.restore(id, picked.version);
      notify(`Versão ${picked.version} restaurada (agora é a versão ${r.version}).`);
      onRestored();
    } catch (e) {
      setError((e as Error).message || "Não foi possível restaurar.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Versões publicadas" wide onClose={onClose} busy={busy}>
      {error && <p className="form-error">{error}</p>}
      {list === null ? (
        <Loading variant="list" />
      ) : !list.length ? (
        <p className="tutorial-versions-empty">
          Este tutorial ainda não foi publicado. Cada publicação vira uma versão aqui.
        </p>
      ) : (
        <div className="tutorial-versions">
          <ol className="tutorial-versions-list">
            {list.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  className={picked?.version === v.version ? "active" : ""}
                  onClick={() => void api.version(id, v.version).then(setPicked)}
                >
                  <strong>
                    Versão {v.version}
                    {v.version === current ? " · no ar" : ""}
                  </strong>
                  <small>
                    {when(v.published_at)} · {v.published_by_name}
                  </small>
                  {v.restored_from && (
                    <small>Restaurada da versão {v.restored_from}</small>
                  )}
                </button>
              </li>
            ))}
          </ol>
          <div className="tutorial-versions-preview">
            {picked ? (
              <>
                <div className="tutorial-versions-head">
                  <h3>{picked.title}</h3>
                  {picked.version !== current && (
                    <Button
                      className="btn primary"
                      onClick={() => void restore()}
                      loading={busy}
                    >
                      <RotateCcw size={15} /> Restaurar esta versão
                    </Button>
                  )}
                </div>
                {picked.summary && <p className="tutorial-lead">{picked.summary}</p>}
                <RichTextContent value={picked.body} />
              </>
            ) : (
              <Loading variant="page" />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
