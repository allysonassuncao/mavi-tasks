import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowDown, Bot, Clock, FileText, Plus, Repeat, Trash2, TriangleAlert, Type } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import { agentOp, errorOf, type AgentDraft, type AgentDetail } from "./agent-builder";
import { WeeklyHoursEditor } from "./AgentBuilderFields";

/**
 * Agentes MAVI › Follow-up: a régua de retomadas quando o lead para de
 * responder. Cada etapa conta da última mensagem do agente; o lead respondeu,
 * a régua para e recomeça na próxima vez que ele sumir. O motor envia.
 */

type Step = {
  id: string;
  after_minutes: number;
  mode: "ai" | "fixed";
  text: string;
  template: { template_id: string; params: string[] } | null;
};
type Followup = {
  enabled?: boolean;
  steps: Step[];
  window?: Record<string, { from: string; to: string } | null> | null;
  skip_if_meeting?: boolean;
  on_finish?: { move: { pipeline_id: string; stage_id: string } | null; notify: string | null; turn_off_ai: boolean };
};
type Template = { template_id: string; name: string; category: string | null; language: string; text: string; params: number; examples: string[] };
type Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };

const DELAYS: [number, string][] = [
  [15, "15 minutos"],
  [30, "30 minutos"],
  [60, "1 hora"],
  [120, "2 horas"],
  [240, "4 horas"],
  [480, "8 horas"],
  [720, "12 horas"],
  [1440, "1 dia"],
  [2880, "2 dias"],
  [4320, "3 dias"],
  [7200, "5 dias"],
  [10080, "7 dias"],
  [21600, "15 dias"],
  [43200, "30 dias"],
];
const delayLabel = (m: number) => DELAYS.find(([v]) => v === m)?.[1] ?? `${m} minutos`;

const newStep = (steps: Step[]): Step => {
  let n = steps.length + 1;
  while (steps.some((s) => s.id === `etapa_${n}`)) n++;
  const after = steps.length === 0 ? 60 : steps.length === 1 ? 1440 : 2880;
  return { id: `etapa_${n}`, after_minutes: after, mode: "ai", text: "", template: null };
};

const STARTER: Followup = {
  enabled: true,
  steps: [
    { id: "etapa_1", after_minutes: 60, mode: "ai", text: "Pergunte, de forma leve, se ficou alguma dúvida e retome o próximo passo.", template: null },
    { id: "etapa_2", after_minutes: 1440, mode: "ai", text: "Lembre o benefício principal e faça uma pergunta simples para o lead voltar.", template: null },
    { id: "etapa_3", after_minutes: 4320, mode: "fixed", text: "Oi {primeiro_nome}! Vou deixar seu atendimento em espera por aqui. Quando quiser continuar, é só me responder 🙂", template: null },
  ],
  window: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { from: "09:00", to: "19:00" }])),
  skip_if_meeting: true,
  on_finish: { move: null, notify: null, turn_off_ai: false },
};

function Check({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="ab-check">
      <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(c) => onChange(c === true)} />
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && <small className="ab-hint">{hint}</small>}
      </label>
    </div>
  );
}

function Row({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`ab-field ${wide ? "wide" : ""}`}>
      <span className="ab-label">{label}</span>
      {children}
      {hint && <small className="ab-hint">{hint}</small>}
    </div>
  );
}

