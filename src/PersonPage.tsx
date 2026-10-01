import { useEffect, useState } from "react";
import { Avatar, Badge, Empty } from "./components";
import { PresenceDot } from "./OnlineMembers";
import {
  AbsenceLine,
  PersonActions,
  ROLE_NAMES,
  follow,
  personTasksUrl,
  presenceText,
  usePhones,
  useTaskSummary,
  type PersonEnv,
} from "./PersonCard";
import {
  personNextTasks,
  personTeams,
  shortDate,
  workDaysLabel,
  workHoursLabel,
  type PersonNextTask,
} from "./person";
import { phoneLabel } from "./temperature";
import { taskUrl } from "./router";
import { absenceKinds } from "./types";
import { Loading } from "./ui";

/**
 * O perfil de outra pessoa (/pessoas/<id>), só leitura: quem é, as equipes,
 * a jornada e as ausências, as tarefas como responsável e os mesmos atalhos
 * do balão. Todo mundo vê o básico; os números das tarefas, os telefones,
 * Editar cadastro e Logs ficam com administradores e gestores, como em
 * Pessoas do espaço. As tarefas são só as que quem olha já vê.
 */
export function PersonPage({ env, id }: { env: PersonEnv; id: string }) {
  const member = env.data.members.find((m) => m.user_id === id);
  const summary = useTaskSummary(env, id, !!member && env.isLeader);
  const phones = usePhones(env, id, !!member);
  const [next, setNext] = useState<PersonNextTask[] | null | "error">(null);
  useEffect(() => {
    if (!member || !env.canOpen("search")) return;
    let alive = true;
    setNext(null);
    personNextTasks(env.company, id, env.data)
      .then((rows) => alive && setNext(rows))
      .catch(() => alive && setNext("error"));
    return () => {
      alive = false;
    };
    // env.data only matters in the demo, where it is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.company, id, !!member]);

  if (!member)
    return (
      <Empty
        title="Pessoa não encontrada"
        body="Ela pode ter saído da agência, ou o link está incompleto."
      />
    );
  const teams = personTeams(env.data, id);
  const clientsOf = (team: string) =>
    env.data.clientTeams.filter((ct) => ct.team_id === team).length;
  const presence = presenceText(env.presence, id);
  const company = env.data.companies.find((c) => c.id === env.company);
  const absences = (env.data.absences ?? [])
    .filter((a) => a.user_id === id && a.ends_on >= env.today)
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  const tasksHref = (status = "") =>
    personTasksUrl(id, env.companyPath, status);
  return (
    <div className="person-page">
      <section className="panel person-hero">
        <span className="online-avatar">
          <Avatar name={member.name} src={member.avatar_url} size="xlarge" />
          <PresenceDot state={env.presence.get(id)?.state} />
        </span>
        <div className="person-hero-text">
          <h2>{member.name}</h2>
          <span className="person-card-meta">
            <span className="role-tag">{ROLE_NAMES[member.role]}</span>
            {!member.active && <span className="person-inactive">Inativo</span>}
            {presence ? (
              <small>{presence}</small>
            ) : (
              <small>Fora do workspace agora</small>
            )}
          </span>
          <AbsenceLine env={env} member={member} />
        </div>
      </section>
      <section className="panel person-shortcuts" aria-label="Atalhos">
        <PersonActions
          env={env}
          member={member}
          phones={phones}
          profile={false}
        />
      </section>
      <div className="person-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Dados cadastrais</h2>
              <p>Quem é e como trabalha</p>
            </div>
          </div>
          <dl className="person-facts">
            <dt>Nome</dt>
            <dd>{member.name}</dd>
            <dt>E-mail</dt>
            <dd>{member.email || "—"}</dd>
            <dt>Perfil de acesso</dt>
            <dd>{ROLE_NAMES[member.role]}</dd>
            <dt>Situação</dt>
            <dd>{member.active ? "Ativo" : "Inativo"}</dd>
            <dt>Equipes</dt>
            <dd>
              {teams.length ? (
                <span className="person-teams">
                  {teams.map((t) => {
                    const n = clientsOf(t.id);
                    return (
                      <span key={t.id} className="person-team">
                        {t.name}
                        {t.supervisor && <small> · supervisor</small>}
                        {n > 0 && (
                          <small>
                            {" "}
                            · {n} cliente{n > 1 ? "s" : ""}
                          </small>
                        )}
                      </span>
                    );
                  })}
                </span>
              ) : (
                "Nenhuma"
              )}
            </dd>
            <dt>Jornada</dt>
            <dd>
              {workHoursLabel(
                member.work_minutes ?? company?.work_minutes ?? 480,
              )}{" "}
              por dia, {workDaysLabel(member.work_days)}
            </dd>
            {phones.length > 0 && (
              <>
                <dt>WhatsApp</dt>
                <dd>{phones.map(phoneLabel).join(", ")}</dd>
              </>
            )}
            <dt>Ausências</dt>
            <dd>
              {absences.length
                ? absences
                    .slice(0, 4)
                    .map((a) =>
                      a.starts_on === a.ends_on
                        ? `${absenceKinds[a.kind]} em ${shortDate(a.starts_on)}`
                        : `${absenceKinds[a.kind]} de ${shortDate(a.starts_on)} a ${shortDate(a.ends_on)}`,
                    )
                    .join(" · ")
                : "Nenhuma marcada"}
            </dd>
          </dl>
        </section>
        {env.canOpen("search") && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Tarefas</h2>
                <p>Em que é responsável (das que você vê)</p>
              </div>
              <a
                className="btn secondary"
                href={tasksHref()}
                onClick={(e) => follow(e)}
              >
                Ver todas
              </a>
            </div>
            <div className="person-tasks-body">
              {env.isLeader && summary !== null && (
                <div className="person-tiles">
                  {summary === "loading" ? (
                    <Loading compact />
                  ) : (
                    <>
                      <a
                        className="person-tile"
                        href={tasksHref()}
                        onClick={(e) => follow(e)}
                      >
                        <strong>{summary.open}</strong>
                        <span>Em aberto</span>
                      </a>
                      <div
                        className={`person-tile ${summary.late ? "late" : ""}`}
                      >
                        <strong>{summary.late}</strong>
                        <span>Atrasadas</span>
                      </div>
                      <a
                        className="person-tile"
                        href={tasksHref("review")}
                        onClick={(e) => follow(e)}
                      >
                        <strong>{summary.review}</strong>
                        <span>Em validação</span>
                      </a>
                      <a
                        className="person-tile"
                        href={tasksHref("done")}
                        onClick={(e) => follow(e)}
                      >
                        <strong>{summary.done_30d}</strong>
                        <span>Entregues em 30 dias</span>
                      </a>
                    </>
                  )}
                </div>
              )}
              {next === null ? (
                <Loading compact />
              ) : next === "error" ? (
                <p className="muted">
                  Não foi possível carregar as próximas entregas.
                </p>
              ) : next.length ? (
                <ul className="person-next" aria-label="Próximas entregas">
                  {next.map((t) => {
                    const late = t.due_date < env.today;
                    return (
                      <li key={t.id}>
                        <a
                          href={taskUrl(t, env.companyPath)}
                          onClick={(e) => follow(e)}
                        >
                          <span className="person-next-title">{t.title}</span>
                          <Badge status={t.status} />
                          <span
                            className={`person-next-due ${late ? "late" : ""}`}
                          >
                            {late ? "Atrasada · " : ""}
                            {shortDate(t.due_date)}
                          </span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="muted">Nenhuma tarefa em aberto que você veja.</p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
