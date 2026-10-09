import { useEffect, useState } from "react";
import { Plus, Signpost, X } from "lucide-react";
import { Button, Input, Loading, Select, SelectOption, Textarea } from "./ui";
import {
  agentOp,
  errorOf,
  when,
  type AgentDraft,
  type DealCatalog,
  type ScenarioRuns,
} from "./agent-builder";
import {
  AssigneeEditor,
  Check,
  Choice,
  DEFAULT_ASSIGNEE,
  Row,
  type ActivityAssignee,
  type CrmUser,
  type Pipeline,
} from "./AgentIntegrations";

/**
 * Agentes MAVI › Cenários: situações fora do roteiro com uma ação combinada
 * ("quando o lead pedir X, faça Y"). Ex.: o lead pede para nunca mais ser
 * chamado → a MAVI se despede, sai da conversa e registra o motivo no MakeCRM.
 * O agente reconhece pela descrição; o motor faz as ações. Fica no rascunho
 * (Salvar rascunho / Publicar).
 */

type Activity = {
  type_id: string;
  subject: string;
  due_hours: number;
  assignee: ActivityAssignee;
};
type Scenario = {
  id: string;
  name: string;
  enabled?: boolean;
  when: string;
  reply: "agent" | "fixed" | "none";
  message: string;
  actions: {
    turn_off_ai: boolean;
    stop_followup: boolean;
    cancel_meetings: boolean;
    lost_reason_id: string | null;
    complete_activities: boolean;
    stage: { pipeline_id: string; stage_id: string } | null;
    activity: Activity | null;
    notify_team: boolean;
  };
};

const ACTIONS: Scenario["actions"] = {
  turn_off_ai: false,
  stop_followup: true,
  cancel_meetings: false,
  lost_reason_id: null,
  complete_activities: true,
  stage: null,
  activity: null,
  notify_team: false,
};

/** Modelos prontos (o motivo de perda é escolhido pelo nome, se existir no MakeCRM). */
const TEMPLATES: {
  name: string;
  when: string;
  reply: Scenario["reply"];
  message: string;
  reason: RegExp;
  actions: Partial<Scenario["actions"]>;
}[] = [
  {
    name: "Não quer mais contato",
    when: "O lead pede para não receber mais mensagens, para parar de ser chamado ou para ser removido da lista.",
    reply: "fixed",
    message:
      "Tudo bem, entendido! Não vamos mais te enviar mensagens. Se precisar de algo, é só chamar por aqui.",
    reason: /sem interesse|n[aã]o quer|desist/i,
    actions: { turn_off_ai: true, cancel_meetings: true },
  },
  {
    name: "Fechou com outra empresa",
    when: "O lead diz que já contratou ou comprou de outra empresa.",
    reply: "agent",
    message: "",
    reason: /concorr/i,
    actions: { turn_off_ai: false, cancel_meetings: true },
  },
  {
    name: "Número errado",
    when: "A pessoa diz que não é quem procuramos, que nunca pediu contato ou que o número é de outra pessoa.",
    reply: "fixed",
    message: "Desculpe o incômodo! Vamos atualizar nosso cadastro.",
    reason: /telefone errado|n[uú]mero errado|errado/i,
    actions: { turn_off_ai: true },
  },
];

const newId = (list: { id: string }[]) => {
  let n = list.length + 1;
  while (list.some((s) => s.id === `cenario_${n}`)) n++;
  return `cenario_${n}`;
};

