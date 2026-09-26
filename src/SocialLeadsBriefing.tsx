import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleAlert,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { Button, Input, Select, SelectOption, Textarea } from "./ui";
import type { Member } from "./types";
import type { SocialLeadsBackend } from "./social-leads-api";
import { BriefingAiModal } from "./SocialLeadsBriefingAi";
import {
  briefingReadiness,
  briefingSteps,
  campaignObjectives,
  mediaAccept,
  mediaAllowed,
  missingChannel,
  parseColors,
  serializeColors,
  type BriefingField,
  type BriefingFields,
  type BriefingKey,
  type BriefingMedia,
  type CampaignObjective,
  type MediaFile,
  type MediaKey,
  type PortfolioItem,
  type SlBriefing,
  type SlJob,
} from "./social-leads";
import {
  ColorsInput,
  MediaInput,
  MoneyInput,
  PhoneInput,
  type ColorSearch,
  type Uploading,
} from "./SocialLeadsFields";

const MAX_FILE = 500 * 1024 * 1024;

type Person = Member & { squad: boolean };

/**
 * The briefing in 5 short steps. Every change is saved a moment later
 * (draft), with the version read: when someone else saved first the page
 * says so instead of overwriting. The side panel shows, while typing, what
 * stops the plan (the B29's validations) and what the plan will warn about.
 */