export function FollowupPanel({
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
  const fu = (draft.followup ?? null) as Followup | null;
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [error, setError] = useState("");
  const hasNotify = Array.isArray(draft.integrations) && draft.integrations.some((i: { type: string; enabled?: boolean }) => i.type === "team_notify" && i.enabled !== false);

  useEffect(() => {
    if (!canEdit || !fu) return;
    Promise.all([
      agentOp<{ templates: Template[] }>(company, agentId, "crm-templates"),
      agentOp<{ pipelines: Pipeline[] }>(company, agentId, "crm-pipelines"),
    ])
      .then(([t, p]) => {
        setTemplates(t.templates);
        setPipelines(p.pipelines);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, canEdit, !!fu]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (next: Followup | null) => change("followup", next ?? undefined);
  const patch = (p: Partial<Followup>) => set({ ...(fu as Followup), ...p });
  const setStep = (i: number, p: Partial<Step>) => patch({ steps: fu!.steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  const end = fu?.on_finish ?? { move: null, notify: null, turn_off_ai: false };
  const err = errorFor("followup");

  if (!fu)
    return (
      <div className="ab-stack">
        <div className="agent-empty">
          <Repeat size={22} aria-hidden="true" />
          <strong>Sem follow-up</strong>
          <span>
            Quando o lead para de responder, o agente pode retomar a conversa sozinho, em etapas (ex.: 1 hora, 1 dia e 3 dias
            depois). Se o lead responder, a régua para.
          </span>
          {canEdit && (
            <Button type="button" className="btn primary" onClick={() => set(STARTER)}>
              <Plus size={15} aria-hidden="true" /> Criar régua de follow-up
            </Button>
          )}
        </div>
      </div>
    );

  return (
    <fieldset className="ab-panel" disabled={!canEdit}>
      <div className="ab-stack">
        <div className="ab-toolbar">
          <Check checked={fu.enabled !== false} onChange={(v) => patch({ enabled: v })} label="Follow-up ligado" hint="Vale depois de publicar." />
          {canEdit && (
            <button
              type="button"
              className="agent-link-btn danger"
              onClick={() => window.confirm("Apagar a régua de follow-up deste agente?") && set(null)}
            >
              <Trash2 size={14} aria-hidden="true" /> Apagar régua
            </button>
          )}
        </div>
        {err && <p className="ab-notice warn">{err}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <p className="ab-hint ab-section-intro">
          Cada etapa conta a partir da última mensagem do agente sem resposta. Se o lead responder em qualquer momento, a régua
          para e recomeça do zero na próxima vez que ele sumir. Quem desliga a IA na conversa no MakeCRM também para a régua.
        </p>

        <ol className="ab-steps">
          {fu.steps.map((s, i) => {
            const tpl = templates?.find((t) => t.template_id === s.template?.template_id);
            return (
              <li key={s.id} className="ab-step">
                <div className="ab-step-head">
                  <span className="ab-step-n">{i + 1}</span>
                  <span className="ab-step-when">
                    <Clock size={14} aria-hidden="true" />
                    <span className="ab-step-delay">
                    <Select
                      value={String(s.after_minutes)}
                      aria-label={`Etapa ${i + 1}: depois de`}
                      onValueChange={(v) => setStep(i, { after_minutes: Number(v) })}
                    >
                      {(DELAYS.some(([v]) => v === s.after_minutes) ? DELAYS : [...DELAYS, [s.after_minutes, delayLabel(s.after_minutes)] as [number, string]]).map(
                        ([v, l]) => (
                          <SelectOption key={v} value={String(v)}>
                            {l}
                          </SelectOption>
                        ),
                      )}
                    </Select>
                    </span>
                    <span className="ab-hint">{i === 0 ? "sem resposta depois da última mensagem do agente" : "sem resposta depois da etapa anterior"}</span>
                  </span>
                  {canEdit && fu.steps.length > 1 && (
                    <button type="button" className="agent-link-btn danger" aria-label={`Tirar etapa ${i + 1}`} onClick={() => patch({ steps: fu.steps.filter((_, j) => j !== i) })}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="ab-chips" role="group" aria-label="Como escrever">
                  <button type="button" className={s.mode === "ai" ? "selected" : ""} onClick={() => setStep(i, { mode: "ai" })}>
                    <Bot size={12} aria-hidden="true" /> A IA escreve pelo contexto
                  </button>
                  <button type="button" className={s.mode === "fixed" ? "selected" : ""} onClick={() => setStep(i, { mode: "fixed" })}>
                    <Type size={12} aria-hidden="true" /> Texto fixo
                  </button>
                </div>
                <Row
                  label={s.mode === "ai" ? "Orientação para a IA" : "Mensagem"}
                  hint={
                    s.mode === "ai"
                      ? "O que esta retomada deve fazer. A IA lê a conversa e escreve algo curto e natural, sem repetir."
                      : "Use {nome}, {primeiro_nome}, {agente} e {empresa}."
                  }
                  wide
                >
                  <Textarea
                    value={s.text}
                    rows={2}
                    maxLength={2000}
                    placeholder={s.mode === "ai" ? "Ex.: pergunte se ficou alguma dúvida sobre a proposta" : "Oi {primeiro_nome}, conseguiu ver minha última mensagem?"}
                    onChange={(e) => setStep(i, { text: e.target.value })}
                  />
                </Row>
                <div className="ab-step-template">
                  <Row
                    label="WhatsApp oficial com a janela de 24h fechada"
                    hint={
                      s.template
                        ? "Nas caixas da API oficial, depois de 24h sem o lead falar, vai este modelo aprovado no lugar da mensagem."
                        : "Sem modelo, esta etapa é pulada nas caixas da API oficial quando a janela de 24h estiver fechada (nas de QR Code vai normal)."
                    }
                    wide
                  >
                    {!templates && !error ? (
                      <Loading variant="inline" />
                    ) : (
                      <Select
                        value={s.template?.template_id ?? ""}
                        aria-label="Modelo aprovado"
                        onValueChange={(v) => {
                          const t = templates?.find((x) => x.template_id === v);
                          setStep(i, { template: t ? { template_id: t.template_id, params: t.examples.length ? t.examples.map((_, k) => (k === 0 ? "{primeiro_nome}" : "")) : Array.from({ length: t.params }, () => "") } : null });
                        }}
                      >
                        <SelectOption value="">Pular a etapa</SelectOption>
                        {(templates ?? []).map((t) => (
                          <SelectOption key={t.template_id} value={t.template_id}>
                            {`${t.name}${t.category ? ` · ${t.category.toLowerCase()}` : ""}`}
                          </SelectOption>
                        ))}
                      </Select>
                    )}
                  </Row>
                  {tpl && (
                    <div className="ab-template-preview">
                      <FileText size={14} aria-hidden="true" />
                      <span>{tpl.text || "(modelo sem texto)"}</span>
                    </div>
                  )}
                  {tpl && s.template && tpl.params > 0 && (
                    <div className="ab-grid">
                      {Array.from({ length: tpl.params }, (_, k) => (
                        <Row key={k} label={`Variável {{${k + 1}}}`} hint={tpl.examples[k] ? `Exemplo aprovado: ${tpl.examples[k]}` : undefined}>
                          <Input
                            value={s.template!.params[k] ?? ""}
                            maxLength={500}
                            placeholder="{primeiro_nome}"
                            onChange={(e) => {
                              const params = [...s.template!.params];
                              params[k] = e.target.value;
                              setStep(i, { template: { ...s.template!, params } });
                            }}
                          />
                        </Row>
                      ))}
                    </div>
                  )}
                </div>
                {i < fu.steps.length - 1 && <ArrowDown size={16} className="ab-step-arrow" aria-hidden="true" />}
              </li>
            );
          })}
        </ol>
        {canEdit && fu.steps.length < 10 && (
          <div className="ab-toolbar">
            <Button type="button" className="btn secondary compact" onClick={() => patch({ steps: [...fu.steps, newStep(fu.steps)] })}>
              <Plus size={14} aria-hidden="true" /> Nova etapa
            </Button>
          </div>
        )}

        <section className="ab-section">
          <h3>Quando enviar</h3>
          <Check
            checked={!!fu.window}
            onChange={(v) => patch({ window: v ? STARTER.window : null })}
            label="Só em dias e horários escolhidos"
            hint="Fora deles, a etapa espera o próximo horário permitido. Desmarcado: envia a qualquer hora."
          />
          {fu.window && <WeeklyHoursEditor value={fu.window as never} onChange={(v) => patch({ window: (v as never) ?? null })} />}
          <Check
            checked={fu.skip_if_meeting !== false}
            onChange={(v) => patch({ skip_if_meeting: v })}
            label="Não retomar quem já tem reunião marcada pelo agente"
          />
        </section>

        <section className="ab-section">
          <h3>Quando a régua terminar sem resposta</h3>
          <p className="ab-hint ab-section-intro">Escolha o que acontece depois da última etapa, se o lead não responder.</p>
          <Check
            checked={!!end.move}
            onChange={(v) => patch({ on_finish: { ...end, move: v ? { pipeline_id: pipelines?.[0]?.id ?? "", stage_id: "" } : null } })}
            label="Mover a oportunidade"
            hint="Ex.: para &quot;Sem resposta&quot; ou &quot;Perdido&quot;. Sem oportunidade aberta, nada acontece."
          />
          {end.move && (
            <div className="ab-grid">
              <Row label="Funil">
                <Select
                  value={end.move.pipeline_id}
                  aria-label="Funil"
                  onValueChange={(v) => patch({ on_finish: { ...end, move: { pipeline_id: v, stage_id: "" } } })}
                >
                  <SelectOption value="">Escolha o funil</SelectOption>
                  {(pipelines ?? []).map((p) => (
                    <SelectOption key={p.id} value={p.id}>
                      {p.name}
                    </SelectOption>
                  ))}
                </Select>
              </Row>
              <Row label="Etapa">
                <Select
                  value={end.move.stage_id}
                  aria-label="Etapa"
                  onValueChange={(v) => patch({ on_finish: { ...end, move: { ...end.move!, stage_id: v } } })}
                >
                  <SelectOption value="">Escolha a etapa</SelectOption>
                  {(pipelines?.find((p) => p.id === end.move!.pipeline_id)?.stages ?? []).map((s) => (
                    <SelectOption key={s.id} value={s.id}>
                      {s.name}
                    </SelectOption>
                  ))}
                </Select>
              </Row>
            </div>
          )}
          <Check
            checked={end.notify != null}
            onChange={(v) => patch({ on_finish: { ...end, notify: v ? "O lead {nome} não respondeu ao follow-up." : null } })}
            label="Avisar a equipe no WhatsApp"
          />
          {end.notify != null && (
            <>
              {!hasNotify && (
                <p className="ab-notice warn">
                  <TriangleAlert size={15} aria-hidden="true" /> Configure "Avisar a equipe no WhatsApp" na aba Integrações (caixa e
                  números) para este aviso sair.
                </p>
              )}
              <Row label="Aviso" hint="Use {nome}." wide>
                <Input value={end.notify} maxLength={1000} onChange={(e) => patch({ on_finish: { ...end, notify: e.target.value } })} />
              </Row>
            </>
          )}
          <Check
            checked={end.turn_off_ai}
            onChange={(v) => patch({ on_finish: { ...end, turn_off_ai: v } })}
            label="Desligar a IA na conversa"
            hint="A conversa fica com a equipe; se o lead voltar, quem responde é uma pessoa."
          />
        </section>
        {!detail.bindings.length && <p className="ab-hint">O follow-up só sai em conversas reais: ligue o agente a uma caixa na aba Caixas.</p>}
      </div>
    </fieldset>
  );
}
