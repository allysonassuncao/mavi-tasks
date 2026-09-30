import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Check,
  Download,
  FileText,
  FlaskConical,
  History,
  MessageSquare,
  Pencil,
  Plus,
  Puzzle,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button, Input, Loading, Textarea } from "./ui";
import { Modal } from "./components";
import { fold } from "./task-search";
import type { Snapshot } from "./types";
import { AudienceFields, type Audience } from "./AiPowersPanel";
import { myPowers } from "./ai";
import {
  LIMITS,
  STATE_LABELS,
  applyCheck,
  archiveSkill,
  checkKey,
  checkSkill,
  cleanFileName,
  deleteSkill,
  getSkill,
  importSkill,
  listSkills,
  readReference,
  restoreSkill,
  reviewSkill,
  saveSkill,
  setSkillAudience,
  skillMd,
  slugify,
  undoCheck,
  validSlug,
  type CheckItem,
  type CheckUndo,
  type SkillCheck,
  type SkillDetail,
  type SkillDraft,
  type SkillState,
  type SkillSummary,
} from "./mavi-skills";
import { SkillAssistant, SkillCheckPanel } from "./SkillCoach";
import "./mavi-skills.css";

type Tab = "available" | "mine" | "review" | "all";
type Editing = { id: string | null; draft: SkillDraft; skipped?: string[]; imported?: boolean };

const emptyDraft = (): SkillDraft => ({
  slug: "",
  name: "",
  description: "",
  instructions: "",
  files: [],
  note: "",
});
const kb = (n: number) =>
  n < 1024 ? `${n} B` : `${(n / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB`;
const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "";

/**
 * MAVI › Skills: os jeitos de trabalhar que a agência ensina à MAVI. Qualquer
 * pessoa cria (ou importa no formato das Skills da Claude) e testa nas
 * próprias conversas; administradores e gestores aprovam, dizem quem usa,
 * restauram versões e arquivam. Cada skill tem o seu endereço.
 */
