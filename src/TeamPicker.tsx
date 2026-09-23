import { Checkbox } from "./ui";
import type { Team } from "./types";

/** Multi-select of the teams responsible for a client, with "all teams". */
export function TeamPicker({
  teams,
  value,
  onChange,
}: {
  teams: Team[];
  value: string[];
  onChange: (teams: string[]) => void;
}) {
  const all = teams.length > 0 && teams.every((t) => value.includes(t.id));
  return (
    <fieldset className="team-picker">
      <legend>Equipes responsáveis</legend>
      {teams.length ? (
        <>
          <label className="checkbox-label team-picker-all">
            <Checkbox
              checked={all ? true : value.length ? "indeterminate" : false}
              onCheckedChange={() =>
                onChange(all ? [] : teams.map((t) => t.id))
              }
            />
            Todas as equipes
          </label>
          <div className="team-picker-list">
            {teams.map((t) => (
              <label className="checkbox-label" key={t.id}>
                <Checkbox
                  checked={value.includes(t.id)}
                  onCheckedChange={(on) =>
                    onChange(
                      on === true
                        ? [...new Set([...value, t.id])]
                        : value.filter((id) => id !== t.id),
                    )
                  }
                />
                {t.name}
              </label>
            ))}
          </div>
        </>
      ) : (
        <small>Nenhuma equipe cadastrada ainda.</small>
      )}
      <small>
        {value.length
          ? "Os colaboradores dessas equipes veem todos os produtos, projetos e tarefas deste cliente."
          : "Sem equipe, só administradores e gestores veem este cliente."}
      </small>
    </fieldset>
  );
}
