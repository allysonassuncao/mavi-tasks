import { useMemo, useState } from "react";
import { CalendarClock, Palmtree, Plus, Save, Search, Trash2 } from "lucide-react";
import { ReplanModal } from "./DueAssist";
import { Avatar } from "./components";
import { Button, Input, Select, SelectOption } from "./ui";
import { dateKey, fold } from "./domain";
import { canManageDueScope } from "./dueRules";
import { dayLabel, plural } from "./task-bulk";
import { absenceKinds, type AbsenceKind, type Member, type Snapshot } from "./types";
import "./due-rules.css";

type Mutate = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const WEEKDAYS = [
  [1, "S", "Segunda"],
  [2, "T", "Terça"],
  [3, "Q", "Quarta"],
  [4, "Q", "Quinta"],
  [5, "S", "Sexta"],
] as const;
const hours = (minutes: number) =>
  Number.isInteger(minutes / 60) ? String(minutes / 60) : (minutes / 60).toFixed(1).replace(".", ",");
const toMinutes = (text: string) => Math.round(Number(text.replace(",", ".")) * 60);

/**
 * Settings (leaders), in the Prazos tab: the working day of the company and
 * of each person (hours for the workload, weekdays for the due dates) and
 * their vacations, days off and leaves. Admins set anyone; managers the
 * people in their teams.
 */
