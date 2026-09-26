import { useId, useState, type ComponentProps, type ChangeEvent } from "react";
import * as Popover from "@radix-ui/react-popover";
import { DayPicker, type ChevronProps } from "react-day-picker";
import { ptBR } from "react-day-picker/locale";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Clock3,
  X,
} from "lucide-react";
import "react-day-picker/style.css";
const dateString = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function CalendarChevron({ orientation, size, className }: ChevronProps) {
  const Icon =
    orientation === "left"
      ? ChevronLeft
      : orientation === "right"
        ? ChevronRight
        : orientation === "up"
          ? ChevronUp
          : ChevronDown;
  return <Icon size={size ?? 18} className={className} />;
}
export function DateInput({
  value,
  defaultValue,
  onChange,
  name,
  required,
  disabled,
  type,
  id,
  "aria-label": ariaLabel,
  min,
  max,
  placeholder,
}: ComponentProps<"input">) {
  const [internal, setInternal] = useState(String(defaultValue ?? ""));
  const [open, setOpen] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const current = String(value ?? internal);
  const [time, setTime] = useState(current.slice(11, 16) || "09:00");
  const [year, setYear] = useState(
    Number(current.slice(0, 4)) || new Date().getFullYear(),
  );
  const generatedId = useId();
  const selected = current
    ? new Date(
        current.slice(0, 10) +
          (type === "month" ? "-01T12:00:00" : "T12:00:00"),
      )
    : undefined;
  const validDate =
    selected && !Number.isNaN(selected.getTime()) ? selected : undefined;
  function change(next: string) {
    setInternal(next);
    setInvalid(false);
    onChange?.({
      target: { value: next, name },
      currentTarget: { value: next, name },
    } as ChangeEvent<HTMLInputElement>);
  }
  const label =
    current && validDate
      ? (type === "month"
          ? validDate.toLocaleDateString("pt-BR", {
              month: "long",
              year: "numeric",
            })
          : validDate.toLocaleDateString("pt-BR")) +
        (type === "datetime-local" ? ` às ${current.slice(11, 16)}` : "")
      : (placeholder ?? "Selecionar data");
  return (
    <span className="date-control">
      <input
        className="date-validation"
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        name={name}
        value={current}
        pattern={
          type === "datetime-local"
            ? "[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]"
            : type === "month"
              ? "[0-9]{4}-[0-9]{2}"
              : "[0-9]{4}-[0-9]{2}-[0-9]{2}"
        }
        required={required}
        disabled={disabled}
        onChange={() => {}}
        onInvalid={(e) => {
          e.preventDefault();
          setInvalid(true);
          setOpen(true);
        }}
      />
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          if (next && current) setYear(Number(current.slice(0, 4)));
          setOpen(next);
        }}
      >
        <Popover.Trigger asChild>
          <button
            id={id ?? generatedId}
            type="button"
            disabled={disabled}
            className="ui-date"
            data-empty={!current || undefined}
            aria-label={
              ariaLabel ??
              `${({ due: "Prazo", start_date: "Início planejado", start: "Início do período", end: "Fim do período" } as Record<string, string>)[name ?? ""] ?? "Data"}: ${label}`
            }
            aria-invalid={invalid || undefined}
          >
            <CalendarDays size={17} />
            <span>{label}</span>
            <ChevronDown size={15} />
          </button>
        </Popover.Trigger>
        <Popover.Content
          className="date-popover"
          sideOffset={6}
          align="start"
          collisionPadding={10}
        >
          {type === "month" ? (
            <div className="month-picker">
              <div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Ano anterior"
                  onClick={() => setYear((v) => v - 1)}
                >
                  <ChevronLeft size={18} />
                </button>
                <strong>{year}</strong>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Próximo ano"
                  onClick={() => setYear((v) => v + 1)}
                >
                  <ChevronRight size={18} />
                </button>
              </div>
              <section>
                {Array.from({ length: 12 }, (_, i) => (
                  <button
                    type="button"
                    key={i}
                    className={`month-option ${current === `${year}-${String(i + 1).padStart(2, "0")}` ? "selected" : ""}`}
                    onClick={() => {
                      change(`${year}-${String(i + 1).padStart(2, "0")}`);
                      setOpen(false);
                    }}
                  >
                    {new Date(year, i, 1).toLocaleDateString("pt-BR", {
                      month: "short",
                    })}
                  </button>
                ))}
              </section>
            </div>
          ) : (
            <DayPicker
              mode="single"
              locale={ptBR}
              selected={validDate}
              defaultMonth={validDate}
              onSelect={(date) => {
                change(
                  date
                    ? dateString(date) +
                        (type === "datetime-local" ? `T${time}` : "")
                    : "",
                );
                if (type !== "datetime-local") setOpen(false);
              }}
              components={{ Chevron: CalendarChevron }}
              disabled={[
                ...(min
                  ? [
                      {
                        before: new Date(
                          String(min).slice(0, 10) + "T00:00:00",
                        ),
                      },
                    ]
                  : []),
                ...(max
                  ? [
                      {
                        after: new Date(String(max).slice(0, 10) + "T23:59:59"),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          {type === "datetime-local" && (
            <div className="date-time-row">
              <Clock3 size={17} />
              <input
                aria-label="Horário (HH:mm)"
                type="text"
                inputMode="numeric"
                value={time}
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                maxLength={5}
                onChange={(e) => {
                  setTime(e.target.value);
                  if (current)
                    change(current.slice(0, 10) + "T" + e.target.value);
                }}
              />
              <button
                className="text-btn"
                type="button"
                onClick={() => setOpen(false)}
              >
                Concluir
              </button>
            </div>
          )}
          {!required && (
            <button
              className="text-btn date-clear"
              type="button"
              onClick={() => {
                change("");
                setOpen(false);
              }}
            >
              <X size={14} /> Limpar data
            </button>
          )}
        </Popover.Content>
      </Popover.Root>
      {invalid && <small role="alert">Selecione data e horário válidos.</small>}
    </span>
  );
}
