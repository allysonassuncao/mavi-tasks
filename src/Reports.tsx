import { Clock3, Users, ShieldCheck } from "lucide-react";
import { Avatar, Empty } from "./components";
import { duration } from "./domain";
import type { Summary } from "./api";

export default function Reports({
  byClient,
  byPerson,
}: {
  byClient: Summary["by_client"];
  byPerson: Summary["by_person"];
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
            <h2>Horas por cliente</h2>
            <p>Tempo registrado no período selecionado</p>
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
            <h2>Carga de trabalho</h2>
            <p>Tarefas abertas e horas estimadas totais</p>
          </div>
          <Users size={20} />
        </div>
        <div className="workload">
          {byPerson.map((p) => (
            <div key={p.id}>
              <Avatar name={p.name} />
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
        <ShieldCheck size={18} /> Os relatórios respeitam suas permissões.
        Estimativas não representam capacidade disponível.
      </div>
    </div>
  );
}