export function BriefingWizard({
  item,
  briefing,
  people,
  company,
  backend,
  hasPlan,
  job,
  canWrite,
  onSaved,
  onGenerated,
  notify,
}: {
  item: PortfolioItem;
  briefing: SlBriefing | null;
  people: Person[];
  company: string;
  backend: SocialLeadsBackend;
  hasPlan: boolean;
  job: SlJob | null;
  canWrite: boolean;
  onSaved: () => void;
  onGenerated: () => void;
  notify: (m: string) => void;
}) {
  const [fields, setFields] = useState<BriefingFields>(
    () => briefing?.fields ?? { clientName: item.client_name },
  );
  const [objective, setObjective] = useState<CampaignObjective | null>(
    briefing?.campaign_objective ?? null,
  );
  const [responsible, setResponsible] = useState<string | null>(
    briefing?.responsible_id ?? null,
  );
  const [media, setMedia] = useState<BriefingMedia>(
    () => briefing?.media ?? {},
  );
  const [uploading, setUploading] = useState<
    (Uploading & { field: MediaKey })[]
  >([]);
  const [colorSearch, setColorSearch] = useState<ColorSearch>({
    state: "idle",
  });
  // The site/Instagram last searched, so leaving the field again doesn't repeat it.
  const searched = useRef("");
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<
    | { kind: "idle" | "saving" | "saved" }
    | { kind: "error" | "conflict"; message: string }
  >({ kind: "idle" });
  const [generating, setGenerating] = useState(false);
  const [aiFill, setAiFill] = useState(false);
  const version = useRef<number | null>(briefing?.version ?? null);
  const dirty = useRef(false);
  const timer = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const latest = useRef({ fields, objective, responsible, media });
  latest.current = { fields, objective, responsible, media };

  // Someone else saved (live notice) and nothing is pending here: show it.
  useEffect(() => {
    if (!briefing || dirty.current) return;
    if (version.current !== null && briefing.version <= version.current) return;
    version.current = briefing.version;
    setFields(briefing.fields);
    setObjective(briefing.campaign_objective);
    setResponsible(briefing.responsible_id);
    setMedia(briefing.media ?? {});
  }, [briefing]);

  const save = (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return saving.current ?? Promise.resolve();
    const run = async () => {
      if (saving.current) await saving.current.catch(() => {});
      dirty.current = false;
      const {
        fields: f,
        objective: o,
        responsible: r,
        media: m,
      } = latest.current;
      setStatus({ kind: "saving" });
      try {
        version.current = await backend.saveBriefing(
          company,
          item.contract_id,
          f,
          o,
          r,
          version.current,
          m,
        );
        setStatus({ kind: "saved" });
        onSaved();
      } catch (e) {
        const message = (e as Error).message;
        setStatus({
          kind: /Outra pessoa salvou/.test(message) ? "conflict" : "error",
          message,
        });
        dirty.current = true;
        throw e;
      }
    };
    const p = run().finally(() => {
      if (saving.current === p) saving.current = null;
    });
    saving.current = p;
    return p;
  };
  const touch = () => {
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void save().catch(() => {}), 1200);
  };
  useEffect(
    () => () => {
      // Leaving the tab: keep what was typed.
      if (dirty.current) void save().catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const set = (key: BriefingKey, value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
    touch();
  };

  // Files: straight to the client's Drive, then saved in the briefing.
  const addFiles = async (key: MediaKey, list: File[]) => {
    for (const file of list) {
      if (!mediaAllowed(key, file.type)) {
        notify(
          `${file.name}: envie ${key === "socialProof" ? "imagem, vídeo ou áudio" : "imagem ou vídeo"}.`,
        );
        continue;
      }
      if (file.size > MAX_FILE) {
        notify(`${file.name}: envie arquivos de até 500 MB.`);
        continue;
      }
      const tag = `${Date.now()}-${file.name}`;
      setUploading((u) => [
        ...u,
        { key: tag, field: key, name: file.name, progress: 0 },
      ]);
      try {
        const sent = await backend.uploadMedia(
          company,
          item.contract_id,
          file,
          (progress) =>
            setUploading((u) =>
              u.map((x) => (x.key === tag ? { ...x, progress } : x)),
            ),
        );
        setMedia((m) => {
          const next = { ...m, [key]: [...(m[key] ?? []), sent] };
          latest.current = { ...latest.current, media: next };
          return next;
        });
        dirty.current = true;
        await save().catch(() => {});
      } catch (e) {
        notify((e as Error).message);
      } finally {
        setUploading((u) => u.filter((x) => x.key !== tag));
      }
    }
  };
  const removeFile = async (key: MediaKey, file: MediaFile) => {
    setMedia((m) => {
      const next = {
        ...m,
        [key]: (m[key] ?? []).filter((f) => f.id !== file.id),
      };
      latest.current = { ...latest.current, media: next };
      return next;
    });
    dirty.current = true;
    try {
      await save();
      await backend.deleteMedia(file);
    } catch {
      notify(
        `${file.name} saiu do briefing, mas continua no Drive do cliente.`,
      );
    }
  };

  // Brand colours: the AI reads the site and/or Instagram. Runs by itself when
  // one of them is filled in and no colour was written yet.
  const channels = () => ({
    website: missingChannel(latest.current.fields.websiteUrl)
      ? undefined
      : latest.current.fields.websiteUrl,
    instagram: missingChannel(latest.current.fields.igHandle)
      ? undefined
      : latest.current.fields.igHandle,
  });
  const searchColors = async (auto: boolean) => {
    const from = channels();
    const key = `${from.website ?? ""}|${from.instagram ?? ""}`;
    if (!from.website && !from.instagram) return;
    if (
      auto &&
      (searched.current === key ||
        parseColors(latest.current.fields.brandColors).length)
    )
      return;
    searched.current = key;
    setColorSearch({ state: "searching" });
    try {
      const r = await backend.brandColors(company, item.contract_id, from);
      const before = latest.current.fields.brandColors ?? "";
      const empty = !parseColors(before).length;
      if (empty) set("brandColors", serializeColors(r.colors));
      setColorSearch({
        state: "done",
        found: r.colors,
        note: r.note,
        cost: r.cost_usd,
        applied: empty ? before : null,
      });
    } catch (e) {
      setColorSearch({ state: "error", error: (e as Error).message });
    }
  };

  const readiness = briefingReadiness(
    fields,
    objective,
    item.client_name,
    media,
  );
  const running = job?.status === "running";
  const current = briefingSteps[step];
  const last = step === briefingSteps.length - 1;

  const generate = async () => {
    setGenerating(true);
    try {
      await save();
      await backend.generate(company, item.contract_id, "new");
      notify("A IA começou a escrever o plano. Leva de 1 a 3 minutos.");
      onGenerated();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="sl-wizard">
      {canWrite && (
        <div className="sl-ai-fill">
          <Sparkles size={18} aria-hidden="true" />
          <span>
            <strong>Tem as notas ou a gravação da reunião?</strong>
            <small>
              A IA lê a transcrição (ou uma reunião em Gravações da MAVI) e
              sugere os campos. Você revisa antes de entrar.
            </small>
          </span>
          <Button className="btn secondary" onClick={() => setAiFill(true)}>
            <Sparkles size={15} /> Preencher com a IA
          </Button>
        </div>
      )}
      {aiFill && (
        <BriefingAiModal
          company={company}
          contract={item.contract_id}
          backend={backend}
          current={fields}
          currentObjective={objective}
          onClose={() => setAiFill(false)}
          onApply={(found, foundObjective, count) => {
            setFields((f) => ({ ...f, ...found }));
            if (foundObjective) setObjective(foundObjective);
            touch();
            setAiFill(false);
            notify(
              `${count} ${count === 1 ? "campo preenchido" : "campos preenchidos"} pela IA. Revise os passos e ajuste o que precisar.`,
            );
          }}
        />
      )}
      <nav className="sl-steps" aria-label="Passos do briefing">
        {briefingSteps.map((s, i) => {
          const r = readiness.byStep[i];
          const done = r.filled === r.total;
          return (
            <button
              key={s.id}
              type="button"
              className={`${i === step ? "current" : ""} ${done ? "done" : ""}`}
              aria-current={i === step ? "step" : undefined}
              onClick={() => setStep(i)}
            >
              <i>{done ? <Check size={12} strokeWidth={3} /> : i + 1}</i>
              <span>
                {s.title}
                <small>
                  {r.filled} de {r.total}
                </small>
              </span>
            </button>
          );
        })}
      </nav>

      <form
        className="panel sl-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!last) setStep(step + 1);
        }}
      >
        <div className="sl-form-head">
          <h3>{current.title}</h3>
          <SaveStatus
            status={status}
            onRetry={() => void save().catch(() => {})}
            onDiscard={() => {
              // Take the version saved by the other person.
              dirty.current = false;
              version.current = -1;
              setStatus({ kind: "idle" });
              onSaved();
            }}
          />
        </div>
        {!canWrite && (
          <p className="sl-note">
            Você vê este briefing, mas só a equipe do cliente o edita.
          </p>
        )}
        <fieldset disabled={!canWrite} className="sl-fields">
          {current.id === "cliente" && (
            <label>
              Responsável
              <Select
                value={responsible ?? ""}
                onValueChange={(v) => {
                  setResponsible(v || null);
                  touch();
                }}
              >
                <SelectOption value="">Sem responsável</SelectOption>
                {people.map((p) => (
                  <SelectOption key={p.user_id} value={p.user_id}>
                    {p.squad ? p.name : `${p.name} (fora do squad)`}
                  </SelectOption>
                ))}
              </Select>
            </label>
          )}
          {current.fields.map((f) => (
            <Field
              key={f.key}
              field={f}
              value={fields[f.key] ?? ""}
              onChange={(v) => set(f.key, v)}
              disabled={!canWrite}
              onBlur={
                f.key === "igHandle" || f.key === "websiteUrl"
                  ? () => void searchColors(true)
                  : undefined
              }
              colors={
                f.kind === "colors"
                  ? {
                      canSearch: !!(channels().website || channels().instagram),
                      search: colorSearch,
                      onSearch: () => void searchColors(false),
                    }
                  : undefined
              }
              files={
                f.media
                  ? {
                      list: media[f.media] ?? [],
                      uploading: uploading.filter((u) => u.field === f.media),
                      onAdd: (list) => void addFiles(f.media!, list),
                      onRemove: (file) => void removeFile(f.media!, file),
                      urlOf: (file) => backend.mediaUrl(file),
                    }
                  : undefined
              }
            />
          ))}
          {current.id === "campanha" && (
            <div
              className="sl-wide sl-objectives"
              role="radiogroup"
              aria-label="Objetivo da campanha"
            >
              <span className="sl-label">
                Objetivo da campanha
                <em>Define a campanha e o post que vira anúncio.</em>
              </span>
              <div>
                {(Object.keys(campaignObjectives) as CampaignObjective[]).map(
                  (o) => (
                    <button
                      key={o}
                      type="button"
                      role="radio"
                      aria-checked={objective === o}
                      className={objective === o ? "selected" : ""}
                      onClick={() => {
                        setObjective(o);
                        touch();
                      }}
                    >
                      <strong>{campaignObjectives[o]}</strong>
                      <small>
                        {o === "form_nativo"
                          ? "O lead preenche um formulário curto dentro do Facebook ou Instagram."
                          : "O anúncio abre uma conversa no WhatsApp do cliente."}
                      </small>
                    </button>
                  ),
                )}
              </div>
            </div>
          )}
        </fieldset>
        <div className="sl-form-foot">
          <Button
            type="button"
            className="btn secondary"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
          >
            <ArrowLeft size={15} />{" "}
            {step > 0 ? briefingSteps[step - 1].title : "Anterior"}
          </Button>
          {!last && (
            <Button type="submit" className="btn secondary">
              Próximo: {briefingSteps[step + 1].title} <ArrowRight size={15} />
            </Button>
          )}
        </div>
      </form>

      <aside className="panel sl-ready">
        <div className="sl-ready-head">
          <strong>Pronto para a IA</strong>
          <span>
            {readiness.filled} de {readiness.total}
          </span>
        </div>
        <div className="sl-meter" aria-hidden="true">
          <i
            style={{
              width: `${Math.round((readiness.filled / readiness.total) * 100)}%`,
            }}
          />
        </div>
        {readiness.blockers.map((b) => (
          <p key={b} className="sl-alert bad">
            <CircleAlert size={15} />
            {b}
          </p>
        ))}
        {readiness.warnings.map((w) => (
          <p key={w} className="sl-alert warn">
            <TriangleAlert size={15} />
            {w}
          </p>
        ))}
        {!hasPlan && canWrite && (
          <Button
            className="btn primary sl-generate"
            disabled={!!readiness.blockers.length || running}
            loading={generating}
            onClick={() => void generate()}
            title={readiness.blockers[0]}
          >
            <Sparkles size={16} />
            {running ? "Gerando o plano…" : "Gerar plano do Mês 1"}
          </Button>
        )}
        {hasPlan && (
          <p className="sl-muted">
            Mudanças no briefing valem para o próximo plano gerado ou para
            “Regenerar este mês”.
          </p>
        )}
      </aside>
    </div>
  );
}

