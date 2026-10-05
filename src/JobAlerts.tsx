import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  CircleDashed,
  PauseCircle,
  RefreshCw,
  Send,
} from "lucide-react";
import { Button, Checkbox, Input, Loading } from "./ui";
import { Empty } from "./components";
import { MultiPick } from "./MultiPick";
import { ago } from "./whatsapp";
import { navigate } from "./router";
import type { Snapshot } from "./types";
import {
  HEALTH_LABEL,
  JOB_ABOUT,
  clampInt,
  countNoun,
  hoursLabel,
  jobAlertsApi,
  jobHealth,
  settingsSummary,
  type JobAlert,
  type JobAlertSettings,
  type JobHealth,
} from "./job-alerts";
import "./job-alerts.css";

const HEALTH_ICON: Record<JobHealth, typeof CheckCircle2> = {
  ok: CheckCircle2,
  failing: AlertTriangle,
  stale: PauseCircle,
  idle: CircleDashed,
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Equipe e configurações › Avisos de falhas: as rotinas que rodam sozinhas,
 * como estão agora e, para cada uma, quando avisar e quem recebe. Só
 * administradores.
 */
export function JobAlertsPanel(props: {
  data: Snapshot;
  company: string;
  isAdmin: boolean;
  demo: boolean;
  notify: (message: string) => void;
}) {
  if (props.demo)
    return (
      <section className="panel" id="config-avisos">
        <Empty
          title="Avisos de falhas na conta real"
          body="A demonstração não tem rotinas rodando."
        />
      </section>
    );
  if (!props.isAdmin)
    return (
      <section className="panel" id="config-avisos">
        <Empty
          title="Exclusivo de administradores"
          body="Peça a um administrador para configurar os avisos de falhas."
        />
      </section>
    );
  return <Jobs {...props} />;
}

function Jobs({
  data,
  company,
  notify,
}: {
  data: Snapshot;
  company: string;
  notify: (message: string) => void;
}) {
  const [jobs, setJobs] = useState<JobAlert[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const people = useMemo(
    () =>
      data.members
        .filter((m) => m.active)
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
    [data.members],
  );
  const admins = people.filter((m) => m.role === "admin").length;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setJobs(await jobAlertsApi.list(company));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [company]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!jobs)
    return (
      <section className="panel job-alerts" id="config-avisos">
        {error ? (
          <p className="job-alerts-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading label="Carregando as rotinas" />
        )}
      </section>
    );

  const failing = jobs.filter((j) => jobHealth(j) === "failing").length;
  const stale = jobs.filter((j) => jobHealth(j) === "stale").length;
  return (
    <section className="panel job-alerts" id="config-avisos">
      <div className="panel-heading">
        <div>
          <h2>
            <BellRing size={18} /> Avisos de falhas
          </h2>
          <p>
            As rotinas que rodam sozinhas, como estão agora e quando avisar se
            algo der errado. Os avisos chegam na caixa de entrada e no navegador
            de quem recebe.
          </p>
        </div>
        <Button
          className="btn secondary"
          loading={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={15} /> Atualizar
        </Button>
      </div>
      <p className="job-alerts-overview" role="status">
        {failing + stale === 0
          ? "Nenhuma rotina com problema agora."
          : [
              failing ? `${failing} com falha` : "",
              stale ? `${stale} ${stale === 1 ? "parada" : "paradas"}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
      {error && (
        <p className="job-alerts-error" role="alert">
          {error}
        </p>
      )}
      <ul className="job-alerts-list">
        {jobs.map((j) => (
          <JobRow
            key={j.job}
            job={j}
            admins={admins}
            people={people}
            company={company}
            open={open === j.job}
            onOpen={() => setOpen(open === j.job ? null : j.job)}
            onSaved={(next, message) => {
              setJobs(next);
              setOpen(null);
              notify(message);
            }}
            notify={notify}
          />
        ))}
      </ul>
    </section>
  );
}

function JobRow({
  job: j,
  admins,
  people,
  company,
  open,
  onOpen,
  onSaved,
  notify,
}: {
  job: JobAlert;
  admins: number;
  people: Snapshot["members"];
  company: string;
  open: boolean;
  onOpen: () => void;
  onSaved: (jobs: JobAlert[], message: string) => void;
  notify: (message: string) => void;
}) {
  const health = jobHealth(j);
  const Icon = HEALTH_ICON[health];
  return (
    <li className={`job-alert ${health}${j.settings.active ? "" : " off"}`}>
      <div className="job-alert-head">
        <Icon size={18} className="job-alert-icon" aria-hidden="true" />
        <div className="job-alert-title">
          <strong>{j.label}</strong>
          <span className={`job-alert-pill ${health}`}>
            {HEALTH_LABEL[health]}
            {health === "failing" && j.noun
              ? ` em ${countNoun(j, j.health.failing_count)}`
              : ""}
          </span>
        </div>
        <Button
          className="btn secondary job-alert-configure"
          aria-expanded={open}
          onClick={onOpen}
        >
          {open ? "Fechar" : "Configurar"}
        </Button>
      </div>
      <p className="job-alert-about">{JOB_ABOUT[j.job]}</p>
      <p className="job-alert-meta">
        {j.health.last_ok_at
          ? `Último sucesso ${ago(j.health.last_ok_at)}`
          : j.health.seen
            ? "Ainda sem sucesso registrado"
            : "Ainda não rodou desde que os avisos foram ligados"}
        {health === "stale" &&
          j.settings.stale_hours &&
          ` · mais de ${j.settings.stale_hours} h sem funcionar`}
        {" · "}
        <a
          href={j.link}
          onClick={(e) => {
            e.preventDefault();
            navigate(j.link);
          }}
        >
          Ver a rotina
        </a>
      </p>
      {j.health.failing.length > 0 && (
        <ul className="job-alert-failures">
          {j.health.failing.map((f, i) => (
            <li key={`${f.label}-${i}`}>
              {f.label && <strong>{f.label}</strong>}
              <span>
                {f.streak === 1 ? "1 falha" : `${f.streak} falhas seguidas`},
                desde {when(f.since)}
                {f.alerted ? " · avisado" : ""}
              </span>
              <code>{f.error}</code>
            </li>
          ))}
          {j.health.failing_count > j.health.failing.length && (
            <li className="job-alert-more">
              e mais{" "}
              {countNoun(j, j.health.failing_count - j.health.failing.length)}
            </li>
          )}
        </ul>
      )}
      {!open && (
        <p className="job-alert-summary">{settingsSummary(j, admins)}</p>
      )}
      {open && (
        <JobEditor
          job={j}
          admins={admins}
          people={people}
          company={company}
          onSaved={onSaved}
          onCancel={onOpen}
          notify={notify}
        />
      )}
    </li>
  );
}

type Draft = {
  active: boolean;
  everyAdmin: boolean;
  recipients: string[];
  failOn: boolean;
  failAfter: string;
  staleOn: boolean;
  staleHours: string;
  recovery: boolean;
  remindOn: boolean;
  remindHours: string;
};

function draftOf(j: JobAlert): Draft {
  const s = j.settings;
  return {
    active: s.active,
    everyAdmin: s.recipients === null,
    recipients: s.recipients ?? [],
    failOn: s.fail_after !== null,
    failAfter: String(s.fail_after ?? j.defaults.fail_after ?? 3),
    staleOn: s.stale_hours !== null,
    staleHours: String(s.stale_hours ?? j.defaults.stale_hours ?? 6),
    recovery: s.notify_recovery,
    remindOn: s.remind_hours !== null,
    remindHours: String(s.remind_hours ?? 24),
  };
}

function settingsOf(d: Draft): JobAlertSettings {
  return {
    active: d.active,
    recipients: d.everyAdmin ? null : d.recipients,
    fail_after: d.failOn ? (clampInt(d.failAfter, 1, 50) ?? 1) : null,
    stale_hours: d.staleOn ? (clampInt(d.staleHours, 1, 720) ?? 6) : null,
    notify_recovery: d.recovery,
    remind_hours: d.remindOn ? (clampInt(d.remindHours, 1, 168) ?? 24) : null,
  };
}

function JobEditor({
  job: j,
  admins,
  people,
  company,
  onSaved,
  onCancel,
  notify,
}: {
  job: JobAlert;
  admins: number;
  people: Snapshot["members"];
  company: string;
  onSaved: (jobs: JobAlert[], message: string) => void;
  onCancel: () => void;
  notify: (message: string) => void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(j));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const id = (name: string) => `job-${j.job}-${name}`;
  const item = j.noun ? `cada ${j.noun}` : "";

  async function save() {
    if (!d.everyAdmin && d.recipients.length === 0) {
      setError(
        "Escolha ao menos uma pessoa, ou deixe todos os administradores.",
      );
      return;
    }
    setBusy("save");
    setError("");
    try {
      onSaved(
        await jobAlertsApi.save(company, j.job, settingsOf(d)),
        `Avisos de “${j.label}” salvos.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function reset() {
    setBusy("reset");
    setError("");
    try {
      onSaved(
        await jobAlertsApi.save(company, j.job, null),
        `“${j.label}” voltou ao padrão.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function test() {
    setBusy("test");
    setError("");
    try {
      const n = await jobAlertsApi.test(company, j.job);
      notify(
        n === 0
          ? "Ninguém recebeu o teste: confira quem recebe (e se a pessoa desligou esse tipo de aviso no perfil)."
          : `Teste enviado para ${n} ${n === 1 ? "pessoa" : "pessoas"} (configuração salva).`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="job-alert-editor">
      <button
        type="button"
        role="switch"
        aria-checked={d.active}
        className={`template-switch${d.active ? " on" : ""}`}
        onClick={() => set({ active: !d.active })}
      >
        <span aria-hidden="true" />
        {d.active ? "Avisos ligados" : "Avisos desligados"}
      </button>

      <fieldset className="job-alert-who" disabled={!d.active}>
        <legend>Quem recebe</legend>
        <div
          className="job-alert-scope"
          role="radiogroup"
          aria-label="Quem recebe"
        >
          {(
            [
              [true, `Todos os administradores (${admins})`],
              [false, "Escolher pessoas"],
            ] as const
          ).map(([every, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={d.everyAdmin === every}
              onClick={() => set({ everyAdmin: every })}
            >
              {label}
            </button>
          ))}
        </div>
        {!d.everyAdmin && (
          <MultiPick
            label="Pessoas que recebem"
            allLabel="Ninguém escolhido"
            noun="pessoas"
            options={people.map((m) => ({ value: m.user_id, label: m.name }))}
            value={d.recipients}
            onChange={(recipients) => set({ recipients })}
          />
        )}
      </fieldset>

      <fieldset className="job-alert-when" disabled={!d.active}>
        <legend>Quando avisar</legend>
        {j.fails && (
          <Option
            id={id("fail")}
            checked={d.failOn}
            onChange={(failOn) => set({ failOn })}
            title={
              <>
                Ao falhar{" "}
                <NumberField
                  label="Falhas seguidas"
                  value={d.failAfter}
                  min={1}
                  max={50}
                  disabled={!d.failOn}
                  onChange={(failAfter) => set({ failAfter })}
                />{" "}
                {d.failAfter === "1" ? "vez" : "vezes seguidas"}
              </>
            }
          >
            Avisa quando a rotina dá erro esse número de vezes sem nenhum acerto
            no meio{item ? `, contando ${item} separadamente` : ""}. Use 1 para
            saber logo na primeira falha; um número maior ignora erros
            passageiros, que se resolvem sozinhos na tentativa seguinte.
          </Option>
        )}
        {j.stale_ok && (
          <Option
            id={id("stale")}
            checked={d.staleOn}
            onChange={(staleOn) => set({ staleOn })}
            title={
              <>
                Quando parar de rodar: ficar{" "}
                <NumberField
                  label="Horas sem funcionar"
                  value={d.staleHours}
                  min={1}
                  max={720}
                  disabled={!d.staleOn}
                  onChange={(staleHours) => set({ staleHours })}
                />{" "}
                horas sem nenhum sucesso
              </>
            }
          >
            {j.fails
              ? "Pega o caso em que a rotina nem chega a registrar erro, por exemplo quando o servidor está fora do ar ou o agendamento parou. Escolha um tempo maior que o intervalo normal entre as execuções."
              : "Esta rotina não informa erros: o aviso é quando ela deixa de dar sinal de vida por esse tempo. Escolha um tempo maior que o intervalo normal entre os envios."}
          </Option>
        )}
        <Option
          id={id("recovery")}
          checked={d.recovery}
          onChange={(recovery) => set({ recovery })}
          title="Quando voltar a funcionar"
        >
          Depois de um aviso de falha ou de parada, avisa quando der certo de
          novo. Assim você sabe que o problema se resolveu sem precisar
          conferir.
        </Option>
        <Option
          id={id("remind")}
          checked={d.remindOn}
          onChange={(remindOn) => set({ remindOn })}
          title={
            <>
              Lembrar enquanto continuar: a cada{" "}
              <NumberField
                label="Horas entre os lembretes"
                value={d.remindHours}
                min={1}
                max={168}
                disabled={!d.remindOn}
                onChange={(remindHours) => set({ remindHours })}
              />{" "}
              horas
            </>
          }
        >
          Repete o aviso nesse intervalo enquanto o problema não se resolver
          {d.remindOn && clampInt(d.remindHours, 1, 168)
            ? ` (a cada ${hoursLabel(clampInt(d.remindHours, 1, 168)!)})`
            : ""}
          . Desmarcado, avisa uma vez só.
        </Option>
      </fieldset>

      {error && (
        <p className="job-alerts-error" role="alert">
          {error}
        </p>
      )}
      <div className="job-alert-actions">
        <Button
          className="btn primary"
          loading={busy === "save"}
          disabled={!!busy}
          onClick={() => void save()}
        >
          Salvar
        </Button>
        <Button
          className="btn secondary"
          loading={busy === "test"}
          disabled={!!busy}
          title="Manda um aviso de teste para quem recebe (pela configuração salva)"
          onClick={() => void test()}
        >
          <Send size={14} /> Enviar teste
        </Button>
        {j.custom && (
          <Button
            className="btn secondary"
            loading={busy === "reset"}
            disabled={!!busy}
            onClick={() => void reset()}
          >
            Voltar ao padrão
          </Button>
        )}
        <Button className="btn secondary" disabled={!!busy} onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

function Option({
  id,
  checked,
  onChange,
  title,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={`job-alert-option${checked ? " on" : ""}`}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        aria-describedby={`${id}-hint`}
      />
      <div>
        <label htmlFor={id} className="job-alert-option-title">
          {title}
        </label>
        <p id={`${id}-hint`}>{children}</p>
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <input
      type="number"
      className="ui-input job-alert-number"
      aria-label={label}
      inputMode="numeric"
      min={min}
      max={max}
      value={value}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onChange(String(clampInt(value, min, max) ?? min))}
    />
  );
}
