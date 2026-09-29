import { useMemo, useState } from "react";
import { CalendarCheck, CalendarX2, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Select, SelectOption } from "./ui";
import { dateKey } from "./domain";
import {
  businessDaysLabel,
  calendarEntry,
  canManageDueScope,
  nationalHolidays,
  ruleDue,
  ruleScope,
  ruleWeight,
} from "./dueRules";
import { dayLabel } from "./task-bulk";
import type { CalendarDay, Snapshot, TaskDueRule } from "./types";
import { WorkloadPanel } from "./WorkloadPanel";
import "./due-rules.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Settings panel (leaders): the default due dates (task_due_rules) and the
 * company calendar they count on. Admins set up any rule and the calendar;
 * managers only rules of their teams, the clients those teams serve and
 * the people in them.
 */
export function DueRulesPanel({
  data,
  company,
  user,
  mutate,
  notify,
}: {
  data: Snapshot;
  company: string;
  user: string;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const [editing, setEditing] = useState<TaskDueRule | "new" | null>(null);
  const [toggling, setToggling] = useState("");
  const [error, setError] = useState("");
  const isAdmin = data.members.some(
    (m) => m.user_id === user && m.active && m.role === "admin",
  );
  const rules = useMemo(
    () =>
      [...(data.dueRules ?? [])].sort(
        (a, b) =>
          ruleWeight(b) - ruleWeight(a) ||
          ruleScope(data, a).localeCompare(ruleScope(data, b), "pt-BR"),
      ),
    [data],
  );
  const save = (r: RuleDraft & { id?: string }) =>
    mutate("save_task_due_rule", {
      p_company: company,
      p_id: r.id ?? null,
      p_project: r.project_id,
      p_client: r.client_id,
      p_product: r.product_id,
      p_team: r.team_id,
      p_user: r.user_id,
      p_days: r.business_days,
      p_min: r.min_days,
      p_approval_days: r.approval_days,
      p_active: r.active,
    });
  async function toggle(r: TaskDueRule) {
    setToggling(r.id);
    setError("");
    try {
      await save({ ...r, active: !r.active });
      notify(
        r.active
          ? "Regra desativada: novas tarefas não usam mais este prazo."
          : "Regra ativada.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setToggling("");
    }
  }
  return (
    <>
      <section className="panel due-rules" id="config-prazos">
        <div className="panel-heading">
          <div>
            <h2>Prazos padrão</h2>
            <p>
              O prazo que já vem preenchido ao criar uma tarefa, em dias úteis a
              partir do início planejado (ou do dia da criação)
            </p>
          </div>
          <Button className="btn secondary" onClick={() => setEditing("new")}>
            <Plus size={17} /> Nova regra
          </Button>
        </div>
        <p className="due-rules-order">
          Vale a regra mais específica: <strong>Projeto</strong> ›{" "}
          <strong>Cliente</strong> › <strong>Produto</strong> ›{" "}
          <strong>Equipe</strong> › <strong>Pessoa</strong> (quem executa) ›
          padrão da empresa. Critérios podem ser combinados, como “Cliente +
          Produto”.
        </p>
        {rules.length ? (
          rules.map((r) => {
            const canEdit = canManageDueScope(data, user, r);
            return (
              <div className={`template-row${r.active ? "" : " off"}`} key={r.id}>
                <CalendarCheck size={18} aria-hidden="true" />
                <div>
                  <strong>{ruleScope(data, r)}</strong>
                  <small>{ruleSummary(r)}</small>
                </div>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.active}
                      aria-label={`${r.active ? "Desativar" : "Ativar"} a regra ${ruleScope(data, r)}`}
                      className={`template-switch${r.active ? " on" : ""}`}
                      disabled={toggling === r.id}
                      onClick={() => void toggle(r)}
                    >
                      <span aria-hidden="true" />
                      {r.active ? "Ativa" : "Inativa"}
                    </button>
                    <Button
                      className="icon-btn"
                      aria-label={`Editar a regra ${ruleScope(data, r)}`}
                      title="Editar regra"
                      onClick={() => setEditing(r)}
                    >
                      <Pencil size={15} />
                    </Button>
                  </>
                )}
              </div>
            );
          })
        ) : (
          <p className="template-empty">
            Nenhuma regra ainda. Comece pelo padrão da empresa (uma regra sem
            critérios) e acrescente as exceções: um cliente que pede mais
            tempo, um produto mais rápido, uma equipe com fila maior.
          </p>
        )}
        {error && (
          <p className="form-error template-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <SmartDueMode
        mode={data.companies.find((c) => c.id === company)?.smart_due ?? "suggest"}
        canEdit={isAdmin}
        onChange={async (mode) => {
          await mutate("set_company_smart_due", { p_company: company, p_mode: mode });
          notify(
            mode === "off"
              ? "Prazo inteligente desligado."
              : mode === "fill"
                ? "A MAVI passa a preencher o prazo das novas tarefas."
                : "A MAVI passa a sugerir o prazo ao lado da regra.",
          );
        }}
      />
      <CompanyCalendar
        data={data}
        company={company}
        canEdit={isAdmin}
        mutate={mutate}
        notify={notify}
      />
      <WorkloadPanel
        data={data}
        company={company}
        user={user}
        mutate={mutate}
        notify={notify}
      />
      {editing && (
        <RuleEditor
          data={data}
          user={user}
          rule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={async (r) => {
            await save(r);
            notify(r.id ? "Regra de prazo atualizada." : "Regra de prazo criada.");
            setEditing(null);
          }}
          onDelete={async (id) => {
            await mutate("delete_task_due_rule", { p_rule: id });
            notify("Regra excluída. As tarefas já criadas mantêm o prazo que têm.");
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

function ruleSummary(r: Pick<TaskDueRule, "business_days" | "min_days" | "approval_days">) {
  return [
    `Prazo de ${businessDaysLabel(r.business_days)}`,
    r.min_days != null && `mínimo de ${businessDaysLabel(r.min_days)}`,
    r.approval_days > 0 && `+${businessDaysLabel(r.approval_days)} com aprovação do cliente`,
  ]
    .filter(Boolean)
    .join(" · ");
}

type RuleDraft = Pick<
  TaskDueRule,
  | "project_id"
  | "client_id"
  | "product_id"
  | "team_id"
  | "user_id"
  | "business_days"
  | "min_days"
  | "approval_days"
  | "active"
>;

const numberOr = (v: string, fallback: number | null) =>
  v.trim() === "" ? fallback : Math.max(0, Math.round(Number(v)));

function RuleEditor({
  data,
  user,
  rule,
  onClose,
  onSave,
  onDelete,
}: {
  data: Snapshot;
  user: string;
  rule?: TaskDueRule;
  onClose: () => void;
  onSave: (r: RuleDraft & { id?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [project, setProject] = useState(rule?.project_id ?? "");
  const [client, setClient] = useState(rule?.client_id ?? "");
  const [product, setProduct] = useState(rule?.product_id ?? "");
  const [team, setTeam] = useState(rule?.team_id ?? "");
  const [person, setPerson] = useState(rule?.user_id ?? "");
  const [days, setDays] = useState(String(rule?.business_days ?? 3));
  const [min, setMin] = useState(rule?.min_days == null ? "" : String(rule.min_days));
  const [approval, setApproval] = useState(String(rule?.approval_days ?? 0));
  const [active, setActive] = useState(rule?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const draft: RuleDraft = {
    project_id: project || null,
    // With a project, client and product are the project's.
    client_id: project ? null : client || null,
    product_id: project ? null : product || null,
    team_id: team || null,
    user_id: person || null,
    business_days: numberOr(days, 0)!,
    min_days: numberOr(min, null),
    approval_days: numberOr(approval, 0)!,
    active,
  };
  const allowed = canManageDueScope(data, user, draft);
  const projects = data.projects
    .filter((p) => !p.archived)
    .map((p) => {
      const k = data.contracts.find((c) => c.id === p.contract_id);
      const clientName = data.clients.find((c) => c.id === k?.client_id)?.name;
      return { id: p.id, label: clientName ? `${p.name} · ${clientName}` : p.name };
    })
    .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
  // What a task created today would get (no client approval).
  const today = dateKey();
  const example = ruleDue(
    data.calendarDays,
    { ...draft, id: "", company_id: "" },
    today,
    false,
  );

  function problem() {
    if (!Number.isFinite(draft.business_days) || draft.business_days > 250)
      return "O prazo vai de 0 a 250 dias úteis.";
    if (draft.min_days != null && draft.min_days > draft.business_days)
      return "O mínimo não pode passar do próprio prazo.";
    if (draft.approval_days > 60)
      return "Os dias a mais pela aprovação do cliente vão de 0 a 60.";
    if (!allowed)
      return "Gestores configuram só regras das suas equipes, dos clientes que elas atendem e das pessoas delas.";
    return "";
  }
  async function save() {
    const p = problem();
    if (p) return setError(p);
    setBusy(true);
    setError("");
    try {
      await onSave({ ...draft, id: rule?.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const pick = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    any: string,
    options: { id: string; label: string }[],
    disabled = false,
  ) => (
    <label>
      {label}
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectOption value="">{any}</SelectOption>
        {options.map((o) => (
          <SelectOption key={o.id} value={o.id}>
            {o.label}
          </SelectOption>
        ))}
      </Select>
    </label>
  );
  const byName = <T extends { name: string }>(list: T[], id: (x: T) => string) =>
    [...list]
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))
      .map((x) => ({ id: id(x), label: x.name }));

  return (
    <Modal
      title={rule ? "Regra de prazo" : "Nova regra de prazo"}
      onClose={onClose}
      busy={busy}
    >
      <div className="entity-form due-rule-editor">
        <fieldset className="due-rule-criteria">
          <legend>Vale para tarefas…</legend>
          {pick("Do projeto", project, setProject, "Qualquer projeto", projects)}
          <div className="form-columns">
            {pick(
              "Do cliente",
              project ? "" : client,
              setClient,
              project ? "O do projeto" : "Qualquer cliente",
              byName(data.clients.filter((c) => !c.archived), (c) => c.id),
              !!project,
            )}
            {pick(
              "Do produto",
              project ? "" : product,
              setProduct,
              project ? "O do projeto" : "Qualquer produto",
              byName(data.products, (p) => p.id),
              !!project,
            )}
          </div>
          <div className="form-columns">
            {pick(
              "Da equipe",
              team,
              setTeam,
              "Qualquer equipe",
              byName(data.teams, (t) => t.id),
            )}
            {pick(
              "De quem executa",
              person,
              setPerson,
              "Qualquer pessoa",
              byName(
                data.members.filter((m) => m.active),
                (m) => m.user_id,
              ),
            )}
          </div>
          <small className="template-scope-hint">
            {ruleScope(data, { ...draft, id: "", company_id: "" })}. A equipe é
            a que recebe a tarefa ou, enviada a uma pessoa, uma equipe dela que
            atende o cliente.
          </small>
        </fieldset>
        <div className="due-rule-numbers">
          <label>
            Prazo (dias úteis)
            <Input
              type="number"
              min={0}
              max={250}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              required
            />
          </label>
          <label>
            Mínimo (opcional)
            <Input
              type="number"
              min={0}
              max={250}
              value={min}
              placeholder="Sem mínimo"
              onChange={(e) => setMin(e.target.value)}
            />
          </label>
          <label>
            + com aprovação do cliente
            <Input
              type="number"
              min={0}
              max={60}
              value={approval}
              onChange={(e) => setApproval(e.target.value)}
            />
          </label>
        </div>
        <small className="template-scope-hint">
          Uma tarefa criada hoje vence em <strong>{dayLabel(example.due)}</strong>
          {example.min && (
            <>
              ; antes de {dayLabel(example.min)} só com um motivo, que fica no
              histórico
            </>
          )}
          . Quem cria a tarefa pode mudar a data livremente.
        </small>
        <label className="checkbox-label">
          <Checkbox checked={active} onCheckedChange={(v) => setActive(v === true)} />
          Ativa — vale para novas tarefas
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          {rule &&
            (confirmDelete ? (
              <Button
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onDelete(rule.id);
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy(false);
                  }
                }}
              >
                <Trash2 size={15} /> Confirmar exclusão
              </Button>
            ) : (
              <Button
                className="btn secondary"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={15} /> Excluir
              </Button>
            ))}
          <Button className="btn secondary" disabled={busy} onClick={onClose}>
            Cancelar
          </Button>
          <Button className="btn primary" disabled={busy} loading={busy} onClick={() => void save()}>
            Salvar regra
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The calendar the rules count on: national holidays (a worked one is
 * marked) and the company's own days off.
 */
function CompanyCalendar({
  data,
  company,
  canEdit,
  mutate,
  notify,
}: {
  data: Snapshot;
  company: string;
  canEdit: boolean;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const thisYear = Number(dateKey().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [day, setDay] = useState("");
  const [name, setName] = useState("");
  const [yearly, setYearly] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const calendar = data.calendarDays ?? [];
  const inYear = (c: CalendarDay) =>
    c.day.startsWith(String(year)) || (c.yearly && c.day.slice(0, 4) <= String(year));
  const own = calendar
    .filter((c) => c.kind === "off" && inYear(c))
    .map((c) => ({ ...c, shown: c.yearly ? `${year}${c.day.slice(4)}` : c.day }))
    .sort((a, b) => (a.shown < b.shown ? -1 : 1));

  async function run(key: string, name: string, args: Record<string, unknown>, done: string) {
    setBusy(key);
    setError("");
    try {
      await mutate(name, args);
      notify(done);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  }
  async function add() {
    if (!day || name.trim().length < 2) return setError("Escolha o dia e dê um nome a ele.");
    const ok = await run(
      "add",
      "save_calendar_day",
      { p_company: company, p_id: null, p_day: day, p_name: name.trim(), p_kind: "off", p_yearly: yearly },
      "Dia sem expediente incluído no calendário.",
    );
    if (ok) {
      setDay("");
      setName("");
      setYearly(false);
    }
  }
  return (
    <section className="panel due-calendar" aria-labelledby="due-calendar-title">
      <div className="panel-heading">
        <div>
          <h2 id="due-calendar-title">Calendário da empresa</h2>
          <p>
            Dias que não contam nos prazos: sábados, domingos, feriados nacionais
            e os dias sem expediente da empresa
          </p>
        </div>
        <div className="due-calendar-years" role="group" aria-label="Ano">
          {[thisYear, thisYear + 1].map((y) => (
            <button
              key={y}
              type="button"
              aria-pressed={year === y}
              className={year === y ? "selected" : ""}
              onClick={() => setYear(y)}
            >
              {y}
            </button>
          ))}
        </div>
      </div>
      <div className="due-calendar-columns">
        <div>
          <h3>Feriados nacionais</h3>
          <ul className="due-calendar-list">
            {nationalHolidays(year).map((h) => {
              const worked = calendarEntry(calendar, h.day, "workday");
              return (
                <li key={h.day} className={worked ? "worked" : ""}>
                  <span className="due-calendar-day">{dayLabel(h.day)}</span>
                  <span>{h.name}</span>
                  {canEdit ? (
                    <label className="checkbox-label">
                      <Checkbox
                        checked={!!worked}
                        disabled={!!busy}
                        onCheckedChange={(v) =>
                          void (v === true
                            ? run(
                                h.day,
                                "save_calendar_day",
                                { p_company: company, p_id: null, p_day: h.day, p_name: h.name, p_kind: "workday", p_yearly: false },
                                `${h.name}: a empresa trabalha, e o dia conta nos prazos.`,
                              )
                            : worked &&
                              run(
                                h.day,
                                "delete_calendar_day",
                                { p_id: worked.id },
                                `${h.name} volta a ser feriado.`,
                              ))
                        }
                      />
                      Trabalhamos
                    </label>
                  ) : (
                    worked && <small>A empresa trabalha</small>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <h3>Dias sem expediente da empresa</h3>
          {own.length ? (
            <ul className="due-calendar-list">
              {own.map((c) => (
                <li key={c.id}>
                  <span className="due-calendar-day">{dayLabel(c.shown)}</span>
                  <span>
                    {c.name}
                    {c.yearly && <small> · todo ano</small>}
                  </span>
                  {canEdit && (
                    <Button
                      className="icon-btn"
                      aria-label={`Tirar ${c.name} do calendário`}
                      disabled={!!busy}
                      onClick={() =>
                        void run(c.id, "delete_calendar_day", { p_id: c.id }, `${c.name} saiu do calendário.`)
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="template-empty">
              <CalendarX2 size={15} aria-hidden="true" /> Nenhum em {year}. Inclua
              feriados da cidade, recessos e emendas.
            </p>
          )}
          {canEdit ? (
            <div className="due-calendar-add">
              <Input
                type="date"
                aria-label="Dia sem expediente"
                value={day}
                onChange={(e) => setDay(e.target.value)}
              />
              <Input
                aria-label="Nome do dia"
                placeholder="Ex.: Aniversário da cidade"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <label className="checkbox-label">
                <Checkbox checked={yearly} onCheckedChange={(v) => setYearly(v === true)} />
                Todo ano
              </label>
              <Button
                className="btn secondary"
                disabled={!!busy}
                loading={busy === "add"}
                onClick={() => void add()}
              >
                <Plus size={16} /> Incluir
              </Button>
            </div>
          ) : (
            <small className="template-scope-hint">
              Só administradores mudam o calendário da empresa.
            </small>
          )}
        </div>
      </div>
      {error && (
        <p className="form-error template-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

const SMART_MODES = [
  ["suggest", "Sugerir ao lado", "A data da regra preenche o prazo; a da MAVI aparece ao lado, com “Usar” e o porquê."],
  ["fill", "Preencher sozinha", "A data da MAVI já preenche o prazo (quando há histórico); a da regra fica ao lado."],
  ["off", "Desligado", "Só as regras de prazo."],
] as const;

/**
 * Prazo inteligente: how the MAVI's date shows up when creating tasks
 * (admins choose; companies.smart_due).
 */
function SmartDueMode({
  mode,
  canEdit,
  onChange,
}: {
  mode: "off" | "suggest" | "fill";
  canEdit: boolean;
  onChange: (mode: "off" | "suggest" | "fill") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="panel smart-due-mode" aria-labelledby="smart-due-title">
      <div className="panel-heading">
        <div>
          <h2 id="smart-due-title">
            <Sparkles size={17} aria-hidden="true" /> Prazo inteligente da MAVI
          </h2>
          <p>
            A MAVI olha quanto tarefas parecidas levaram de verdade (com 5 ou
            mais entregas), a carga de quem executa contra a jornada, as
            reuniões da agenda, a aprovação do cliente e o retrabalho. Nunca
            fica antes do mínimo da regra.
          </p>
        </div>
      </div>
      <div className="smart-due-options" role="radiogroup" aria-label="Como a MAVI sugere o prazo">
        {SMART_MODES.map(([id, label, hint]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            className={mode === id ? "selected" : ""}
            disabled={!canEdit || busy}
            onClick={async () => {
              if (id === mode) return;
              setBusy(true);
              setError("");
              try {
                await onChange(id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <strong>{label}</strong>
            <small>{hint}</small>
          </button>
        ))}
      </div>
      {!canEdit && (
        <small className="template-scope-hint smart-due-admin">
          Só administradores mudam como a MAVI sugere o prazo.
        </small>
      )}
      {error && (
        <p className="form-error template-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