/** One briefing field: text, or its mask, colours or files. */
function Field({
  field: f,
  value,
  onChange,
  disabled,
  onBlur,
  colors,
  files,
}: {
  field: BriefingField;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  onBlur?: () => void;
  colors?: {
    canSearch: boolean;
    search: ColorSearch;
    onSearch: () => void;
  };
  files?: {
    list: MediaFile[];
    uploading: Uploading[];
    onAdd: (files: File[]) => void;
    onRemove: (file: MediaFile) => void;
    urlOf: (file: MediaFile) => Promise<string>;
  };
}) {
  const title = (
    <span className="sl-label">
      {f.label}
      {f.help && <em>{f.help}</em>}
    </span>
  );
  // Several controls: a group, not a <label> (it would focus only the first).
  if (f.kind === "colors" || f.media)
    return (
      <div
        className={`sl-field${f.long || f.media || f.kind === "colors" ? " sl-wide" : ""}`}
        role="group"
        aria-label={f.label}
      >
        {title}
        {f.kind === "colors" && colors ? (
          <ColorsInput
            value={value}
            onChange={onChange}
            disabled={disabled}
            {...colors}
          />
        ) : f.long ? (
          <Textarea
            rows={3}
            value={value}
            placeholder={f.placeholder}
            maxLength={8000}
            aria-label={f.label}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <Input
            type="text"
            value={value}
            placeholder={f.placeholder}
            maxLength={8000}
            aria-label={f.label}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {f.media && files && (
          <MediaInput
            files={files.list}
            uploading={files.uploading}
            accept={mediaAccept[f.media]}
            what={f.mediaWhat ?? "arquivos"}
            disabled={disabled}
            onAdd={files.onAdd}
            onRemove={files.onRemove}
            urlOf={files.urlOf}
          />
        )}
      </div>
    );
  return (
    <label className={f.long ? "sl-wide" : ""}>
      {title}
      {f.kind === "phone" ? (
        <PhoneInput value={value} onChange={onChange} disabled={disabled} />
      ) : f.kind === "money" ? (
        <MoneyInput
          value={value}
          onChange={onChange}
          disabled={disabled}
          label={f.label}
        />
      ) : f.long ? (
        <Textarea
          rows={3}
          value={value}
          placeholder={f.placeholder}
          maxLength={8000}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input
          type={f.type === "date" ? "date" : "text"}
          value={value}
          placeholder={f.placeholder}
          maxLength={8000}
          onBlur={onBlur}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

function SaveStatus({
  status,
  onRetry,
  onDiscard,
}: {
  status: { kind: string; message?: string };
  onRetry: () => void;
  onDiscard: () => void;
}) {
  if (status.kind === "saving")
    return <span className="sl-save">Salvando…</span>;
  if (status.kind === "saved")
    return (
      <span className="sl-save ok">
        <Check size={13} /> Salvo
      </span>
    );
  if (status.kind === "conflict")
    return (
      <span className="sl-save bad">
        {status.message}{" "}
        <button type="button" onClick={onDiscard}>
          Ver a versão atual
        </button>
      </span>
    );
  if (status.kind === "error")
    return (
      <span className="sl-save bad" role="alert">
        Não salvou: {status.message}{" "}
        <button type="button" onClick={onRetry}>
          Tentar de novo
        </button>
      </span>
    );
  return <span className="sl-save">Salva sozinho enquanto você digita</span>;
}
