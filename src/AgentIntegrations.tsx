import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowRightLeft, BellRing, Briefcase, CalendarDays, CircleCheck, Plug, Plus, Trash2, TriangleAlert, UserCog, X, type LucideIcon } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import {
  agentOp,
  errorOf,
  FAILURE_FIX,
  INTEGRATION_LABEL,
  when,
  type AgentDraft,
  type CalendarCheck,
  type DealCatalog,
  type IntegrationFailures,
  type MakecrmInbox,
} from "./agent-builder";
import { WeeklyHoursEditor } from "./AgentBuilderFields";
import { IntegrationPatternsAlert } from "./AgentActionDiagnosis";

/**
 * Agentes MAVI › Integrações: o que o agente pode FAZER na conversa. Tudo é
 * executado pelo motor (sem n8n): Google Agenda pelas contas conectadas no
 * MakeCRM, oportunidade e responsáveis direto no MakeCRM, aviso à equipe pelo
 * WhatsApp. A configuração fica no rascunho (Salvar rascunho / Publicar).
 */

export type Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };
export type CrmUser = { id: string; name: string; email: string | null; google: string | null };
type RotationUser = { user_id: string; weight: number; work_hours: boolean };
/** Quem fica com a atividade criada pelo agente. */
export type ActivityAssignee = { mode: "deal_role" | "fixed" | "round_robin"; role: "owner" | "sdr" | "closer"; user_id: string | null; users: RotationUser[] };
export const DEFAULT_ASSIGNEE: ActivityAssignee = { mode: "deal_role", role: "owner", user_id: null, users: [] };
type RoleTarget = { mode: "fixed" | "round_robin"; user_id?: string; users: RotationUser[] };
type Integration = Record<string, any> & { type: string; enabled?: boolean };

const CATALOG: { type: string; icon: LucideIcon; title: string; text: string; make: () => Integration }[] = [
  {
    type: "google_calendar",
    icon: CalendarDays,
    title: "Google Agenda",
    text: "Busca horários livres e marca, remarca ou cancela reuniões (com link do Meet) na agenda conectada no MakeCRM.",
    make: () => ({
      type: "google_calendar",
      enabled: true,
      hosts: [],
      distribution: "fixed",
      duration_minutes: 30,
      allowed_hours: Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { from: "09:00", to: "18:00" }])),
      min_notice_minutes: 60,
      days_ahead: 14,
      slot_step_minutes: 30,
      title: "Reunião com {lead}",
      invite_lead: true,
      meet_link: true,
      add_summary: true,
    }),
  },
  {
    type: "makecrm_move_deal",
    icon: ArrowRightLeft,
    title: "Mover oportunidade no MakeCRM",
    text: "Quando a conversa chega num ponto (ex.: o lead informou o orçamento), o agente move a oportunidade para a etapa certa.",
    make: () => ({ type: "makecrm_move_deal", enabled: true, rules: [], run_automations: true }),
  },
  {
    type: "makecrm_change_owner",
    icon: UserCog,
    title: "Trocar responsável no MakeCRM",
    text: "Define o proprietário, SDR ou closer da oportunidade (fixo ou em rodízio) quando a situação pedir.",
    make: () => ({ type: "makecrm_change_owner", enabled: true, rules: [] }),
  },
  {
    type: "makecrm_deal_actions",
    icon: Briefcase,
    title: "Ações na oportunidade do MakeCRM",
    text: "Dar como perdida ou ganha, registrar orçamento, anotar no histórico e criar atividades, como na tela do MakeCRM (mesmo histórico e automações).",
    make: () => ({
      type: "makecrm_deal_actions",
      enabled: true,
      lost: { enabled: false, when: "", reasons: [], cancel_meetings: true, complete_activities: true },
      won: { enabled: false, when: "" },
      quote: { enabled: false, when: "", products: [] },
      note: { enabled: true, when: "" },
      activity: { enabled: false, when: "", types: [], assignee: DEFAULT_ASSIGNEE, default_due_hours: 24 },
    }),
  },
  {
    type: "team_notify",
    icon: BellRing,
    title: "Avisar a equipe no WhatsApp",
    text: "Manda uma mensagem para números da equipe (ex.: lead quente, reclamação), por uma caixa de WhatsApp do MakeCRM.",
    make: () => ({ type: "team_notify", enabled: true, inbox_id: "", phones: [], when: "" }),
  },
];

const newRuleId = (rules: { id: string }[]) => {
  let n = rules.length + 1;
  while (rules.some((r) => r.id === `regra_${n}`)) n++;
  return `regra_${n}`;
};

