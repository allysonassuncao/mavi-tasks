import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Search, X } from "lucide-react";
import { Checkbox } from "./ui";
import { fold } from "./domain";

export type PickOption = { value: string; label: string };

/**
 * A compact multi-select: a button showing what is picked ("Todos os
 * clientes", "Aurora", "3 clientes") and a searchable checklist.
 */
export function MultiPick({
  label,
  allLabel,
  noun,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string;
  /** What an empty selection means, e.g. "Todos os clientes". */
  allLabel: string;
  /** Plural shown for several picks, e.g. "clientes". */
  noun: string;
  options: PickOption[];
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return options.filter((o) => fold(o.label).includes(q));
  }, [options, query]);
  const summary = !value.length
    ? allLabel
    : value.length === 1
      ? (options.find((o) => o.value === value[0])?.label ?? `1 ${noun}`)
      : `${value.length} ${noun}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`multi-pick ${value.length ? "active" : ""}`}
          aria-label={`${label}: ${summary}`}
          disabled={disabled}
        >
          <span>{summary}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Content className="multi-pick-menu" sideOffset={6} align="start">
        <div className="multi-pick-search">
          <Search size={14} aria-hidden="true" />
          <input
            aria-label={`Buscar em ${label}`}
            placeholder="Buscar"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="multi-pick-list" role="group" aria-label={label}>
          {shown.map((o) => (
            <label key={o.value} className="checkbox-label">
              <Checkbox
                checked={value.includes(o.value)}
                onCheckedChange={(on) =>
                  onChange(
                    on === true
                      ? [...new Set([...value, o.value])]
                      : value.filter((v) => v !== o.value),
                  )
                }
              />
              {o.label}
            </label>
          ))}
          {!shown.length && <small className="muted">Nada encontrado.</small>}
        </div>
        {value.length > 0 && (
          <button
            type="button"
            className="text-btn multi-pick-clear"
            onClick={() => onChange([])}
          >
            <X size={13} /> Limpar ({allLabel.toLowerCase()})
          </button>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}
