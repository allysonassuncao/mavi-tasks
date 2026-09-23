import { Clock3, Users } from "lucide-react";
import { Avatar, Empty } from "./components";
import { duration } from "./domain";
import type { Summary } from "./api";

export default function Reports({
  byClient,
  byPerson,
  personal = false,
  avatarOf,
}: {
  avatarOf?: (userId: string) => string | null | undefined;
  byClient: Summary["by_client"];
  byPerson: Summary["by_person"];
  /** Collaborator view: only the signed-in person's hours and workload. */
  personal?: boolean;
}) {
  const maximumMinutes = Math.max(
    1,
    ...byClient.map((client) => client.minutes),
  );
  return (
    <div className="report-grid">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{personal ? "Suas horas por cliente" : "Horas por cliente"}</h2>
            <p>
              {personal
                ? "Seu tempo registrado no período selecionado"
                : "Tempo registrado no período selecionado"}
            </p>
          </div>
          <Clock3 size={20} />
        </div>
        <div className="bar-list">
          {byClient.map((c) => (
            <div className="bar-row" key={c.id}>
              <div>
                <span>{c.name}</span>
                <strong>{duration(c.minutes)}</strong>
              </div>
              <div className="bar-track">
                <span
                  style={{
                    width: `${(c.minutes / maximumMinutes) * 100}%`,
                  }}
                />
              </div>
            </div>
          ))}
          {!byClient.length && (
            <Empty
              title="Sem horas no período"
              body="Selecione outro mês ou registre um apontamento."
            />
          )}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>{personal ? "Sua carga de trabalho" : "Carga de trabalho"}</h2>
            <p>
              {personal
                ? "Suas tarefas abertas e horas estimadas"
                : "Tarefas abertas e horas estimadas totais"}
            </p>
          </div>
          <Users size={20} />
        </div>
        <div className="workload">
          {byPerson.map((p) => (
            <div key={p.id}>
              <Avatar name={p.name} src={avatarOf?.(p.id)} />
              <span>
                <strong>{p.name}</strong>
                <small>{p.tasks} tarefas abertas</small>
              </span>
              <b>{duration(p.estimated)}</b>
            </div>
          ))}
        </div>
      </section>
      <div className="report-note">
        Estimativas não representam capacidade disponível.
      </div>
    </div>
  );
}
