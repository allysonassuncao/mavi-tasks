import { useEffect, useId, useState, type ReactNode } from "react";
import {
  BellRing,
  Bot,
  CalendarClock,
  Clock,
  Plus,
  Trash2,
  TriangleAlert,
  Type,
} from "lucide-react";
import { Button, Checkbox, Select, SelectOption, Textarea } from "./ui";
import {
  agentOp,
  errorOf,
  type AgentDetail,
  type AgentDraft,
} from "./agent-builder";
import { WeeklyHoursEditor } from "./AgentBuilderFields";
import {
  StepTemplatePicker,
  type StepTemplate,
  type Template,
} from "./AgentFollowup";

/**
 * Agentes MAVI › Pré-reunião: a régua de mensagens em volta das reuniões que
 * o próprio agente marcou — X antes do início (lembrete, pedido de
 * confirmação) e X depois do fim. Remarcou: a régua acompanha; cancelou: para.
 * O motor envia (meeting_reminders na especificação).
 */

type Step = {
  id: string;
  when: "before" | "after";
  minutes: number;
  mode: "ai" | "fixed";
  text: string;
  confirm: boolean;
  template: StepTemplate | null;
};
type Reminders = {
  enabled?: boolean;
  steps: Step[];
  window?: Record<string, { from: string; to: string } | null> | null;
  when_ai_off?: "send" | "skip";
  confirmation?: {
    alert_minutes_before: number | null;
    notify_on_decline: boolean;
  };
};

const TIMES: [number, string][] = [
  [5, "5 minutos"],
  [10, "10 minutos"],
  [15, "15 minutos"],
  [30, "30 minutos"],
  [60, "1 hora"],
  [120, "2 horas"],
  [180, "3 horas"],
  [240, "4 horas"],
  [480, "8 horas"],
  [720, "12 horas"],
  [1440, "1 dia"],
  [2880, "2 dias"],
  [4320, "3 dias"],
  [10080, "7 dias"],
];
const timeLabel = (m: number) =>
  TIMES.find(([v]) => v === m)?.[1] ?? `${m} minutos`;
const VARS =
  "{primeiro_nome}, {nome}, {dia_semana}, {data}, {hora}, {link}, {anfitriao}, {agente} e {empresa}";

const STARTER: Reminders = {
  enabled: true,
  steps: [
    {
      id: "lembrete_1",
      when: "before",
      minutes: 1440,
      mode: "ai",
      text: "Lembre da reunião ({dia_semana}, {data} às {hora}) com {anfitriao} e peça para o lead confirmar a presença.",
      confirm: true,
      template: null,
    },
    {
      id: "lembrete_2",
      when: "before",
      minutes: 60,
      mode: "fixed",
      text: "Oi {primeiro_nome}! Daqui a 1 hora, às {hora}, temos a nossa conversa 🙂",
      confirm: false,
      template: null,
    },
    {
      id: "lembrete_3",
      when: "before",
      minutes: 10,
      mode: "fixed",
      text: "Já vai começar! É só entrar por aqui: {link}",
      confirm: false,
      template: null,
    },
    {
      id: "lembrete_4",
      when: "after",
      minutes: 30,
      mode: "ai",
      text: "Agradeça pela conversa em poucas palavras. Se pelo histórico parecer que o lead não participou, ofereça remarcar.",
      confirm: false,
      template: null,
    },
  ],
  window: Object.fromEntries(
    ["mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [
      d,
      { from: "08:00", to: "20:00" },
    ]),
  ),
  when_ai_off: "send",
  confirmation: { alert_minutes_before: 60, notify_on_decline: true },
};

const order = (s: Step) => (s.when === "before" ? -s.minutes : s.minutes);
const newStep = (steps: Step[]): Step => {
  let n = steps.length + 1;
  while (steps.some((s) => s.id === `lembrete_${n}`)) n++;
  const used = new Set(
    steps.filter((s) => s.when === "before").map((s) => s.minutes),
  );
  const minutes =
    [120, 30, 15, 180, 240, 480, 5].find((m) => !used.has(m)) ?? 720;
  return {
    id: `lembrete_${n}`,
    when: "before",
    minutes,
    mode: "fixed",
    text: "",
    confirm: false,
    template: null,
  };
};