export function IntegrationsPanel({
  company,
  agentId,
  draft,
  canEdit,
  change,
  errorFor,
}: {
  company: string;
  agentId: string;
  draft: AgentDraft;
  canEdit: boolean;
  change: (path: string, value: unknown) => void;
  errorFor: (path: string) => string | undefined;
}) {
  const list: Integration[] = Array.isArray(draft.integrations) ? draft.integrations : [];
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [users, setUsers] = useState<CrmUser[] | null>(null);
  const [inboxes, setInboxes] = useState<MakecrmInbox[] | null>(null);
  const [catalog, setCatalog] = useState<DealCatalog | null>(null);
  const [error, setError] = useState("");
  const wantsCatalog = list.some((x) => x.type === "makecrm_deal_actions");

  useEffect(() => {
    if (!canEdit || !wantsCatalog || catalog) return;
    agentOp<DealCatalog>(company, agentId, "crm-deal-catalog")
      .then(setCatalog)
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, canEdit, wantsCatalog, catalog]);

  useEffect(() => {
    if (!canEdit) return;
    Promise.all([
      agentOp<{ pipelines: Pipeline[] }>(company, agentId, "crm-pipelines"),
      agentOp<{ users: CrmUser[] }>(company, agentId, "crm-users"),
      agentOp<{ inboxes: MakecrmInbox[] }>(company, agentId, "inboxes"),
    ])
      .then(([p, u, i]) => {
        setPipelines(p.pipelines);
        setUsers(u.users);
        setInboxes(i.inboxes);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, canEdit]);

  const set = (next: Integration[]) => change("integrations", next.length ? next : undefined);
  const update = (i: number, patch: Integration) => set(list.map((x, j) => (j === i ? patch : x)));

  return (
    <div className="ab-stack">
      <p className="ab-hint ab-section-intro">
        O que o agente pode fazer além de conversar. Cada integração roda direto no Google e no MakeCRM. Na aba Testar nada é
        gravado: a agenda é lida de verdade, mas marcar, mover e trocar só mostram o que aconteceria.
      </p>
      <FailuresAlert company={company} agentId={agentId} />
      <IntegrationPatternsAlert company={company} agentId={agentId} />
      {error && <p className="form-error" role="alert">{error}</p>}
      {canEdit && !error && (!pipelines || !users) && <Loading variant="list" />}
      {CATALOG.map((c) => {
        const i = list.findIndex((x) => x.type === c.type);
        const cfg = i >= 0 ? list[i]! : null;
        const err = i >= 0 ? errorFor(`integrations.${i}`) : undefined;
        return (
          <section key={c.type} className={`ab-section ab-integration ${cfg ? (cfg.enabled === false ? "off" : "on") : ""}`}>
            <div className="ab-integration-head">
              <c.icon size={20} aria-hidden="true" />
              <div className="ab-integration-title">
                <h3>{c.title}</h3>
                <p className="ab-hint">{c.text}</p>
              </div>
              {canEdit &&
                (cfg ? (
                  <span className="ab-row-actions">
                    <span className="ab-check compact">
                      <Checkbox
                        id={`ab-int-${c.type}`}
                        checked={cfg.enabled !== false}
                        onCheckedChange={(v) => update(i, { ...cfg, enabled: v === true })}
                      />
                      <label htmlFor={`ab-int-${c.type}`}>Ligada</label>
                    </span>
                    <button
                      type="button"
                      className="agent-link-btn danger"
                      aria-label={`Remover ${c.title}`}
                      onClick={() => window.confirm(`Remover a integração "${c.title}" deste agente?`) && set(list.filter((_, j) => j !== i))}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </span>
                ) : (
                  <Button type="button" className="btn secondary compact" onClick={() => set([...list, c.make()])}>
                    <Plus size={14} aria-hidden="true" /> Configurar
                  </Button>
                ))}
            </div>
            {err && <p className="ab-notice warn">{err}</p>}
            {cfg && (
              <fieldset className="ab-panel" disabled={!canEdit}>
                {c.type === "google_calendar" && <CalendarForm cfg={cfg} users={users} onChange={(v) => update(i, v)} />}
                {c.type === "makecrm_move_deal" && <MoveDealForm cfg={cfg} pipelines={pipelines} onChange={(v) => update(i, v)} />}
                {c.type === "makecrm_change_owner" && <ChangeOwnerForm cfg={cfg} users={users} onChange={(v) => update(i, v)} />}
                {c.type === "team_notify" && <NotifyForm cfg={cfg} inboxes={inboxes} onChange={(v) => update(i, v)} />}
                {c.type === "makecrm_deal_actions" && <DealActionsForm cfg={cfg} catalog={catalog} users={users} onChange={(v) => update(i, v)} />}
              </fieldset>
            )}
            {cfg && c.type === "google_calendar" && <CalendarTest company={company} agentId={agentId} hosts={cfg.hosts ?? []} users={users} />}
          </section>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------ saúde
/** As falhas das integrações nas conversas reais (últimos 7 dias), com como corrigir. */
function FailuresAlert({ company, agentId }: { company: string; agentId: string }) {
  const [data, setData] = useState<IntegrationFailures | null>(null);
  useEffect(() => {
    agentOp<IntegrationFailures>(company, agentId, "integration-failures", { days: 7 })
      .then(setData)
      .catch(() => setData(null));
  }, [company, agentId]);
  if (!data?.groups.length) return null;
  return (
    <section className="ab-notice warn int-failures" role="alert">
      <strong>
        <TriangleAlert size={15} aria-hidden="true" /> Integrações falharam em conversas reais nos últimos {data.days} dias
      </strong>
      <ul className="ai-plain">
        {data.groups.map((g) => (
          <li key={`${g.integration}:${g.code}`}>
            <strong>{INTEGRATION_LABEL[g.integration] ?? g.integration}</strong> · {g.n} vez(es), a última em {when(g.last_at)}
            {g.notified > 0 && " · equipe avisada"}
            <br />
            <span>{g.last_message}</span>
            <br />
            <span className="muted">Como corrigir: {FAILURE_FIX[g.code] ?? FAILURE_FIX.error}</span>
          </li>
        ))}
      </ul>
      <span className="muted ai-small">
        Quando uma integração falha, o agente diz ao lead que a equipe vai confirmar (não inventa). Com "Avisar a equipe" ligada, a equipe recebe o aviso no
        WhatsApp (no máximo um a cada 6 horas por motivo).
      </span>
    </section>
  );
}

/** Testa agora a agenda de cada pessoa que recebe as reuniões. */
function CalendarTest({ company, agentId, hosts, users }: { company: string; agentId: string; hosts: RotationUser[]; users: CrmUser[] | null }) {
  const [results, setResults] = useState<CalendarCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const name = (id: string) => users?.find((u) => u.id === id)?.name ?? id;
  const test = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await agentOp<{ results: CalendarCheck[] }>(company, agentId, "calendar-test", { user_ids: hosts.map((h) => h.user_id) });
      setResults(r.results);
    } catch (e) {
      setError(errorOf(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="int-test">
      <div className="ab-toolbar">
        <span className="muted ai-small">Confere agora, de verdade, se o motor lê a agenda de cada pessoa (as próximas 24 h).</span>
        <Button type="button" className="btn secondary" loading={busy} disabled={!hosts.length} onClick={() => void test()}>
          <Plug size={14} aria-hidden="true" /> Testar conexão
        </Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {results && (
        <ul className="ai-plain">
          {results.map((r) => (
            <li key={r.user_id} className={`int-check ${r.status === "ok" && !r.warning ? "ok" : "bad"}`}>
              {r.status === "ok" && !r.warning ? <CircleCheck size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
              <span>
                <strong>{name(r.user_id)}</strong>
                {r.email ? ` (${r.email})` : ""}: {r.message}
                {r.warning && (
                  <>
                    <br />
                    <span>Atenção: {r.warning}</span>
                  </>
                )}
                {r.status !== "ok" && (
                  <>
                    <br />
                    <span className="muted">Como corrigir: {FAILURE_FIX[r.status] ?? FAILURE_FIX.error}</span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------ peças

export function Row({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`ab-field ${wide ? "wide" : ""}`}>
      <span className="ab-label">{label}</span>
      {children}
      {hint && <small className="ab-hint">{hint}</small>}
    </div>
  );
}

export function Check({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useId();
  return (
    <div className="ab-check">
      <Checkbox id={id} checked={checked} onCheckedChange={(c) => onChange(c === true)} />
      <label htmlFor={id}>
        <span>{label}</span>
        {hint && <small className="ab-hint">{hint}</small>}
      </label>
    </div>
  );
}

export function Choice<T extends string | number>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <Select value={String(value)} aria-label={label} onValueChange={(v) => onChange((typeof value === "number" ? Number(v) : v) as T)}>
      {options.map(([v, l]) => (
        <SelectOption key={String(v)} value={String(v)}>
          {l}
        </SelectOption>
      ))}
    </Select>
  );
}

/** Quem entra (com peso e horário de trabalho do MakeCRM). */
export function RotationPicker({
  users,
  value,
  onChange,
  onlyGoogle = false,
}: {
  users: CrmUser[] | null;
  value: RotationUser[];
  onChange: (v: RotationUser[]) => void;
  onlyGoogle?: boolean;
}) {
  if (!users) return <Loading variant="inline" />;
  const picked = new Map(value.map((u) => [u.user_id, u]));
  return (
    <div className="ab-rotation">
      {users.map((u) => {
        const p = picked.get(u.id);
        const blocked = onlyGoogle && !u.google;
        return (
          <div key={u.id} className={`ab-rotation-row ${blocked ? "off" : ""}`}>
            <Check
              checked={!!p}
              onChange={(v) => {
                if (blocked) return;
                onChange(v ? [...value, { user_id: u.id, weight: 1, work_hours: false }] : value.filter((x) => x.user_id !== u.id));
              }}
              label={u.name}
              hint={blocked ? "Sem Google Agenda conectado no MakeCRM (Configurações › Google Agenda)" : onlyGoogle ? u.google ?? undefined : u.email ?? undefined}
            />
            {p && (
              <span className="ab-rotation-opts">
                <Select
                  value={String(p.weight)}
                  aria-label={`Peso de ${u.name}`}
                  onValueChange={(v) => onChange(value.map((x) => (x.user_id === u.id ? { ...x, weight: Number(v) } : x)))}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <SelectOption key={n} value={String(n)}>
                      {n === 1 ? "Peso 1" : `Peso ${n} (recebe ${n}× mais)`}
                    </SelectOption>
                  ))}
                </Select>
                <Check
                  checked={p.work_hours}
                  onChange={(v) => onChange(value.map((x) => (x.user_id === u.id ? { ...x, work_hours: v } : x)))}
                  label="Só no horário de trabalho"
                />
              </span>
            )}
          </div>
        );
      })}
      {!users.length && <p className="ab-hint">Nenhum usuário ativo no MakeCRM deste cliente.</p>}
    </div>
  );
}

// ------------------------------------------------------------ Google Agenda
function CalendarForm({ cfg, users, onChange }: { cfg: Integration; users: CrmUser[] | null; onChange: (v: Integration) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...cfg, [k]: v });
  const hosts: RotationUser[] = cfg.hosts ?? [];
  return (
    <div className="ab-grid">
      <Row label="Quem recebe as reuniões" hint="Só aparecem marcáveis os usuários com a agenda Google conectada no MakeCRM." wide>
        <RotationPicker users={users} value={hosts} onlyGoogle onChange={(v) => set("hosts", v)} />
      </Row>
      {hosts.length > 1 && (
        <Row label="Como escolher" hint={cfg.distribution === "round_robin" ? "Reveza pelos pesos; se o da vez não tiver horário, tenta o próximo." : "Sempre o primeiro marcado."}>
          <Choice
            label="Como escolher"
            value={cfg.distribution ?? "fixed"}
            onChange={(v) => set("distribution", v)}
            options={[
              ["fixed", "Sempre o primeiro"],
              ["round_robin", "Rodízio entre os marcados"],
            ]}
          />
        </Row>
      )}
      <Row label="Duração da reunião">
        <Choice
          label="Duração"
          value={cfg.duration_minutes ?? 30}
          onChange={(v) => set("duration_minutes", v)}
          options={[15, 20, 30, 45, 60, 90, 120].map((n) => [n, n < 60 ? `${n} minutos` : n === 60 ? "1 hora" : n === 90 ? "1h30" : "2 horas"])}
        />
      </Row>
      <Row label="Horários oferecidos a cada">
        <Choice
          label="Intervalo"
          value={cfg.slot_step_minutes ?? 30}
          onChange={(v) => set("slot_step_minutes", v)}
          options={[
            [15, "15 minutos"],
            [30, "30 minutos"],
            [60, "1 hora"],
          ]}
        />
      </Row>
      <Row label="Antecedência mínima" hint="O agente não marca em cima da hora.">
        <Choice
          label="Antecedência"
          value={cfg.min_notice_minutes ?? 60}
          onChange={(v) => set("min_notice_minutes", v)}
          options={[
            [0, "Nenhuma"],
            [30, "30 minutos"],
            [60, "1 hora"],
            [120, "2 horas"],
            [240, "4 horas"],
            [1440, "1 dia"],
            [2880, "2 dias"],
          ]}
        />
      </Row>
      <Row label="Marca até">
        <Choice
          label="Dias à frente"
          value={cfg.days_ahead ?? 14}
          onChange={(v) => set("days_ahead", v)}
          options={[3, 7, 14, 30, 60].map((n) => [n, `${n} dias à frente`])}
        />
      </Row>
      <Row label="Dias e horários em que o agente pode marcar" hint="Além disso, ele respeita o que já está ocupado na agenda." wide>
        <WeeklyHoursEditor value={cfg.allowed_hours} onChange={(v) => set("allowed_hours", v ?? {})} />
      </Row>
      <Row label="Título do evento" hint="{lead} vira o nome do contato.">
        <Input value={cfg.title ?? ""} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder="Reunião com {lead}" />
      </Row>
      <Check checked={cfg.invite_lead !== false} onChange={(v) => set("invite_lead", v)} label="Convidar o lead por e-mail" hint="O agente pede o e-mail antes de marcar." />
      <Row
        label="Outras pessoas no convite"
        hint="Quando o lead pede para incluir o sócio ou um colega, o agente pede o e-mail e convida (também depois de marcar). Ele só tira do convite quem o lead incluiu."
      >
        <Choice
          label="Convidados extras"
          value={cfg.max_guests ?? 3}
          onChange={(v) => set("max_guests", v)}
          options={[
            [0, "Não permitir"],
            ...[1, 2, 3, 5, 10].map((n) => [n, `Até ${n} além do lead`] as [number, string]),
          ]}
        />
      </Row>
      {(cfg.max_guests ?? 3) > 0 && (
        <Check
          checked={cfg.guests_see_others !== false}
          onChange={(v) => set("guests_see_others", v)}
          label="Convidados veem os e-mails uns dos outros"
          hint="Desligado: cada um vê só a reunião, sem a lista de quem mais foi convidado."
        />
      )}
      <Check checked={cfg.meet_link !== false} onChange={(v) => set("meet_link", v)} label="Criar link do Google Meet" />
      <Check checked={cfg.add_summary !== false} onChange={(v) => set("add_summary", v)} label="Pôr o resumo da conversa na descrição" hint="Quem conduz a reunião chega sabendo o contexto." />
    </div>
  );
}

// ------------------------------------------------------------ mover oportunidade
function MoveDealForm({ cfg, pipelines, onChange }: { cfg: Integration; pipelines: Pipeline[] | null; onChange: (v: Integration) => void }) {
  const rules: { id: string; when: string; pipeline_id: string; stage_id: string }[] = cfg.rules ?? [];
  const setRules = (r: typeof rules) => onChange({ ...cfg, rules: r });
  return (
    <div className="ab-stack">
      {rules.map((r, i) => {
        const p = pipelines?.find((x) => x.id === r.pipeline_id);
        return (
          <div key={r.id} className="ab-rule">
            <Row label={`Regra ${i + 1}: quando`} hint='Descreva o momento, como uma pessoa entenderia. Ex.: "quando o lead disser o orçamento e o prazo".' wide>
              <Textarea value={r.when} rows={2} maxLength={600} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, when: e.target.value } : x)))} />
            </Row>
            <div className="ab-grid">
              <Row label="Funil">
                <Select
                  value={r.pipeline_id}
                  aria-label="Funil"
                  onValueChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, pipeline_id: v, stage_id: "" } : x)))}
                >
                  <SelectOption value="">Escolha o funil</SelectOption>
                  {(pipelines ?? []).map((x) => (
                    <SelectOption key={x.id} value={x.id}>
                      {x.name}
                    </SelectOption>
                  ))}
                </Select>
              </Row>
              <Row label="Mover para a etapa">
                <Select value={r.stage_id} aria-label="Etapa" disabled={!p} onValueChange={(v) => setRules(rules.map((x, j) => (j === i ? { ...x, stage_id: v } : x)))}>
                  <SelectOption value="">{p ? "Escolha a etapa" : "Escolha o funil primeiro"}</SelectOption>
                  {(p?.stages ?? []).map((s) => (
                    <SelectOption key={s.id} value={s.id}>
                      {s.name}
                    </SelectOption>
                  ))}
                </Select>
              </Row>
            </div>
            <button type="button" className="agent-link-btn danger ab-rule-remove" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
              <X size={14} aria-hidden="true" /> Tirar regra
            </button>
          </div>
        );
      })}
      <div className="ab-toolbar">
        <Button type="button" className="btn secondary compact" onClick={() => setRules([...rules, { id: newRuleId(rules), when: "", pipeline_id: pipelines?.[0]?.id ?? "", stage_id: "" }])}>
          <Plus size={14} aria-hidden="true" /> Nova regra
        </Button>
      </div>
      <Check
        checked={cfg.run_automations !== false}
        onChange={(v) => onChange({ ...cfg, run_automations: v })}
        label="Disparar as automações do MakeCRM ao mover"
        hint="As mesmas de quando alguém move pela tela do MakeCRM (ex.: mensagens, conversões)."
      />
      <RepeatPicker value={cfg.repeat} onChange={(v) => onChange({ ...cfg, repeat: v })} label="Repetir a mesma regra na conversa" />
      <p className="ab-hint">Sem oportunidade aberta para o lead, nada acontece.</p>
    </div>
  );
}

// ------------------------------------------------------------ trocar responsável
const ROLES: [string, string][] = [
  ["owner", "Proprietário"],
  ["sdr", "SDR"],
  ["closer", "Closer"],
];

function RoleEditor({ value, users, onChange, label }: { value: RoleTarget | undefined; users: CrmUser[] | null; onChange: (v: RoleTarget | undefined) => void; label: string }) {
  const mode = value?.mode ?? "";
  return (
    <div className="ab-role">
      <Row label={label}>
        <Select
          value={mode}
          aria-label={label}
          onValueChange={(v) => onChange(v ? { mode: v as RoleTarget["mode"], users: value?.users ?? [], user_id: value?.user_id } : undefined)}
        >
          <SelectOption value="">Não mudar</SelectOption>
          <SelectOption value="fixed">Uma pessoa fixa</SelectOption>
          <SelectOption value="round_robin">Rodízio entre pessoas</SelectOption>
        </Select>
      </Row>
      {value?.mode === "fixed" && (
        <Row label="Quem">
          <Select value={value.user_id ?? ""} aria-label={`${label}: quem`} onValueChange={(v) => onChange({ ...value, user_id: v || undefined })}>
            <SelectOption value="">Escolha</SelectOption>
            {(users ?? []).map((u) => (
              <SelectOption key={u.id} value={u.id}>
                {u.name}
              </SelectOption>
            ))}
          </Select>
        </Row>
      )}
      {value?.mode === "round_robin" && (
        <Row label="Quem entra no rodízio" hint="Quem marcou &quot;não receber novas oportunidades&quot; no MakeCRM fica de fora." wide>
          <RotationPicker users={users} value={value.users ?? []} onChange={(v) => onChange({ ...value, users: v })} />
        </Row>
      )}
    </div>
  );
}

function ChangeOwnerForm({ cfg, users, onChange }: { cfg: Integration; users: CrmUser[] | null; onChange: (v: Integration) => void }) {
  const rules: (Record<string, any> & { id: string; when: string })[] = cfg.rules ?? [];
  const setRules = (r: typeof rules) => onChange({ ...cfg, rules: r });
  const patch = (i: number, p: Record<string, unknown>) => setRules(rules.map((x, j) => (j === i ? { ...x, ...p } : x)));
  return (
    <div className="ab-stack">
      {rules.map((r, i) => (
        <div key={r.id} className="ab-rule">
          <Row label={`Regra ${i + 1}: quando`} hint='Ex.: "quando o lead pedir uma proposta" ou "quando for empresa com mais de 50 funcionários".' wide>
            <Textarea value={r.when} rows={2} maxLength={600} onChange={(e) => patch(i, { when: e.target.value })} />
          </Row>
          <div className="ab-grid">
            {ROLES.map(([key, label]) => (
              <RoleEditor key={key} label={label} users={users} value={r[key]} onChange={(v) => patch(i, { [key]: v })} />
            ))}
          </div>
          <Check checked={r.sync_conversation !== false} onChange={(v) => patch(i, { sync_conversation: v })} label="Levar o mesmo responsável para a conversa no MakeCRM" />
          <Check checked={!!r.turn_off_ai} onChange={(v) => patch(i, { turn_off_ai: v })} label="Desligar a IA nesta conversa depois de trocar" hint="A pessoa escolhida assume o atendimento." />
          <button type="button" className="agent-link-btn danger ab-rule-remove" onClick={() => setRules(rules.filter((_, j) => j !== i))}>
            <X size={14} aria-hidden="true" /> Tirar regra
          </button>
        </div>
      ))}
      <div className="ab-toolbar">
        <Button type="button" className="btn secondary compact" onClick={() => setRules([...rules, { id: newRuleId(rules), when: "", sync_conversation: true, turn_off_ai: false }])}>
          <Plus size={14} aria-hidden="true" /> Nova regra
        </Button>
      </div>
      <RepeatPicker value={cfg.repeat} onChange={(v) => onChange({ ...cfg, repeat: v })} label="Repetir a mesma regra na conversa" />
      <p className="ab-hint">Sem oportunidade aberta para o lead, nada acontece.</p>
    </div>
  );
}

// ------------------------------------------------------------ avisar a equipe
function NotifyForm({ cfg, inboxes, onChange }: { cfg: Integration; inboxes: MakecrmInbox[] | null; onChange: (v: Integration) => void }) {
  const [phone, setPhone] = useState("");
  const phones: string[] = cfg.phones ?? [];
  const add = () => {
    const digits = phone.replace(/\D/g, "");
    const full = digits.length === 10 || digits.length === 11 ? `55${digits}` : digits;
    if (/^\d{12,15}$/.test(full) && !phones.includes(full)) onChange({ ...cfg, phones: [...phones, full].slice(0, 10) });
    setPhone("");
  };
  const qr = (inboxes ?? []).filter((i) => i.kind === "whatsapp_uazapi");
  return (
    <div className="ab-grid">
      <Row label="Quando avisar" hint='Ex.: "quando o lead pedir para falar com o dono" ou "quando o orçamento for acima de R$ 10 mil".' wide>
        <Textarea value={cfg.when ?? ""} rows={2} maxLength={1000} onChange={(e) => onChange({ ...cfg, when: e.target.value })} />
      </Row>
      <Row label="Enviar pela caixa" hint="Uma caixa de WhatsApp por QR Code (a Business API só envia modelos aprovados).">
        <Select value={cfg.inbox_id ?? ""} aria-label="Caixa que envia" onValueChange={(v) => onChange({ ...cfg, inbox_id: v })}>
          <SelectOption value="">Escolha a caixa</SelectOption>
          {qr.map((i) => (
            <SelectOption key={i.id} value={i.id}>
              {`${i.name}${i.status ? "" : " (desconectada)"}`}
            </SelectOption>
          ))}
        </Select>
      </Row>
      <Row label="Para quem (WhatsApp)" hint="Com DDD; o 55 do Brasil entra sozinho." wide>
        <div className="ab-suggest">
          {phones.map((p) => (
            <span key={p} className="ab-chip on">
              {p}
              <button type="button" aria-label={`Tirar ${p}`} onClick={() => onChange({ ...cfg, phones: phones.filter((x) => x !== p) })}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
        <Input
          type="tel"
          value={phone}
          placeholder="(11) 99999-9999 — Enter para incluir"
          onChange={(e) => setPhone(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={() => phone && add()}
        />
      </Row>
      <Row label=" " wide>
        <RepeatPicker
          value={cfg.repeat}
          onChange={(v) => onChange({ ...cfg, repeat: v })}
          label="Avisar de novo sobre o mesmo lead"
          hint={
            (cfg.repeat?.mode ?? "window") === "always"
              ? "Toda vez que o agente decidir, mesmo seguidas e com o mesmo assunto."
              : "Qualquer aviso sobre este lead conta, mesmo com outras palavras."
          }
        />
      </Row>
    </div>
  );
}

// ------------------------------------------------------------ repetição
export type Repeat = { mode: "always" | "window" | "conversation"; minutes: number };
export const REPEAT_DEFAULT: Repeat = { mode: "window", minutes: 60 };
const WINDOWS: [number, string][] = [
  [15, "15 minutos"],
  [30, "30 minutos"],
  [60, "1 hora"],
  [180, "3 horas"],
  [360, "6 horas"],
  [720, "12 horas"],
  [1440, "24 horas"],
  [4320, "3 dias"],
  [10080, "7 dias"],
];

/** Quantas vezes a mesma ação pode acontecer na mesma conversa. */
export function RepeatPicker({ value, onChange, label = "Repetir na mesma conversa", hint }: { value: Repeat | undefined; onChange: (v: Repeat) => void; label?: string; hint?: string }) {
  const v = { ...REPEAT_DEFAULT, ...value };
  const windows: [number, string][] = WINDOWS.some(([m]) => m === v.minutes) ? WINDOWS : [...WINDOWS, [v.minutes, `${v.minutes} minutos`]];
  return (
    <div className="ab-grid">
      <Row
        label={label}
        hint={
          hint ??
          (v.mode === "always"
            ? "Toda vez que o agente decidir, mesmo seguidas."
            : v.mode === "conversation"
              ? "Uma vez só com este lead (volta a valer se zerar a memória dele)."
              : "Depois de fazer, segura pelo intervalo, mesmo que o agente decida de novo.")
        }
      >
        <Choice
          label={label}
          value={v.mode}
          onChange={(mode) => onChange({ ...v, mode })}
          options={[
            ["window", "No máximo 1 vez a cada…"],
            ["conversation", "Só 1 vez por conversa"],
            ["always", "Sempre que acontecer"],
          ]}
        />
      </Row>
      {v.mode === "window" && (
        <Row label="Intervalo">
          <Choice label="Intervalo" value={v.minutes} onChange={(minutes) => onChange({ ...v, minutes })} options={windows} />
        </Row>
      )}
    </div>
  );
}

// ------------------------------------------------------------ ações na oportunidade
const ASSIGNEE_ROLES: [ActivityAssignee["role"], string][] = [
  ["owner", "Proprietário"],
  ["sdr", "SDR"],
  ["closer", "Closer"],
];

/** Quem fica com a atividade: papel da oportunidade (com quem assume), pessoa fixa ou rodízio. */
export function AssigneeEditor({ value, users, onChange }: { value: ActivityAssignee | undefined; users: CrmUser[] | null; onChange: (v: ActivityAssignee) => void }) {
  const v = { ...DEFAULT_ASSIGNEE, ...value };
  const people = (users ?? []).map((u) => [u.id, u.name] as [string, string]);
  return (
    <div className="ab-grid">
      <Row label="Responsável pela atividade">
        <Choice
          label="Responsável pela atividade"
          value={v.mode}
          onChange={(mode) => onChange({ ...v, mode })}
          options={[
            ["deal_role", "Quem está na oportunidade"],
            ["fixed", "Uma pessoa fixa"],
            ["round_robin", "Rodízio entre pessoas"],
          ]}
        />
      </Row>
      {v.mode === "deal_role" && (
        <>
          <Row label="Papel">
            <Choice label="Papel" value={v.role} onChange={(role) => onChange({ ...v, role })} options={ASSIGNEE_ROLES} />
          </Row>
          <Row label="Se o papel estiver vazio" hint="Sem ninguém escolhido aqui, fica com o proprietário da oportunidade.">
            <Select value={v.user_id ?? ""} aria-label="Se o papel estiver vazio" onValueChange={(id) => onChange({ ...v, user_id: id || null })}>
              <SelectOption value="">O proprietário</SelectOption>
              {people.map(([id, name]) => (
                <SelectOption key={id} value={id}>
                  {name}
                </SelectOption>
              ))}
            </Select>
          </Row>
        </>
      )}
      {v.mode === "fixed" && (
        <Row label="Quem">
          <Select value={v.user_id ?? ""} aria-label="Quem fica com a atividade" onValueChange={(id) => onChange({ ...v, user_id: id || null })}>
            <SelectOption value="">Escolha</SelectOption>
            {people.map(([id, name]) => (
              <SelectOption key={id} value={id}>
                {name}
              </SelectOption>
            ))}
          </Select>
        </Row>
      )}
      {v.mode === "round_robin" && (
        <Row label="Quem entra no rodízio" wide>
          <RotationPicker users={users} value={v.users} onChange={(list) => onChange({ ...v, users: list })} />
        </Row>
      )}
    </div>
  );
}

type Named = { id: string; name: string };

/** Lista de escolha (motivos, tipos) guardando o nome junto, para o agente ler. */
function NamedPicker({ options, value, onChange, empty }: { options: Named[] | null; value: Named[]; onChange: (v: Named[]) => void; empty: string }) {
  if (!options) return <Loading variant="inline" />;
  const picked = new Set(value.map((x) => x.id));
  const gone = value.filter((x) => !options.some((o) => o.id === x.id));
  return (
    <div className="ab-suggest">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={`ab-chip ${picked.has(o.id) ? "on" : ""}`}
          aria-pressed={picked.has(o.id)}
          onClick={() => onChange(picked.has(o.id) ? value.filter((x) => x.id !== o.id) : [...value, { id: o.id, name: o.name }])}
        >
          {o.name}
        </button>
      ))}
      {gone.map((o) => (
        <span key={o.id} className="ab-chip warn" title="Não existe mais no MakeCRM">
          {o.name || o.id} (removido)
          <button type="button" aria-label={`Tirar ${o.name}`} onClick={() => onChange(value.filter((x) => x.id !== o.id))}>
            <X size={12} />
          </button>
        </span>
      ))}
      {!options.length && <p className="ab-hint">{empty}</p>}
    </div>
  );
}

const fmtMoney = (v: number, code: string) => {
  try {
    return new Intl.NumberFormat("pt-BR", { style: "currency", currency: code || "BRL" }).format(v);
  } catch {
    return `${code} ${v}`;
  }
};

function DealActionsForm({ cfg, catalog, users, onChange }: { cfg: Integration; catalog: DealCatalog | null; users: CrmUser[] | null; onChange: (v: Integration) => void }) {
  const part = (k: string) => (cfg[k] ?? {}) as Record<string, any>;
  const setPart = (k: string, patch: Record<string, unknown>) => onChange({ ...cfg, [k]: { ...part(k), ...patch } });
  // Função (não componente): um componente criado aqui remontaria o campo a cada letra.
  const when = (k: string, example: string) => (
    <Row label="Quando (opcional)" hint={`Ex.: "${example}". Sem nada, o agente decide pela conversa.`} wide>
      <Textarea value={part(k).when ?? ""} rows={2} maxLength={1000} onChange={(e) => setPart(k, { when: e.target.value })} />
    </Row>
  );
  const products: { product_id: string; name: string; max_discount_pct: number }[] = part("quote").products ?? [];
  return (
    <div className="ab-stack">
      <div className="ab-rule">
        <Check checked={!!part("lost").enabled} onChange={(v) => setPart("lost", { enabled: v })} label="Dar como perdida" hint="Registra a perda com o motivo, como na tela do MakeCRM, e dispara as automações de perda." />
        {part("lost").enabled && (
          <>
            {when("lost", "quando o lead disser que já fechou com outra empresa")}
            <Row label="Motivos que o agente pode usar" wide>
              <NamedPicker options={catalog?.lost_reasons ?? null} value={part("lost").reasons ?? []} onChange={(v) => setPart("lost", { reasons: v })} empty="Nenhum motivo de perda ativo no MakeCRM deste cliente." />
            </Row>
            <Check checked={part("lost").cancel_meetings !== false} onChange={(v) => setPart("lost", { cancel_meetings: v })} label="Cancelar as reuniões futuras" />
            <Check checked={part("lost").complete_activities !== false} onChange={(v) => setPart("lost", { complete_activities: v })} label="Concluir as atividades em aberto" />
            <RepeatPicker value={part("lost").repeat} onChange={(v) => setPart("lost", { repeat: v })} />
          </>
        )}
      </div>
      <div className="ab-rule">
        <Check checked={!!part("quote").enabled} onChange={(v) => setPart("quote", { enabled: v })} label="Registrar orçamento" hint="Só produtos do catálogo, pelo preço cadastrado; desconto até o limite de cada um." />
        {part("quote").enabled && (
          <>
            {when("quote", "quando o lead escolher o plano e pedir o valor final")}
            <Row label="Produtos e desconto máximo" wide>
              {!catalog ? (
                <Loading variant="inline" />
              ) : (
                <div className="ab-rotation">
                  {catalog.products.map((p) => {
                    const it = products.find((x) => x.product_id === p.id);
                    return (
                      <div key={p.id} className="ab-rotation-row">
                        <Check
                          checked={!!it}
                          onChange={(v) =>
                            setPart("quote", { products: v ? [...products, { product_id: p.id, name: p.name, max_discount_pct: 0 }] : products.filter((x) => x.product_id !== p.id) })
                          }
                          label={p.name}
                          hint={fmtMoney(p.price, p.currency)}
                        />
                        {it && (
                          <span className="ab-rotation-opts">
                            <Input
                              type="number"
                              min={0}
                              max={100}
                              step={1}
                              aria-label={`Desconto máximo de ${p.name} (%)`}
                              value={String(it.max_discount_pct)}
                              onChange={(e) => {
                                const n = Math.min(100, Math.max(0, Number(e.target.value) || 0));
                                setPart("quote", { products: products.map((x) => (x.product_id === p.id ? { ...x, max_discount_pct: n } : x)) });
                              }}
                            />
                            <small className="ab-hint">
                              % de desconto máximo{it.max_discount_pct > 0 ? ` (mínimo ${fmtMoney(p.price * (1 - it.max_discount_pct / 100), p.currency)})` : ""}
                            </small>
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {products
                    .filter((x) => !catalog.products.some((p) => p.id === x.product_id))
                    .map((x) => (
                      <div key={x.product_id} className="ab-rotation-row off">
                        <span>{x.name || x.product_id} (inativo ou removido do catálogo)</span>
                        <button type="button" className="agent-link-btn danger" onClick={() => setPart("quote", { products: products.filter((y) => y.product_id !== x.product_id) })}>
                          <X size={14} aria-hidden="true" /> Tirar
                        </button>
                      </div>
                    ))}
                  {!catalog.products.length && <p className="ab-hint">Nenhum produto ativo no catálogo do MakeCRM deste cliente.</p>}
                </div>
              )}
            </Row>
            <RepeatPicker value={part("quote").repeat} onChange={(v) => setPart("quote", { repeat: v })} label="Repetir o orçamento do mesmo produto" />
          </>
        )}
      </div>
      <div className="ab-rule">
        <Check
          checked={!!part("won").enabled}
          onChange={(v) => setPart("won", { enabled: v })}
          label="Dar como ganha"
          hint="Pelos orçamentos da oportunidade (sem orçamento, não dá). Dispara as automações de ganho do MakeCRM."
        />
        {part("won").enabled && when("won", "quando o lead enviar o comprovante de pagamento")}
        {part("won").enabled && <RepeatPicker value={part("won").repeat} onChange={(v) => setPart("won", { repeat: v })} />}
        {part("won").enabled && !part("quote").enabled && <p className="ab-notice warn">Sem "Registrar orçamento", só dá como ganha quando a equipe já tiver registrado o orçamento.</p>}
      </div>
      <div className="ab-rule">
        <Check checked={!!part("note").enabled} onChange={(v) => setPart("note", { enabled: v })} label="Anotar no histórico" hint="Observações úteis para a equipe no histórico da oportunidade." />
        {part("note").enabled && when("note", "quando o lead contar o tamanho da empresa ou o prazo de decisão")}
        {part("note").enabled && (
          <RepeatPicker
            value={part("note").repeat}
            onChange={(v) => setPart("note", { repeat: v })}
            label="Anotar de novo na mesma conversa"
            hint={(part("note").repeat?.mode ?? "window") === "always" ? "Toda observação que o agente achar útil." : "Qualquer observação conta, mesmo com outras palavras."}
          />
        )}
      </div>
      <div className="ab-rule">
        <Check checked={!!part("activity").enabled} onChange={(v) => setPart("activity", { enabled: v })} label="Criar atividade" hint="Uma tarefa para a equipe na oportunidade (ligar, mandar e-mail…), com prazo." />
        {part("activity").enabled && (
          <>
            {when("activity", "quando o lead pedir para ser ligado em outro horário")}
            <Row label="Tipos que o agente pode criar" wide>
              <NamedPicker options={catalog?.activity_types ?? null} value={part("activity").types ?? []} onChange={(v) => setPart("activity", { types: v })} empty="Nenhum tipo de atividade ativo no MakeCRM." />
            </Row>
            <AssigneeEditor value={part("activity").assignee} users={users} onChange={(v) => setPart("activity", { assignee: v })} />
            <RepeatPicker value={part("activity").repeat} onChange={(v) => setPart("activity", { repeat: v })} label="Repetir atividade do mesmo tipo" />
            <Row label="Prazo quando o lead não combinar um momento">
              <Choice
                label="Prazo padrão"
                value={part("activity").default_due_hours ?? 24}
                onChange={(v) => setPart("activity", { default_due_hours: v })}
                options={[
                  [0, "Agora"],
                  [1, "Em 1 hora"],
                  [4, "Em 4 horas"],
                  [24, "Em 1 dia"],
                  [48, "Em 2 dias"],
                  [72, "Em 3 dias"],
                  [168, "Em 1 semana"],
                ]}
              />
            </Row>
          </>
        )}
      </div>
      <p className="ab-hint">Valem para a oportunidade aberta do lead; sem oportunidade, nada acontece. Tudo fica no histórico com "(pela MAVI)".</p>
    </div>
  );
}