export function WorkloadPanel({
  data,
  company,
  user,
  demo,
  mutate,
  notify,
}: {
  data: Snapshot;
  company: string;
  user: string;
  demo: boolean;
  mutate: Mutate;
  notify: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Replanning someone's tasks (Fase 4): from their row or a new absence.
  const [replanFor, setReplanFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const isAdmin = data.members.some((m) => m.user_id === user && m.active && m.role === "admin");
  const companyMinutes = data.companies.find((c) => c.id === company)?.work_minutes ?? 480;
  const canManage = (id: string) =>
    canManageDueScope(data, user, { project_id: null, client_id: null, team_id: null, user_id: id });
  const people = useMemo(
    () =>
      data.members
        .filter((m) => m.active)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.members],
  );
  const shown = people.filter((m) => fold(m.name).includes(fold(query.trim())));
  return (
    <section className="panel due-workload" aria-labelledby="due-workload-title">
      <div className="panel-heading">
        <div>
          <h2 id="due-workload-title">Jornada e ausências</h2>
          <p>
            Os prazos pela regra contam só os dias em que quem executa trabalha:
            fora dos seus dias da semana, de férias, de folga ou afastado, o dia
            não conta
          </p>
        </div>
      </div>
      <CompanyWorkday
        minutes={companyMinutes}
        canEdit={isAdmin}
        onSave={async (m) => {
          await mutate("set_company_work_minutes", { p_company: company, p_minutes: m });
          notify(`Jornada da empresa: ${hours(m)} h por dia.`);
        }}
      />
      <div className="due-workload-people">
        <div className="due-workload-head">
          <h3>Jornada de cada pessoa</h3>
          {people.length > 8 && (
            <Input
              type="search"
              aria-label="Buscar pessoa"
              placeholder="Buscar pessoa…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              icon={Search}
            />
          )}
        </div>
        {shown.map((m) => (
          <PersonWorkday
            key={m.user_id}
            member={m}
            companyMinutes={companyMinutes}
            canEdit={canManage(m.user_id)}
            onReplan={() => setReplanFor(m.user_id)}
            onSave={async (minutes, days) => {
              setError("");
              try {
                await mutate("set_member_workload", {
                  p_company: company,
                  p_user: m.user_id,
                  p_minutes: minutes,
                  p_days: days,
                });
                notify(`Jornada de ${m.name} atualizada.`);
              } catch (e) {
                setError((e as Error).message);
                throw e;
              }
            }}
          />
        ))}
      </div>
      <Absences
        data={data}
        company={company}
        people={people.filter((m) => canManage(m.user_id))}
        canManage={canManage}
        mutate={mutate}
        notify={notify}
        onReplan={setReplanFor}
      />
      {replanFor && (
        <ReplanModal
          company={company}
          user={replanFor}
          data={data}
          demo={demo}
          mutate={mutate}
          notify={notify}
          onClose={() => setReplanFor(null)}
        />
      )}
      {error && (
        <p className="form-error template-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function CompanyWorkday({
  minutes,
  canEdit,
  onSave,
}: {
  minutes: number;
  canEdit: boolean;
  onSave: (minutes: number) => Promise<void>;
}) {
  const [value, setValue] = useState(hours(minutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const next = toMinutes(value);
  const dirty = next !== minutes;
  return (
    <div className="due-workload-company">
      <label>
        Jornada da empresa
        <span className="due-workload-hours">
          <Input
            type="number"
            min={1}
            max={24}
            step={0.5}
            value={value}
            disabled={!canEdit || busy}
            onChange={(e) => setValue(e.target.value)}
          />
          h por dia
        </span>
      </label>
      {canEdit && dirty && (
        <Button
          className="btn secondary"
          disabled={busy || !(next >= 60 && next <= 1440)}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onSave(next);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save size={15} /> Salvar
        </Button>
      )}
      <small>
        Vale para quem não tem jornada própria. Será usada pela MAVI para comparar
        as horas estimadas em aberto de cada pessoa com o tempo que ela tem.
        {!canEdit && " Só administradores mudam a jornada da empresa."}
      </small>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PersonWorkday({
  member,
  companyMinutes,
  canEdit,
  onReplan,
  onSave,
}: {
  member: Member;
  companyMinutes: number;
  canEdit: boolean;
  onReplan: () => void;
  onSave: (minutes: number | null, days: number[] | null) => Promise<void>;
}) {
  const savedDays = member.work_days?.length ? member.work_days : [1, 2, 3, 4, 5];
  const [value, setValue] = useState(member.work_minutes ? hours(member.work_minutes) : "");
  const [days, setDays] = useState<number[]>(savedDays);
  const [busy, setBusy] = useState(false);
  const minutes = value.trim() ? toMinutes(value) : null;
  const dirty =
    minutes !== (member.work_minutes ?? null) ||
    days.join() !== savedDays.join();
  return (
    <div className="due-workload-person">
      <Avatar
        name={member.name}
        src={member.avatar_url}
        size="small"
        person={member.user_id}
      />
      <span className="due-workload-name" data-person={member.user_id}>
        {member.name}
      </span>
      <span className="due-workload-hours">
        <Input
          type="number"
          min={0.5}
          max={24}
          step={0.5}
          aria-label={`Horas por dia de ${member.name}`}
          placeholder={hours(companyMinutes)}
          value={value}
          disabled={!canEdit || busy}
          onChange={(e) => setValue(e.target.value)}
        />
        h
      </span>
      <span className="due-workload-days" role="group" aria-label={`Dias em que ${member.name} trabalha`}>
        {WEEKDAYS.map(([n, short, label]) => {
          const on = days.includes(n);
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              aria-label={label}
              title={label}
              className={on ? "on" : ""}
              disabled={!canEdit || busy || (on && days.length === 1)}
              onClick={() =>
                setDays((d) => (on ? d.filter((x) => x !== n) : [...d, n].sort()))
              }
            >
              {short}
            </button>
          );
        })}
      </span>
      {canEdit && dirty && (
        <Button
          className="icon-btn"
          aria-label={`Salvar a jornada de ${member.name}`}
          title="Salvar"
          disabled={busy || (minutes != null && !(minutes >= 30 && minutes <= 1440))}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(minutes, days.length === 5 ? null : days);
            } catch {
              // The panel shows the message.
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save size={15} />
        </Button>
      )}
      {canEdit && !dirty && (
        <Button
          className="icon-btn"
          aria-label={`Replanejar tarefas de ${member.name}`}
          title="Replanejar tarefas (a MAVI propõe; você aplica)"
          onClick={onReplan}
        >
          <CalendarClock size={15} />
        </Button>
      )}
    </div>
  );
}

function Absences({
  data,
  company,
  people,
  canManage,
  mutate,
  notify,
  onReplan,
}: {
  data: Snapshot;
  company: string;
  /** Whose absences this person may register. */
  people: Member[];
  canManage: (user: string) => boolean;
  mutate: Mutate;
  notify: (message: string) => void;
  onReplan: (user: string) => void;
}) {
  // After an absence that catches open tasks: the way to replan them.
  const [affected, setAffected] = useState<{ user: string; n: number } | null>(null);
  const today = dateKey();
  const [who, setWho] = useState("");
  const [kind, setKind] = useState<AbsenceKind>("vacation");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const name = (id: string) => data.members.find((m) => m.user_id === id)?.name ?? "—";
  const upcoming = (data.absences ?? [])
    .filter((a) => a.ends_on >= today)
    .sort((a, b) => (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0));

  async function add() {
    const person = who || people[0]?.user_id;
    if (!person || !starts) return setError("Escolha a pessoa e o primeiro dia.");
    setBusy("add");
    setError("");
    try {
      const result = (await mutate("save_member_absence", {
        p_company: company,
        p_id: null,
        p_user: person,
        p_starts: starts,
        p_ends: ends || starts,
        p_kind: kind,
      })) as { open_tasks?: number } | null;
      const n = result?.open_tasks ?? 0;
      notify("Ausência registrada.");
      setAffected(n ? { user: person, n } : null);
      setStarts("");
      setEnds("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="due-absences">
      <h3>Férias, folgas e afastamentos</h3>
      {upcoming.length ? (
        <ul className="due-calendar-list">
          {upcoming.map((a) => (
            <li key={a.id} className={a.starts_on <= today ? "now" : ""}>
              <span className="due-absence-period">
                {a.starts_on === a.ends_on
                  ? dayLabel(a.starts_on)
                  : `${dayLabel(a.starts_on)} a ${dayLabel(a.ends_on)}`}
              </span>
              <span>
                {name(a.user_id)}
                <small> · {absenceKinds[a.kind]}{a.starts_on <= today && " · agora"}</small>
              </span>
              {canManage(a.user_id) && (
                <Button
                  className="icon-btn"
                  aria-label={`Tirar a ausência de ${name(a.user_id)}`}
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(a.id);
                    setError("");
                    try {
                      await mutate("delete_member_absence", { p_id: a.id });
                      notify("Ausência removida.");
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  <Trash2 size={15} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="template-empty">
          <Palmtree size={15} aria-hidden="true" /> Ninguém com ausência marcada.
        </p>
      )}
      {affected && (
        <div className="due-absence-affected" role="status">
          <CalendarClock size={15} aria-hidden="true" />
          <span>
            {name(affected.user)} tem {plural(affected.n, "tarefa em aberto", "tarefas em aberto")}{" "}
            vencendo nesse período.
          </span>
          <Button
            className="btn secondary"
            onClick={() => {
              onReplan(affected.user);
              setAffected(null);
            }}
          >
            Replanejar
          </Button>
        </div>
      )}
      {people.length > 0 ? (
        <div className="due-absence-add">
          <Select value={who || people[0].user_id} onValueChange={setWho} aria-label="Pessoa">
            {people.map((m) => (
              <SelectOption key={m.user_id} value={m.user_id}>
                {m.name}
              </SelectOption>
            ))}
          </Select>
          <Select value={kind} onValueChange={(v) => setKind(v as AbsenceKind)} aria-label="Tipo">
            {Object.entries(absenceKinds).map(([id, label]) => (
              <SelectOption key={id} value={id}>
                {label}
              </SelectOption>
            ))}
          </Select>
          <Input
            type="date"
            aria-label="Primeiro dia"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
          />
          <Input
            type="date"
            aria-label="Último dia"
            value={ends}
            min={starts || undefined}
            onChange={(e) => setEnds(e.target.value)}
          />
          <Button className="btn secondary" disabled={!!busy} loading={busy === "add"} onClick={() => void add()}>
            <Plus size={16} /> Registrar
          </Button>
          <small className="template-scope-hint">
            Sem último dia, vale só o primeiro. Quem está fora hoje só recebe
            tarefas da equipe se a equipe inteira estiver fora.
          </small>
        </div>
      ) : (
        <small className="template-scope-hint">
          Gestores registram ausências das pessoas das suas equipes.
        </small>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