function Check({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="ab-check">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(c) => onChange(c === true)}
      />
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && <small className="ab-hint">{hint}</small>}
      </label>
    </div>
  );
}

function Row({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={`ab-field ${wide ? "wide" : ""}`}>
      <span className="ab-label">{label}</span>
      {children}
      {hint && <small className="ab-hint">{hint}</small>}
    </div>
  );
}

export function RemindersPanel({
  company,
  agentId,
  detail,
  draft,
  canEdit,
  change,
  errorFor,
}: {
  company: string;
  agentId: string;
  detail: AgentDetail;
  draft: AgentDraft;
  canEdit: boolean;
  change: (path: string, value: unknown) => void;
  errorFor: (path: string) => string | undefined;
}) {
  const r = (draft.meeting_reminders ?? null) as Reminders | null;
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState("");
  const integrations: { type: string; enabled?: boolean }[] = Array.isArray(
    draft.integrations,
  )
    ? draft.integrations
    : [];
  const hasCalendar = integrations.some(
    (i) => i.type === "google_calendar" && i.enabled !== false,
  );
  const hasNotify = integrations.some(
    (i) => i.type === "team_notify" && i.enabled !== false,
  );

  useEffect(() => {
    if (!canEdit || !r) return;
    agentOp<{ templates: Template[] }>(company, agentId, "crm-templates")
      .then((t) => setTemplates(t.templates))
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, canEdit, !!r]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: Reminders | null) =>
    change("meeting_reminders", next ?? undefined);
  const patch = (p: Partial<Reminders>) => set({ ...(r as Reminders), ...p });
  const setStep = (id: string, p: Partial<Step>) =>
    patch({
      steps: r!.steps.map((s) =>
        s.id === id
          ? { ...s, ...p, ...(p.when === "after" ? { confirm: false } : {}) }
          : s,
      ),
    });
  const conf = r?.confirmation ?? {
    alert_minutes_before: 60,
    notify_on_decline: true,
  };
  const asksConfirmation = !!r?.steps.some((s) => s.confirm);
  const err = errorFor("meeting_reminders");

  if (!r)
    return (
      <div className="ab-stack">
        <div className="agent-empty">
          <CalendarClock size={22} aria-hidden="true" />
          <strong>Sem régua de pré-reunião</strong>
          <span>
            Quando o agente marca uma reunião, ele pode falar com o lead sozinho
            em volta dela: lembrar 1 dia antes pedindo confirmação, mandar o
            link 10 minutos antes e agradecer depois. Se a reunião for
            remarcada, a régua acompanha; se for cancelada, para.
          </span>
          {!hasCalendar && (
            <p className="ab-notice warn">
              <TriangleAlert size={15} aria-hidden="true" /> Vale para as
              reuniões marcadas pelo agente: configure o Google Agenda na aba
              Integrações.
            </p>
          )}
          {canEdit && (
            <Button
              type="button"
              className="btn primary"
              onClick={() => set(STARTER)}
            >
              <Plus size={15} aria-hidden="true" /> Criar régua de pré-reunião
            </Button>
          )}
        </div>
      </div>
    );

  const steps = [...r.steps].sort((a, b) => order(a) - order(b));
  return (
    <fieldset className="ab-panel" disabled={!canEdit}>
      <div className="ab-stack">
        <div className="ab-toolbar">
          <Check
            checked={r.enabled !== false}
            onChange={(v) => patch({ enabled: v })}
            label="Régua de pré-reunião ligada"
            hint="Vale depois de publicar."
          />
          {canEdit && (
            <button
              type="button"
              className="agent-link-btn danger"
              onClick={() =>
                window.confirm("Apagar a régua de pré-reunião deste agente?") &&
                set(null)
              }
            >
              <Trash2 size={14} aria-hidden="true" /> Apagar régua
            </button>
          )}
        </div>
        {err && <p className="ab-notice warn">{err}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!hasCalendar && (
          <p className="ab-notice warn">
            <TriangleAlert size={15} aria-hidden="true" /> A régua vale para as
            reuniões marcadas pelo agente: configure o Google Agenda na aba
            Integrações.
          </p>
        )}
        <p className="ab-hint ab-section-intro">
          Vale para as reuniões que o agente marcou. Cada etapa conta a partir
          do início da reunião (antes) ou do fim (depois). Remarcou: a régua
          recomeça para o novo horário; cancelou: para. Se o lead responder, o
          agente conversa normalmente (pode remarcar ou cancelar).
        </p>

        <ol className="ab-steps">
          {steps.map((s, i) => (
            <li key={s.id} className="ab-step">
              <div className="ab-step-head">
                <span className="ab-step-n">{i + 1}</span>
                <span className="ab-step-when">
                  <Clock size={14} aria-hidden="true" />
                  <span className="ab-step-delay">
                    <Select
                      value={String(s.minutes)}
                      aria-label={`Etapa ${i + 1}: quanto tempo`}
                      onValueChange={(v) =>
                        setStep(s.id, { minutes: Number(v) })
                      }
                    >
                      {(TIMES.some(([v]) => v === s.minutes)
                        ? TIMES
                        : [
                            ...TIMES,
                            [s.minutes, timeLabel(s.minutes)] as [
                              number,
                              string,
                            ],
                          ]
                      ).map(([v, l]) => (
                        <SelectOption key={v} value={String(v)}>
                          {l}
                        </SelectOption>
                      ))}
                    </Select>
                  </span>
                  <span className="ab-step-delay">
                    <Select
                      value={s.when}
                      aria-label={`Etapa ${i + 1}: antes ou depois`}
                      onValueChange={(v) =>
                        setStep(s.id, { when: v as Step["when"] })
                      }
                    >
                      <SelectOption value="before">
                        antes do início
                      </SelectOption>
                      <SelectOption value="after">depois do fim</SelectOption>
                    </Select>
                  </span>
                </span>
                {canEdit && r.steps.length > 1 && (
                  <button
                    type="button"
                    className="agent-link-btn danger"
                    aria-label={`Tirar etapa ${i + 1}`}
                    onClick={() =>
                      patch({ steps: r.steps.filter((x) => x.id !== s.id) })
                    }
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="ab-chips" role="group" aria-label="Como escrever">
                <button
                  type="button"
                  className={s.mode === "fixed" ? "selected" : ""}
                  onClick={() => setStep(s.id, { mode: "fixed" })}
                >
                  <Type size={12} aria-hidden="true" /> Texto fixo
                </button>
                <button
                  type="button"
                  className={s.mode === "ai" ? "selected" : ""}
                  onClick={() => setStep(s.id, { mode: "ai" })}
                >
                  <Bot size={12} aria-hidden="true" /> A MAVI escreve pelo
                  contexto
                </button>
              </div>
              <Row
                label={s.mode === "ai" ? "Orientação para a MAVI" : "Mensagem"}
                hint={
                  s.mode === "ai"
                    ? `O que esta mensagem deve fazer; a MAVI lê a conversa e escreve algo curto. Pode usar ${VARS}.`
                    : `Use ${VARS}. Uma linha em branco separa os balões.`
                }
                wide
              >
                <Textarea
                  value={s.text}
                  rows={2}
                  maxLength={2000}
                  placeholder={
                    s.mode === "ai"
                      ? "Ex.: lembre da reunião de amanhã e pergunte se está tudo certo"
                      : "Oi {primeiro_nome}! Nossa conversa é hoje às {hora}: {link}"
                  }
                  onChange={(e) => setStep(s.id, { text: e.target.value })}
                />
              </Row>
              {s.when === "before" && (
                <Check
                  checked={s.confirm}
                  onChange={(v) => setStep(s.id, { confirm: v })}
                  label="Pedir confirmação de presença"
                  hint={
                    s.mode === "ai"
                      ? "A MAVI pede para o lead confirmar respondendo."
                      : 'Escreva no texto o pedido (ex.: "Consegue confirmar sua presença?").'
                  }
                />
              )}
              <StepTemplatePicker
                templates={templates}
                error={error}
                value={s.template}
                onChange={(template) => setStep(s.id, { template })}
              />
            </li>
          ))}
        </ol>
        {canEdit && r.steps.length < 10 && (
          <div className="ab-toolbar">
            <Button
              type="button"
              className="btn secondary compact"
              onClick={() => patch({ steps: [...r.steps, newStep(r.steps)] })}
            >
              <Plus size={14} aria-hidden="true" /> Nova etapa
            </Button>
          </div>
        )}

        <section className="ab-section">
          <h3>Quando enviar</h3>
          <Check
            checked={!!r.window}
            onChange={(v) => patch({ window: v ? STARTER.window : null })}
            label="Só em dias e horários escolhidos"
            hint="Fora deles, a etapa vai para o próximo horário permitido (se ainda der antes da reunião). Lembretes de menos de 1 hora antes saem mesmo fora."
          />
          {r.window && (
            <WeeklyHoursEditor
              value={r.window as never}
              onChange={(v) => patch({ window: (v as never) ?? null })}
            />
          )}
          <Row label="Se uma pessoa assumiu a conversa (IA desligada no MakeCRM)">
            <Select
              value={r.when_ai_off ?? "send"}
              aria-label="Com a IA desligada"
              onValueChange={(v) =>
                patch({ when_ai_off: v as Reminders["when_ai_off"] })
              }
            >
              <SelectOption value="send">Os lembretes continuam</SelectOption>
              <SelectOption value="skip">Os lembretes não saem</SelectOption>
            </Select>
          </Row>
        </section>

        {asksConfirmation && (
          <section className="ab-section">
            <h3>
              <BellRing size={15} aria-hidden="true" /> Confirmação de presença
            </h3>
            <p className="ab-hint ab-section-intro">
              Quando o lead responde, o agente registra (confirmou ou não vai)
              no histórico da oportunidade. Se ele não puder ir, o agente
              oferece remarcar.
            </p>
            <Row label="Sem confirmação, avisar a equipe">
              <Select
                value={String(conf.alert_minutes_before ?? "")}
                aria-label="Sem confirmação, avisar a equipe"
                onValueChange={(v) =>
                  patch({
                    confirmation: {
                      ...conf,
                      alert_minutes_before: v ? Number(v) : null,
                    },
                  })
                }
              >
                <SelectOption value="">Não avisar</SelectOption>
                {[30, 60, 120, 240, 480, 1440].map((m) => (
                  <SelectOption key={m} value={String(m)}>
                    {`${timeLabel(m)} antes da reunião`}
                  </SelectOption>
                ))}
              </Select>
            </Row>
            <Check
              checked={conf.notify_on_decline}
              onChange={(v) =>
                patch({ confirmation: { ...conf, notify_on_decline: v } })
              }
              label="Avisar a equipe quando o lead disser que não vai"
            />
            {!hasNotify &&
              (conf.alert_minutes_before != null || conf.notify_on_decline) && (
                <p className="ab-notice warn">
                  <TriangleAlert size={15} aria-hidden="true" /> Configure
                  "Avisar a equipe no WhatsApp" na aba Integrações para os
                  avisos saírem (a nota privada na conversa do MakeCRM fica de
                  qualquer jeito).
                </p>
              )}
          </section>
        )}
        {!detail.bindings.length && (
          <p className="ab-hint">
            A régua só sai em conversas reais: ligue o agente a uma caixa na aba
            Caixas.
          </p>
        )}
      </div>
    </fieldset>
  );
}
