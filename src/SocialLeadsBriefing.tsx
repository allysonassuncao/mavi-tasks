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
import {
  briefingReadiness,
  briefingSteps,
  campaignObjectives,
  type BriefingFields,
  type BriefingKey,
  type CampaignObjective,
  type PortfolioItem,
  type SlBriefing,
  type SlJob,
} from "./social-leads";

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
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<
    | { kind: "idle" | "saving" | "saved" }
    | { kind: "error" | "conflict"; message: string }
  >({ kind: "idle" });
  const [generating, setGenerating] = useState(false);
  const version = useRef<number | null>(briefing?.version ?? null);
  const dirty = useRef(false);
  const timer = useRef(0);
  const saving = useRef<Promise<void> | null>(null);
  const latest = useRef({ fields, objective, responsible });
  latest.current = { fields, objective, responsible };

  // Someone else saved (live notice) and nothing is pending here: show it.
  useEffect(() => {
    if (!briefing || dirty.current) return;
    if (version.current !== null && briefing.version <= version.current) return;
    version.current = briefing.version;
    setFields(briefing.fields);
    setObjective(briefing.campaign_objective);
    setResponsible(briefing.responsible_id);
  }, [briefing]);

  const save = (): Promise<void> => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return saving.current ?? Promise.resolve();
    const run = async () => {
      if (saving.current) await saving.current.catch(() => {});
      dirty.current = false;
      const { fields: f, objective: o, responsible: r } = latest.current;
      setStatus({ kind: "saving" });
      try {
        version.current = await backend.saveBriefing(
          company,
          item.contract_id,
          f,
          o,
          r,
          version.current,
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

  const readiness = briefingReadiness(fields, objective, item.client_name);
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
            <label key={f.key} className={f.long ? "sl-wide" : ""}>
              <span className="sl-label">
                {f.label}
                {f.help && <em>{f.help}</em>}
              </span>
              {f.long ? (
                <Textarea
                  rows={3}
                  value={fields[f.key] ?? ""}
                  placeholder={f.placeholder}
                  maxLength={8000}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <Input
                  type={f.type === "date" ? "date" : "text"}
                  value={fields[f.key] ?? ""}
                  placeholder={f.placeholder}
                  maxLength={8000}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
            </label>
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