export function SkillsPage({
  company,
  data,
  isLeader,
  skillId,
  href,
  onOpen,
  onTest,
  onChanged,
  powersHref,
  notify,
}: {
  company: string;
  data: Snapshot;
  isLeader: boolean;
  /** Painel da MAVI › Poderes. */
  powersHref: string;
  /** A skill do endereço (/mavi/skills/<id>). */
  skillId: string | null;
  href: (id: string | null) => string;
  onOpen: (id: string | null) => void;
  /** Abre uma conversa nova com a skill (a versão: em teste). */
  onTest: (slug: string, version?: number) => void;
  /** Algo mudou (o contador de aprovações). */
  onChanged: () => void;
  notify: (message: string) => void;
}) {
  const [list, setList] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("available");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [tick, setTick] = useState(0);
  // Sem o poder Skills, ninguém usa nem testa: a tela avisa.
  const [skillsOn, setSkillsOn] = useState(true);
  const importer = useRef<HTMLInputElement>(null);
  useEffect(() => {
    myPowers(company)
      .then((p) => setSkillsOn(Array.isArray(p) && p.includes("skills")))
      .catch(() => {});
  }, [company]);

  useEffect(() => {
    listSkills(company)
      .then(setList)
      .catch((e) => setError((e as Error).message));
  }, [company, tick]);
  const reload = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  const name = (id: string | null) =>
    data.members.find((m) => m.user_id === id)?.name ?? "Alguém";

  const pending = (list ?? []).filter((s) => s.latest?.state === "pending" && !s.archived);
  const q = fold(query.trim());
  const shown = (list ?? [])
    .filter((s) =>
      tab === "available"
        ? s.available
        : tab === "mine"
          ? s.mine
          : tab === "review"
            ? s.latest?.state === "pending" && !s.archived
            : true,
    )
    .filter(
      (s) =>
        !q ||
        fold(
          `${s.current?.name ?? s.latest?.name ?? ""} ${s.slug} ${s.current?.description ?? s.latest?.description ?? ""}`,
        ).includes(q),
    );

  async function pickImport(file: File) {
    try {
      const { draft, skipped } = await importSkill(file);
      setEditing({ id: null, draft: { ...draft, note: "Importada de " + file.name }, skipped, imported: true });
    } catch (e) {
      notify((e as Error).message);
    }
  }

  const off = !skillsOn && (
    <p className="panel skill-note skills-off">
      O poder <strong>Skills</strong> está desligado para você: dá para criar e
      editar, mas a MAVI só usa (e você só testa) depois que um administrador
      ou gestor ligar em{" "}
      <a href={powersHref}>Painel da MAVI › Poderes</a>.
    </p>
  );
  if (editing)
    return (
      <SkillEditor
        company={company}
        editing={editing}
        isLeader={isLeader}
        onCancel={() => setEditing(null)}
        onSaved={(id, message) => {
          setEditing(null);
          notify(message);
          reload();
          onOpen(id);
        }}
      />
    );
  if (skillId)
    return (
      <>
      {off}
      <SkillView
        key={`${skillId}-${tick}`}
        id={skillId}
        company={company}
        data={data}
        isLeader={isLeader}
        name={name}
        onBack={() => onOpen(null)}
        onEdit={(detail) =>
          setEditing({
            id: detail.id,
            draft: {
              slug: detail.slug,
              name: detail.version.name,
              description: detail.version.description,
              instructions: detail.version.instructions,
              files: detail.version.files.map((f) => ({ name: f.name, content: f.content })),
              note: "",
            },
          })
        }
        onTest={onTest}
        onChanged={reload}
        onDeleted={() => {
          reload();
          onOpen(null);
        }}
        notify={notify}
      />
      </>
    );

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "available", label: "Disponíveis para você" },
    { id: "mine", label: "Criadas por você" },
    ...(isLeader
      ? [
          { id: "review" as const, label: "Para aprovar", count: pending.length },
          { id: "all" as const, label: "Todas" },
        ]
      : []),
  ];
  return (
    <div className="skills-page">
      {off}
      <div className="skills-toolbar">
        <div className="drive-view drive-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "selected" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {!!t.count && <span className="skills-count">{t.count}</span>}
            </button>
          ))}
        </div>
        <span className="skills-search">
          <Input
            type="search"
            icon={Search}
            placeholder="Buscar skills"
            aria-label="Buscar skills"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </span>
        <input
          ref={importer}
          type="file"
          accept=".md,.markdown,.zip,.skill"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pickImport(f);
          }}
        />
        <Button className="btn secondary" onClick={() => importer.current?.click()}>
          <Upload size={16} /> Importar
        </Button>
        <Button
          className="btn primary"
          onClick={() => setEditing({ id: null, draft: emptyDraft() })}
        >
          <Plus size={17} /> Nova skill
        </Button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list === null ? (
        <Loading variant="grid" />
      ) : !shown.length ? (
        <div className="panel skills-empty">
          <Puzzle size={22} aria-hidden="true" />
          <strong>
            {q
              ? "Nenhuma skill com esse nome."
              : tab === "review"
                ? "Nada esperando aprovação."
                : tab === "mine"
                  ? "Você ainda não criou skills."
                  : "Nenhuma skill disponível para você ainda."}
          </strong>
          <p>
            Uma skill ensina à MAVI um jeito de trabalhar da agência: um
            relatório, um briefing, uma análise. Escreva as instruções, anexe
            modelos e exemplos, e a MAVI usa quando o pedido se encaixar. Dá
            para importar uma skill no formato da Claude (SKILL.md ou .zip).
          </p>
        </div>
      ) : (
        <ul className="skills-grid">
          {shown.map((s) => {
            const title = s.current?.name ?? s.latest?.name ?? s.slug;
            const description = s.current?.description ?? s.latest?.description ?? "";
            const state = s.latest?.state;
            return (
              <li key={s.id}>
                <a
                  href={href(s.id)}
                  className={`panel skill-card${s.archived ? " archived" : ""}`}
                  onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
                      return;
                    e.preventDefault();
                    onOpen(s.id);
                  }}
                >
                  <span className="skill-card-icon" aria-hidden="true">
                    <Puzzle size={17} />
                  </span>
                  <span className="skill-card-body">
                    <strong>{title}</strong>
                    <small className="skill-slug">{s.slug}</small>
                    <span className="skill-card-text">{description}</span>
                    <span className="skill-card-meta">
                      {s.archived ? (
                        <StateChip label="Arquivada" tone="muted" />
                      ) : (
                        state &&
                        (s.mine || isLeader) &&
                        state !== "approved" && <StateChip state={state} />
                      )}
                      {s.published && <small>versão {s.published}</small>}
                      {(s.mine || isLeader) && <small>de {name(s.author_id)}</small>}
                      {(s.mine || isLeader) && !!Number(s.uses_30d) && (
                        <small>
                          {Number(s.uses_30d)} {Number(s.uses_30d) === 1 ? "uso" : "usos"} em 30 dias
                        </small>
                      )}
                    </span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function StateChip({
  state,
  label,
  tone,
}: {
  state?: SkillState;
  label?: string;
  tone?: string;
}) {
  return (
    <span className={`skill-state ${tone ?? state ?? ""}`}>
      {label ?? (state ? STATE_LABELS[state] : "")}
    </span>
  );
}

// ------------------------------------------------------------ uma skill
function SkillView({
  id,
  company,
  data,
  isLeader,
  name,
  onBack,
  onEdit,
  onTest,
  onChanged,
  onDeleted,
  notify,
}: {
  id: string;
  company: string;
  data: Snapshot;
  isLeader: boolean;
  name: (id: string | null) => string;
  onBack: () => void;
  onEdit: (detail: SkillDetail) => void;
  onTest: (slug: string, version?: number) => void;
  onChanged: () => void;
  onDeleted: () => void;
  notify: (message: string) => void;
}) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [version, setVersion] = useState<number | undefined>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [returning, setReturning] = useState(false);
  const [audience, setAudience] = useState<Audience | null>(null);
  // A revisão da MAVI para quem aprova (só leitura: ajustar é com quem escreveu).
  const [check, setCheck] = useState<SkillCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [showCheck, setShowCheck] = useState(false);
  async function runCheck(d: SkillDetail) {
    setShowCheck(true);
    setChecking(true);
    setCheckError("");
    try {
      setCheck(
        await checkSkill(
          company,
          {
            slug: d.slug,
            name: d.version.name,
            description: d.version.description,
            instructions: d.version.instructions,
            files: d.version.files.map((f) => ({ name: f.name, content: f.content })),
            note: "",
          },
          "manual",
        ),
      );
    } catch (e) {
      setCheckError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    setShowCheck(false);
    setCheck(null);
  }, [version]);
  useEffect(() => {
    setError("");
    getSkill(id, version)
      .then((d) => {
        setDetail(d);
        setAudience((a) =>
          a ?? {
            everyone: d.everyone,
            team_ids: d.team_ids,
            user_ids: d.user_ids,
            except_ids: d.except_ids,
          },
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [id, version]);

  async function act(work: () => Promise<unknown>, message: string, after?: () => void) {
    setBusy(true);
    setError("");
    try {
      await work();
      notify(message);
      onChanged();
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function download(d: SkillDetail) {
    void import("fflate").then(({ zipSync, strToU8 }) => {
      const v = d.version;
      const zip = zipSync({
        [`${d.slug}/SKILL.md`]: strToU8(
          skillMd({ slug: d.slug, name: v.name, description: v.description, instructions: v.instructions }),
        ),
        ...Object.fromEntries(v.files.map((f) => [`${d.slug}/${f.name}`, strToU8(f.content)])),
      });
      const url = URL.createObjectURL(new Blob([zip], { type: "application/zip" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${d.slug}-v${v.version}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  if (error && !detail)
    return (
      <div className="skills-page">
        <button type="button" className="skills-back" onClick={onBack}>
          <ArrowLeft size={15} /> Skills
        </button>
        <p className="form-error" role="alert">
          {error}
        </p>
      </div>
    );
  if (!detail) return <Loading variant="detail" />;
  const v = detail.version;
  const latest = detail.versions[0];
  const viewingLatest = !latest || latest.version === v.version;
  const pendingHere = isLeader && v.state === "pending";
  const audienceDirty =
    !!audience &&
    JSON.stringify(audience) !==
      JSON.stringify({
        everyone: detail.everyone,
        team_ids: detail.team_ids,
        user_ids: detail.user_ids,
        except_ids: detail.except_ids,
      });
  return (
    <div className="skills-page skill-view">
      <button type="button" className="skills-back" onClick={onBack}>
        <ArrowLeft size={15} /> Skills
      </button>
      <header className="panel skill-head">
        <span className="skill-card-icon big" aria-hidden="true">
          <Puzzle size={22} />
        </span>
        <div>
          <h2>{v.name}</h2>
          <small className="skill-slug">
            {detail.slug} · versão {v.version}
            {detail.published === v.version ? " (publicada)" : ""} · de {name(detail.author_id)}
          </small>
          <p>{v.description}</p>
          <span className="skill-card-meta">
            {detail.archived ? <StateChip label="Arquivada" tone="muted" /> : <StateChip state={v.state} />}
            {v.note && <small>Mudança: {v.note}</small>}
          </span>
        </div>
        <div className="skill-actions">
          {detail.available && detail.published && !detail.editable && (
            <Button className="btn secondary" onClick={() => onTest(detail.slug)}>
              <MessageSquare size={15} /> Usar na conversa
            </Button>
          )}
          {detail.editable && !detail.archived && (
            <Button
              className="btn secondary"
              onClick={() => onTest(detail.slug, v.version)}
              title="Abre uma conversa nova com esta versão (só quem edita a skill usa assim)"
            >
              <FlaskConical size={15} /> Testar na conversa
            </Button>
          )}
          {detail.editable && viewingLatest && !detail.archived && (
            <Button className="btn primary" onClick={() => onEdit(detail)}>
              <Pencil size={15} /> Editar
            </Button>
          )}
          <Button
            className="icon-btn"
            title="Baixar no formato das Skills da Claude (.zip)"
            aria-label="Baixar a skill"
            onClick={() => download(detail)}
          >
            <Download size={16} />
          </Button>
          {detail.editable && (
            <Button
              className="icon-btn"
              title={detail.archived ? "Reativar" : "Arquivar (a MAVI deixa de usar)"}
              aria-label={detail.archived ? "Reativar a skill" : "Arquivar a skill"}
              disabled={busy}
              onClick={() =>
                void act(
                  () => archiveSkill(detail.id, !detail.archived),
                  detail.archived ? "Skill reativada." : "Skill arquivada.",
                  () => setDetail({ ...detail, archived: !detail.archived }),
                )
              }
            >
              {detail.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            </Button>
          )}
          {detail.editable && (isLeader || !detail.published) && (
            <Button
              className="icon-btn"
              title="Apagar"
              aria-label="Apagar a skill"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Apagar a skill "${v.name}" e todas as versões?`)) return;
                void act(() => deleteSkill(detail.id), "Skill apagada.", onDeleted);
              }}
            >
              <Trash2 size={16} />
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {pendingHere && (
        <section className="panel skill-review">
          <strong>Esta versão espera a sua aprovação</strong>
          <small>
            Enviada por {name(v.created_by)} em {when(v.created_at)}.
            {detail.published ? ` Enquanto isso, a MAVI usa a versão ${detail.published}.` : ""}
          </small>
          {returning ? (
            <ReturnForm
              busy={busy}
              onCancel={() => setReturning(false)}
              onSend={(note) =>
                void act(() => reviewSkill(detail.id, v.version, false, note), "Skill devolvida para ajustes.", () =>
                  setVersion(undefined),
                )
              }
            />
          ) : (
            <span className="skill-review-actions">
              <Button className="btn secondary" onClick={() => void runCheck(detail)} loading={checking}>
                <ShieldCheck size={15} /> Validar com a MAVI
              </Button>
              <Button className="btn secondary" onClick={() => onTest(detail.slug, v.version)}>
                <FlaskConical size={15} /> Testar antes
              </Button>
              <Button className="btn secondary" disabled={busy} onClick={() => setReturning(true)}>
                <X size={15} /> Devolver
              </Button>
              <Button
                className="btn primary"
                loading={busy}
                onClick={() =>
                  void act(() => reviewSkill(detail.id, v.version, true, ""), "Skill aprovada e publicada.", () =>
                    setVersion(undefined),
                  )
                }
              >
                <Check size={15} /> Aprovar e publicar
              </Button>
            </span>
          )}
        </section>
      )}
      {showCheck && (
        <SkillCheckPanel
          check={check}
          loading={checking}
          error={checkError}
          stale={false}
          draft={{
            slug: detail.slug,
            name: v.name,
            description: v.description,
            instructions: v.instructions,
            files: v.files.map((f) => ({ name: f.name, content: f.content })),
            note: "",
          }}
          applied={new Map()}
          onRecheck={() => void runCheck(detail)}
          onClose={() => setShowCheck(false)}
          readOnly
        />
      )}
      {v.state === "rejected" && v.review_note && (
        <p className="panel skill-note">
          <strong>Devolvida por {name(v.reviewed_by)}:</strong> {v.review_note}
        </p>
      )}
      {v.state === "pending" && !isLeader && (
        <p className="panel skill-note">
          Esperando a aprovação de um administrador ou gestor.
          {detail.published ? ` A MAVI segue usando a versão ${detail.published}.` : ""} Você já
          pode testar nas suas conversas.
        </p>
      )}

      <div className="skill-columns">
        <section className="panel skill-instructions">
          <h3>Instruções</h3>
          <pre>{v.instructions}</pre>
        </section>
        <aside className="skill-side">
          <section className="panel">
            <h3>
              <FileText size={15} aria-hidden="true" /> Arquivos de referência
            </h3>
            {v.files.length ? (
              <ul className="skill-files">
                {v.files.map((f) => (
                  <li key={f.name}>
                    <button type="button" onClick={() => setFile(f)}>
                      <span>{f.name}</span>
                      <small>{kb(f.size)}</small>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nenhum arquivo.</p>
            )}
          </section>
          {isLeader && audience && (
            <section className="panel">
              <h3>Quem pode usar</h3>
              <AudienceFields
                name={`skill-${detail.id}`}
                data={data}
                value={audience}
                onChange={(patch) => setAudience({ ...audience, ...patch })}
              />
              {audienceDirty && (
                <span className="skill-review-actions">
                  <Button
                    className="btn secondary"
                    onClick={() =>
                      setAudience({
                        everyone: detail.everyone,
                        team_ids: detail.team_ids,
                        user_ids: detail.user_ids,
                        except_ids: detail.except_ids,
                      })
                    }
                  >
                    Descartar
                  </Button>
                  <Button
                    className="btn primary"
                    loading={busy}
                    onClick={() =>
                      void act(() => setSkillAudience(detail.id, audience), "Quem pode usar foi salvo.", () =>
                        setDetail({ ...detail, ...audience }),
                      )
                    }
                  >
                    <Check size={15} /> Salvar
                  </Button>
                </span>
              )}
            </section>
          )}
          {!isLeader && detail.editable && (
            <section className="panel">
              <h3>Quem pode usar</h3>
              <p className="muted">
                {detail.everyone
                  ? "Todas as pessoas da empresa (quando publicada)."
                  : "Equipes e pessoas escolhidas pelos líderes."}
              </p>
            </section>
          )}
          {detail.editable && detail.versions.length > 0 && (
            <section className="panel">
              <h3>
                <History size={15} aria-hidden="true" /> Versões
              </h3>
              <ol className="skill-versions">
                {detail.versions.map((x) => (
                  <li key={x.version} className={x.version === v.version ? "current" : ""}>
                    <button type="button" onClick={() => setVersion(x.version)}>
                      <strong>Versão {x.version}</strong>
                      <StateChip state={x.state} />
                    </button>
                    <small>
                      {name(x.created_by)} · {when(x.created_at)}
                      {Number(x.uses) ? ` · ${Number(x.uses)} ${Number(x.uses) === 1 ? "uso" : "usos"}` : ""}
                    </small>
                    {x.note && <small>{x.note}</small>}
                    {x.review_note && <small>Revisão: {x.review_note}</small>}
                    {isLeader &&
                      (x.state === "superseded" || x.state === "approved") &&
                      x.version !== detail.published && (
                        <button
                          type="button"
                          className="skill-restore"
                          disabled={busy}
                          onClick={() => {
                            if (!window.confirm(`Publicar de novo o conteúdo da versão ${x.version}?`)) return;
                            void act(() => restoreSkill(detail.id, x.version), "Versão restaurada e publicada.", () =>
                              setVersion(undefined),
                            );
                          }}
                        >
                          Restaurar
                        </button>
                      )}
                  </li>
                ))}
              </ol>
            </section>
          )}
        </aside>
      </div>
      {file && (
        <Modal title={file.name} onClose={() => setFile(null)}>
          <pre className="skill-file-view">{file.content}</pre>
        </Modal>
      )}
    </div>
  );
}

function ReturnForm({
  busy,
  onCancel,
  onSend,
}: {
  busy: boolean;
  onCancel: () => void;
  onSend: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div className="skill-return">
      <Textarea
        rows={2}
        maxLength={500}
        autoFocus
        placeholder="O que precisa mudar?"
        aria-label="O que precisa mudar"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <span className="skill-review-actions">
        <Button className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button
          className="btn primary"
          loading={busy}
          disabled={note.trim().length < 3}
          onClick={() => onSend(note.trim())}
        >
          Devolver
        </Button>
      </span>
    </div>
  );
}

// ------------------------------------------------------------ editor
function SkillEditor({
  company,
  editing,
  isLeader,
  onCancel,
  onSaved,
}: {
  company: string;
  editing: Editing;
  isLeader: boolean;
  onCancel: () => void;
  onSaved: (id: string, message: string) => void;
}) {
  const [draft, setDraftState] = useState(editing.draft);
  const [slugByHand, setSlugByHand] = useState(!!editing.draft.slug);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState<{ name: string; content: string } | null>(null);
  const adder = useRef<HTMLInputElement>(null);
  const isNew = !editing.id;
  // A skill mais recente, para aplicar vários pontos seguidos (cada um lê o anterior).
  const current = useRef(draft);
  const setDraft = (next: SkillDraft) => {
    current.current = next;
    setDraftState(next);
  };
  const set = (patch: Partial<SkillDraft>) => setDraft({ ...current.current, ...patch });
  // A revisão da MAVI (ao importar, ao enviar e no botão) e o assistente.
  const [check, setCheck] = useState<SkillCheck | null>(null);
  const [checkedKey, setCheckedKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [showCheck, setShowCheck] = useState(false);
  const [applied, setApplied] = useState<Map<string, CheckUndo>>(new Map());
  const [sending, setSending] = useState(false);
  const [coach, setCoach] = useState(isNew && !editing.imported);
  const checkBox = useRef<HTMLDivElement>(null);
  const total = useMemo(
    () => draft.files.reduce((n, f) => n + f.content.length, 0),
    [draft.files],
  );
  const problems = [
    draft.name.trim().length < 2 ? "Dê um nome à skill." : "",
    isNew && !validSlug(draft.slug)
      ? "O identificador usa letras minúsculas, números e hífens (2 a 63)."
      : "",
    draft.description.trim().length < 10
      ? "Diga em uma ou duas frases quando a MAVI deve usar (10 caracteres ou mais)."
      : "",
    draft.instructions.trim().length < 20 ? "Escreva as instruções (20 caracteres ou mais)." : "",
    total > LIMITS.total ? "Os arquivos passam de 1 MB de texto." : "",
  ].filter(Boolean);

  async function addFiles(list: FileList) {
    setError("");
    const next = [...draft.files];
    for (const f of Array.from(list)) {
      try {
        if (next.length >= LIMITS.files) throw Error(`Até ${LIMITS.files} arquivos por skill.`);
        const content = await readReference(f.name, new Uint8Array(await f.arrayBuffer()));
        if (content.length > LIMITS.file) throw Error(`“${f.name}”: o texto passa de 200 mil caracteres.`);
        const name = cleanFileName(f.name);
        const i = next.findIndex((x) => x.name === name);
        if (i >= 0) next[i] = { name, content };
        else next.push({ name, content });
      } catch (e) {
        setError((e as Error).message);
      }
    }
    set({ files: next });
  }
  async function runCheck(origin: "import" | "submit" | "manual") {
    const d = current.current;
    setShowCheck(true);
    setChecking(true);
    setCheckError("");
    try {
      const r = await checkSkill(company, d, origin);
      setCheck(r);
      setCheckedKey(checkKey(d));
      setApplied(new Map());
      return r;
    } catch (e) {
      setCheckError((e as Error).message);
      return null;
    } finally {
      setChecking(false);
    }
  }
  // Importada: a revisão roda sozinha (skills da Claude costumam pedir o que a MAVI não faz).
  useEffect(() => {
    if (editing.imported && editing.draft.instructions.trim().length >= 20) void runCheck("import");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function apply(item: CheckItem) {
    const r = applyCheck(current.current, item);
    if (!r) return;
    setDraft(r.draft);
    setApplied((m) => new Map(m).set(item.id, r.undo));
  }
  function undo(id: string) {
    const u = applied.get(id);
    if (!u) return;
    setDraft(undoCheck(current.current, u));
    setApplied((m) => {
      const next = new Map(m);
      next.delete(id);
      return next;
    });
  }
  /**
   * Enviar: antes, a MAVI revisa (se a skill mudou desde a última revisão).
   * Muito boa, segue direto; com pontos, a pessoa vê e decide. Nada trava:
   * se a revisão não rodar, a skill segue.
   */
  async function submit() {
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setError("");
    setSending(true);
    if (!check || checkedKey !== checkKey(current.current)) {
      const r = await runCheck("submit");
      if (r && r.verdict !== "great") {
        requestAnimationFrame(() => checkBox.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
        return;
      }
    }
    await save(true);
  }
  async function save(submit: boolean) {
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await saveSkill(company, editing.id, current.current, submit);
      onSaved(
        r.id,
        r.state === "approved"
          ? "Skill publicada: a MAVI já pode usar."
          : r.state === "pending"
            ? "Skill enviada para aprovação. Você já pode testar nas suas conversas."
            : "Rascunho salvo.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setSending(false);
    }
  }
  const sendLabel = isLeader ? "Publicar" : "Enviar para aprovação";
  return (
    <div className={`skills-page skill-editor${coach ? " with-coach" : ""}`}>
      <button type="button" className="skills-back" onClick={onCancel} disabled={busy}>
        <ArrowLeft size={15} /> {isNew ? "Skills" : "Voltar sem salvar"}
      </button>
      <div className="skill-editor-body">
      <section className="panel skill-form">
        <div className="skill-form-head">
          <h2>{isNew ? "Nova skill" : `Editar ${editing.draft.name}`}</h2>
          {!coach && (
            <Button className="btn secondary skill-coach-open" onClick={() => setCoach(true)}>
              <Sparkles size={15} /> {isNew && !draft.instructions.trim() ? "Criar com a MAVI" : "Melhorar com a MAVI"}
            </Button>
          )}
        </div>
        {!isNew && (
          <p className="muted">
            Se a skill já está publicada, as mudanças viram uma versão nova: a
            publicada continua valendo até {isLeader ? "você publicar" : "a aprovação"}.
          </p>
        )}
        {!!editing.skipped?.length && (
          <p className="skill-note">
            Ficaram de fora do .zip: {editing.skipped.join("; ")}.
          </p>
        )}
        <label>
          <span>Nome</span>
          <Input
            value={draft.name}
            maxLength={LIMITS.name}
            placeholder="Ex.: Relatório mensal do cliente"
            onChange={(e) =>
              set({
                name: e.target.value,
                ...(isNew && !slugByHand ? { slug: slugify(e.target.value) } : {}),
              })
            }
          />
        </label>
        <label>
          <span>Identificador</span>
          <Input
            value={draft.slug}
            maxLength={63}
            disabled={!isNew}
            onChange={(e) => {
              setSlugByHand(true);
              set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") });
            }}
          />
          <small>Como a MAVI chama a skill. Não muda depois de criada.</small>
        </label>
        <label>
          <span>Quando a MAVI deve usar</span>
          <Textarea
            rows={2}
            value={draft.description}
            maxLength={LIMITS.description}
            placeholder="Ex.: Quando pedirem o relatório mensal de um cliente, com os resultados das campanhas e o que foi combinado nas reuniões."
            onChange={(e) => set({ description: e.target.value })}
          />
          <small>
            A MAVI lê só isto para decidir se usa a skill: diga o tipo de pedido.{" "}
            {draft.description.length}/{LIMITS.description}
          </small>
        </label>
        <label>
          <span>Instruções</span>
          <Textarea
            className="skill-textarea"
            rows={16}
            value={draft.instructions}
            maxLength={LIMITS.instructions}
            placeholder={
              "O passo a passo, em Markdown. Ex.:\n1. Busque os resultados das campanhas do mês (dia a dia).\n2. Mostre os números em indicadores e um gráfico.\n3. Resuma o que foi combinado nas reuniões.\n4. Siga o modelo em modelo-relatorio.md."
            }
            onChange={(e) => set({ instructions: e.target.value })}
          />
          <small>
            {draft.instructions.length.toLocaleString("pt-BR")}/
            {LIMITS.instructions.toLocaleString("pt-BR")} caracteres
          </small>
        </label>
        <div className="skill-form-files">
          <span>Arquivos de referência</span>
          <small>
            Modelos, exemplos e regras que a MAVI lê quando precisar: texto,
            Markdown, CSV, JSON, PDF, Word, PowerPoint ou Excel (viram texto).
            Até {LIMITS.files} arquivos e 1 MB de texto. Scripts entram só para
            leitura: a MAVI não roda código.
          </small>
          {!!draft.files.length && (
            <ul className="skill-files">
              {draft.files.map((f) => (
                <li key={f.name}>
                  <button type="button" onClick={() => setViewing(f)}>
                    <span>{f.name}</span>
                    <small>{kb(new TextEncoder().encode(f.content).length)}</small>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Tirar ${f.name}`}
                    onClick={() => set({ files: draft.files.filter((x) => x.name !== f.name) })}
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <input
            ref={adder}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) void addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button className="btn secondary" onClick={() => adder.current?.click()}>
            <Plus size={15} /> Adicionar arquivos
          </Button>
        </div>
        <label>
          <span>O que mudou (opcional)</span>
          <Input
            value={draft.note}
            maxLength={500}
            placeholder="Ex.: Incluí o gráfico dia a dia"
            onChange={(e) => set({ note: e.target.value })}
          />
        </label>
        {showCheck && (
          <div ref={checkBox}>
            <SkillCheckPanel
              check={check}
              loading={checking}
              error={checkError}
              stale={!!check && checkedKey !== checkKey(draft)}
              draft={draft}
              applied={applied}
              onApply={apply}
              onUndo={undo}
              onRecheck={() => void runCheck("manual")}
              submitting={sending ? { label: sendLabel, busy } : null}
              onSendAnyway={() => void save(true)}
              onClose={() => {
                setShowCheck(false);
                setSending(false);
              }}
            />
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="skill-form-foot">
          <Button
            className="btn secondary skill-check-open"
            onClick={() => void runCheck("manual")}
            loading={checking && !sending}
            disabled={busy || problems.length > 0}
            title={problems[0] ?? "A MAVI lê a skill e diz o que incluir, corrigir, alterar, melhorar ou remover"}
          >
            <ShieldCheck size={15} /> Validar com a MAVI
          </Button>
          <Button className="btn secondary" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
          <Button className="btn secondary" onClick={() => void save(false)} loading={busy && !sending}>
            Salvar rascunho
          </Button>
          <Button
            className="btn primary"
            onClick={() => void submit()}
            loading={(busy && sending) || (checking && sending)}
          >
            <Check size={15} /> {sendLabel}
          </Button>
        </footer>
      </section>
      {coach && (
        <SkillAssistant
          company={company}
          draft={draft}
          isNew={isNew}
          autoSlug={isNew && !slugByHand}
          onDraft={setDraft}
          onClose={() => setCoach(false)}
        />
      )}
      </div>
      {viewing && (
        <Modal title={viewing.name} onClose={() => setViewing(null)}>
          <pre className="skill-file-view">{viewing.content}</pre>
        </Modal>
      )}
    </div>
  );
}
