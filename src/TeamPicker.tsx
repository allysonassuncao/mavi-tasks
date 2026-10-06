import { Checkbox } from "./ui";
import type { Team } from "./types";

/**
 * Multi-select of teams, with "all teams". `fixed` teams come from elsewhere
 * (a client's products): shown checked and locked, with where they come from.
 */
export function TeamPicker({
  teams,
  value,
  onChange,
  legend = "Equipes responsáveis",
  hint,
  fixed = [],
}: {
  teams: Team[];
  value: string[];
  onChange: (teams: string[]) => void;
  legend?: string;
  hint?: string;
  fixed?: { team: string; from: string }[];
}) {
  const fixedFrom = new Map(fixed.map((f) => [f.team, f.from]));
  const free = teams.filter((t) => !fixedFrom.has(t.id));
  const all = free.length > 0 && free.every((t) => value.includes(t.id));
  return (
    <fieldset className="team-picker">
      <legend>{legend}</legend>
      {teams.length ? (
        <>
          {free.length > 0 && (
            <label className="checkbox-label team-picker-all">
              <Checkbox
                checked={all ? true : value.length ? "indeterminate" : false}
                onCheckedChange={() =>
                  onChange(all ? [] : free.map((t) => t.id))
                }
              />
              Todas as equipes
            </label>
          )}
          <div className="team-picker-list">
            {teams.map((t) => {
              const from = fixedFrom.get(t.id);
              return (
                <label className="checkbox-label" key={t.id}>
                  <Checkbox
                    checked={!!from || value.includes(t.id)}
                    disabled={!!from}
                    onCheckedChange={(on) =>
                      onChange(
                        on === true
                          ? [...new Set([...value, t.id])]
                          : value.filter((id) => id !== t.id),
                      )
                    }
                  />
                  {t.name}
                  {from && <small className="team-picker-from">{from}</small>}
                </label>
              );
            })}
          </div>
        </>
      ) : (
        <small>Nenhuma equipe cadastrada ainda.</small>
      )}
      {hint !== "" && (
        <small>
          {hint ??
            (value.length || fixed.length
              ? "Os colaboradores dessas equipes veem todos os produtos, projetos e tarefas deste cliente."
              : "Sem equipe, só administradores e gestores veem este cliente.")}
        </small>
      )}
    </fieldset>
  );
}
