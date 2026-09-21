import type { CSSProperties } from "react";
import { ChevronLeft, ChevronRight, CalendarDays } from "lucide-react";
import { Button, Input } from "./ui";
import { Empty } from "./components";
import {
  calendarDate,
  calendarDays,
  monthRange,
  taskStart,
  overlaps,
  ganttPlacement,
  addDays,
} from "./schedule";
import { statuses, type Task } from "./types";
import { dateKey, namesFrom, dateLabel, type NameLookup } from "./domain";
export function ScheduleNavigation({
  month,
  onChange,
}: {
  month: string;
  onChange: (month: string) => void;
}) {
  function move(n: number) {
    const d = calendarDate(month + "-01");
    d.setMonth(d.getMonth() + n);
    onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  return (
    <div className="schedule-navigation">
      <div>
        <Button
          className="icon-btn"
          aria-label="Mês anterior"
          onClick={() => move(-1)}
        >
          <ChevronLeft size={18} />
        </Button>
        <Input
          type="month"
          aria-label="Mês da visualização"
          value={month}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          className="icon-btn"
          aria-label="Próximo mês"
          onClick={() => move(1)}
        >
          <ChevronRight size={18} />
        </Button>
      </div>
      <Button
        className="btn secondary"
        onClick={() => onChange(dateKey().slice(0, 7))}
      >
        <CalendarDays size={16} /> Hoje
      </Button>
    </div>
  );
}
export function TaskSchedule({
  view,
  month,
  tasks,
  lookup,
  onSelect,
}: {
  view: "calendar" | "gantt";
  month: string;
  tasks: Task[];
  lookup: NameLookup;
  onSelect: (id: string) => void;
}) {
  const today = dateKey();
  const range = monthRange(month);
  const dates = calendarDays(month);
  if (view === "calendar")
    return (
      <div className="calendar-scroll">
        <div
          className="task-calendar"
          role="table"
          aria-label="Calendário de prazos"
        >
          <div className="calendar-weekdays" role="row">
            {["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((d) => (
              <div role="columnheader" key={d}>
                {d}
              </div>
            ))}
          </div>
          {Array.from({ length: dates.length / 7 }, (_, week) => (
            <div className="calendar-week" role="row" key={week}>
              {dates.slice(week * 7, week * 7 + 7).map((date) => (
                <div
                  role="cell"
                  className={`calendar-day ${date.slice(0, 7) !== month ? "outside" : ""} ${date === today ? "today" : ""}`}
                  key={date}
                >
                  <time dateTime={date}>{Number(date.slice(8))}</time>
                  <div>
                    {tasks
                      .filter((t) => t.due_date === date)
                      .map((t) => (
                        <button
                          type="button"
                          className="calendar-task"
                          key={t.id}
                          style={{ borderLeftColor: statuses[t.status].color }}
                          onClick={() => onSelect(t.id)}
                          title={`${t.title} · ${namesFrom(lookup, t).client?.name ?? ""}`}
                        >
                          <strong>{t.title}</strong>
                          <small>{namesFrom(lookup, t).client?.name}</small>
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  const days: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) days.push(d);
  const visible = tasks.filter((t) => overlaps(t, range.start, range.end));
  return (
    <>
      <p className="schedule-note">
        Barras representam o início planejado até o prazo. Sem início planejado,
        usamos a data de criação limitada ao prazo. Clique para abrir a tarefa.
      </p>
      {visible.length ? (
        <div
          className="gantt-scroll"
          role="region"
          aria-label="Cronograma Gantt"
          tabIndex={0}
        >
          <div className="gantt" style={{ minWidth: 260 + days.length * 34 }}>
            <div className="gantt-header">
              <strong>Tarefa</strong>
              <div
                className="gantt-days"
                style={{ gridTemplateColumns: `repeat(${days.length},1fr)` }}
              >
                {days.map((d) => (
                  <time
                    key={d}
                    className={d === today ? "today" : ""}
                    dateTime={d}
                  >
                    {Number(d.slice(8))}
                  </time>
                ))}
              </div>
            </div>
            {visible.map((t) => {
              const pos = ganttPlacement(t, days);
              return (
                <div className="gantt-row" key={t.id}>
                  <button
                    className="gantt-label"
                    onClick={() => onSelect(t.id)}
                  >
                    <strong>{t.title}</strong>
                    <small>
                      {dateLabel(taskStart(t))} — {dateLabel(t.due_date)}
                    </small>
                  </button>
                  <div
                    className="gantt-track"
                    style={
                      {
                        gridTemplateColumns: `repeat(${days.length},1fr)`,
                        "--gantt-columns": days.length,
                      } as CSSProperties
                    }
                  >
                    <button
                      className="gantt-bar"
                      style={{
                        gridColumn: `${pos.start} / span ${pos.span}`,
                        background: statuses[t.status].color,
                      }}
                      onClick={() => onSelect(t.id)}
                      aria-label={`${t.title}, ${dateLabel(taskStart(t))} até ${dateLabel(t.due_date)}`}
                    >
                      {t.title}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <Empty
          title="Sem tarefas neste período"
          body="Escolha outro mês ou ajuste os filtros."
        />
      )}
    </>
  );
}