export function ScenariosPanel({
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
  const list: Scenario[] = Array.isArray(draft.scenarios)
    ? draft.scenarios
    : [];
  const hasNotify =
    Array.isArray(draft.integrations) &&
    draft.integrations.some(
      (i: { type?: string; enabled?: boolean }) =>
        i?.type === "team_notify" && i.enabled !== false,
    );
  const [catalog, setCatalog] = useState<DealCatalog | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[] | null>(null);
  const [users, setUsers] = useState<CrmUser[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canEdit) return;
    Promise.all([
      agentOp<DealCatalog>(company, agentId, "crm-deal-catalog"),
      agentOp<{ pipelines: Pipeline[] }>(company, agentId, "crm-pipelines"),
      agentOp<{ users: CrmUser[] }>(company, agentId, "crm-users"),
    ])
      .then(([c, p, u]) => {
        setCatalog(c);
        setPipelines(p.pipelines);
        setUsers(u.users);
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, canEdit]);

  const set = (next: Scenario[]) =>
    change("scenarios", next.length ? next : undefined);
  const update = (i: number, s: Scenario) =>
    set(list.map((x, j) => (j === i ? s : x)));
  const add = (t?: (typeof TEMPLATES)[number]) => {
    const reason = t
      ? (catalog?.lost_reasons.find((r) => t.reason.test(r.name))?.id ?? null)
      : null;
    set([
      ...list,
      {
        id: newId(list),
        name: t?.name ?? "",
        enabled: true,
        when: t?.when ?? "",
        reply: t?.reply ?? "agent",
        message: t?.message ?? "",
        actions: { ...ACTIONS, ...t?.actions, lost_reason_id: reason },
      },
    ]);
  };

  return (
    <div className="ab-stack">
      <p className="ab-hint ab-section-intro">
        Situações fora do roteiro com uma ação combinada:{" "}
        <strong>quando o lead pedir X, o agente faz Y</strong>. O agente
        reconhece pela descrição; as ações acontecem direto no MakeCRM e o
        motivo fica no histórico da oportunidade e numa nota privada da
        conversa. Na aba Testar nada é gravado.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {list.map((s, i) => (
        <ScenarioEditor
          key={s.id}
          s={s}
          n={i + 1}
          canEdit={canEdit}
          catalog={catalog}
          pipelines={pipelines}
          users={users}
          hasNotify={hasNotify}
          error={errorFor(`scenarios.${i}`)}
          onChange={(v) => update(i, v)}
          onRemove={() =>
            window.confirm(
              `Tirar o cenário "${s.name || `Cenário ${i + 1}`}"?`,
            ) && set(list.filter((_, j) => j !== i))
          }
        />
      ))}
      {canEdit && (
        <section className="ab-section">
          <h3>Novo cenário</h3>
          <div className="ab-toolbar">
            {TEMPLATES.filter((t) => !list.some((s) => s.name === t.name)).map(
              (t) => (
                <Button
                  key={t.name}
                  type="button"
                  className="btn secondary compact"
                  onClick={() => add(t)}
                  disabled={!catalog && !error}
                >
                  <Plus size={14} aria-hidden="true" /> {t.name}
                </Button>
              ),
            )}
            <Button
              type="button"
              className="btn secondary compact"
              onClick={() => add()}
            >
              <Plus size={14} aria-hidden="true" /> Em branco
            </Button>
          </div>
        </section>
      )}
      {errorFor("scenarios") && (
        <p className="ab-notice warn">{errorFor("scenarios")}</p>
      )}
      <RecentRuns company={company} agentId={agentId} />
    </div>
  );
}

function ScenarioEditor({
  s,
  n,
  canEdit,
  catalog,
  pipelines,
  users,
  hasNotify,
  error,
  onChange,
  onRemove,
}: {
  s: Scenario;
  n: number;
  canEdit: boolean;
  catalog: DealCatalog | null;
  pipelines: Pipeline[] | null;
  users: CrmUser[] | null;
  hasNotify: boolean;
  error?: string;
  onChange: (s: Scenario) => void;
  onRemove: () => void;
}) {
  const a = { ...ACTIONS, ...s.actions };
  const act = (patch: Partial<Scenario["actions"]>) =>
    onChange({ ...s, actions: { ...a, ...patch } });
  const pipeline = pipelines?.find((p) => p.id === a.stage?.pipeline_id);
  return (
    <section
      className={`ab-section ab-integration ${s.enabled === false ? "off" : "on"}`}
    >
      <div className="ab-integration-head">
        <Signpost size={20} aria-hidden="true" />
        <div className="ab-integration-title">
          <h3>{s.name || `Cenário ${n}`}</h3>
          <p className="ab-hint">{s.when || "Descreva quando acontece."}</p>
        </div>
        {canEdit && (
          <span className="ab-row-actions">
            <Check
              checked={s.enabled !== false}
              onChange={(v) => onChange({ ...s, enabled: v })}
              label="Ligado"
            />
            <button
              type="button"
              className="agent-link-btn danger"
              aria-label="Tirar cenário"
              onClick={onRemove}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      {error && <p className="ab-notice warn">{error}</p>}
      <fieldset className="ab-panel" disabled={!canEdit}>
        <div className="ab-grid">
          <Row label="Nome">
            <Input
              value={s.name}
              maxLength={80}
              onChange={(e) => onChange({ ...s, name: e.target.value })}
              placeholder="Ex.: Não quer mais contato"
            />
          </Row>
          <Row
            label="Quando o lead…"
            hint="Descreva a situação com as palavras que o lead costuma usar. O agente só aciona quando estiver claro."
            wide
          >
            <Textarea
              value={s.when}
              rows={2}
              maxLength={1000}
              onChange={(e) => onChange({ ...s, when: e.target.value })}
            />
          </Row>
          <Row label="Resposta ao lead">
            <Choice
              label="Resposta ao lead"
              value={s.reply}
              onChange={(reply) => onChange({ ...s, reply })}
              options={[
                ["agent", "O agente responde"],
                ["fixed", "Mensagem combinada"],
                ["none", "Não responder"],
              ]}
            />
          </Row>
          {s.reply === "fixed" && (
            <Row
              label="Mensagem"
              hint="Vai exatamente assim (cada parágrafo vira um balão)."
              wide
            >
              <Textarea
                value={s.message}
                rows={3}
                maxLength={1000}
                onChange={(e) => onChange({ ...s, message: e.target.value })}
              />
            </Row>
          )}
        </div>
        <h4 className="ab-subtitle">O agente faz</h4>
        <div className="ab-stack">
          <Check
            checked={a.turn_off_ai}
            onChange={(v) => act({ turn_off_ai: v })}
            label="Sair desta conversa (desligar a MAVI)"
            hint="Depois de responder. Só nesta conversa; uma pessoa pode religar no MakeCRM."
          />
          <Check
            checked={a.stop_followup || a.turn_off_ai}
            onChange={(v) => act({ stop_followup: v })}
            label="Parar o follow-up"
          />
          <Check
            checked={a.cancel_meetings}
            onChange={(v) => act({ cancel_meetings: v })}
            label="Cancelar as reuniões futuras"
            hint="As marcadas pelo agente e pela equipe nesta oportunidade."
          />
          <div className="ab-grid">
            <Row label="Dar a oportunidade como perdida">
              {catalog ? (
                <Select
                  value={a.lost_reason_id ?? ""}
                  aria-label="Motivo de perda"
                  onValueChange={(v) => act({ lost_reason_id: v || null })}
                >
                  <SelectOption value="">Não</SelectOption>
                  {catalog.lost_reasons.map((r) => (
                    <SelectOption key={r.id} value={r.id}>
                      {`Sim: ${r.name}`}
                    </SelectOption>
                  ))}
                  {a.lost_reason_id &&
                    !catalog.lost_reasons.some(
                      (r) => r.id === a.lost_reason_id,
                    ) && (
                      <SelectOption value={a.lost_reason_id}>
                        Motivo removido do MakeCRM
                      </SelectOption>
                    )}
                </Select>
              ) : (
                <Loading variant="inline" />
              )}
            </Row>
            {a.lost_reason_id && (
              <Row label=" ">
                <Check
                  checked={a.complete_activities}
                  onChange={(v) => act({ complete_activities: v })}
                  label="Concluir as atividades em aberto"
                />
              </Row>
            )}
            <Row label="Mover para a etapa">
              {pipelines ? (
                <Select
                  value={a.stage?.pipeline_id ?? ""}
                  aria-label="Funil"
                  onValueChange={(v) =>
                    act({ stage: v ? { pipeline_id: v, stage_id: "" } : null })
                  }
                >
                  <SelectOption value="">Não mover</SelectOption>
                  {pipelines.map((p) => (
                    <SelectOption key={p.id} value={p.id}>
                      {p.name}
                    </SelectOption>
                  ))}
                </Select>
              ) : (
                <Loading variant="inline" />
              )}
            </Row>
            {a.stage && (
              <Row label="Etapa">
                <Select
                  value={a.stage.stage_id}
                  aria-label="Etapa"
                  onValueChange={(v) =>
                    act({
                      stage: { pipeline_id: a.stage!.pipeline_id, stage_id: v },
                    })
                  }
                >
                  <SelectOption value="">Escolha</SelectOption>
                  {(pipeline?.stages ?? []).map((st) => (
                    <SelectOption key={st.id} value={st.id}>
                      {st.name}
                    </SelectOption>
                  ))}
                </Select>
              </Row>
            )}
          </div>
          <Check
            checked={!!a.activity}
            onChange={(v) =>
              act({
                activity: v
                  ? {
                      type_id: catalog?.activity_types[0]?.id ?? "",
                      subject: s.name ? `Retornar: ${s.name}` : "",
                      due_hours: 24,
                      assignee: DEFAULT_ASSIGNEE,
                    }
                  : null,
              })
            }
            label="Criar uma atividade para a equipe"
          />
          {a.activity && (
            <div className="ab-rule">
              <div className="ab-grid">
                <Row label="Tipo">
                  <Select
                    value={a.activity.type_id}
                    aria-label="Tipo de atividade"
                    onValueChange={(v) =>
                      act({ activity: { ...a.activity!, type_id: v } })
                    }
                  >
                    <SelectOption value="">Escolha</SelectOption>
                    {(catalog?.activity_types ?? []).map((t) => (
                      <SelectOption key={t.id} value={t.id}>
                        {t.name}
                      </SelectOption>
                    ))}
                  </Select>
                </Row>
                <Row label="Assunto">
                  <Input
                    value={a.activity.subject}
                    maxLength={200}
                    onChange={(e) =>
                      act({
                        activity: { ...a.activity!, subject: e.target.value },
                      })
                    }
                  />
                </Row>
                <Row label="Prazo">
                  <Choice
                    label="Prazo"
                    value={a.activity.due_hours}
                    onChange={(v) =>
                      act({ activity: { ...a.activity!, due_hours: v } })
                    }
                    options={[
                      [0, "Agora"],
                      [1, "Em 1 hora"],
                      [4, "Em 4 horas"],
                      [24, "Em 1 dia"],
                      [72, "Em 3 dias"],
                      [168, "Em 1 semana"],
                    ]}
                  />
                </Row>
              </div>
              <AssigneeEditor
                value={a.activity.assignee}
                users={users}
                onChange={(v) =>
                  act({ activity: { ...a.activity!, assignee: v } })
                }
              />
            </div>
          )}
          <Check
            checked={a.notify_team}
            onChange={(v) => act({ notify_team: v })}
            label="Avisar a equipe no WhatsApp"
            hint={
              hasNotify
                ? undefined
                : 'Precisa da integração "Avisar a equipe no WhatsApp" (aba Integrações).'
            }
          />
          <p className="ab-hint">
            O motivo sempre fica no histórico da oportunidade e numa nota
            privada da conversa.
          </p>
        </div>
      </fieldset>
    </section>
  );
}

function RecentRuns({
  company,
  agentId,
}: {
  company: string;
  agentId: string;
}) {
  const [data, setData] = useState<ScenarioRuns | null>(null);
  useEffect(() => {
    agentOp<ScenarioRuns>(company, agentId, "scenario-runs", { days: 30 })
      .then(setData)
      .catch(() => setData(null));
  }, [company, agentId]);
  if (!data || !data.recent.length) return null;
  return (
    <section className="ab-section">
      <h3>Acionados nos últimos {data.days} dias</h3>
      <div className="ab-suggest">
        {data.groups.map((g) => (
          <span key={g.scenario_id} className="ab-chip on">
            {g.scenario_name || g.scenario_id}: {g.n}
          </span>
        ))}
      </div>
      <ul className="ab-list ab-runs">
        {data.recent.map((r) => (
          <li key={r.id}>
            <strong>{r.scenario_name}</strong> ·{" "}
            {r.contact_name || r.phone || "Lead"} · {when(r.created_at)}
            {r.reason && <div className="ab-hint">O lead: {r.reason}</div>}
            {r.actions.length > 0 && (
              <div className="ab-hint">Feito: {r.actions.join("; ")}</div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
