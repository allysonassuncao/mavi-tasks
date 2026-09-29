import { useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Search, X } from "lucide-react";
import { Checkbox } from "./ui";
import { fold } from "./domain";

export type PickOption = { value: string; label: string };

/**
 * A compact multi-select: a button showing what is picked ("Todos os
 * clientes", "Aurora", "3 clientes") and a searchable checklist.
 *
 * The checklist opens in a portal (the open dialog, or the page), so it
 * keeps its own look when the button sits inside a <label> or a form.
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
  const trigger = useRef<HTMLButtonElement>(null);
  // Inside a modal dialog the page is inert: the list opens in the dialog.
  const [host, setHost] = useState<HTMLElement | null>(null);
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
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (next) setHost(trigger.current?.closest("dialog") ?? document.body);
        else setQuery("");
        setOpen(next);
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className={`multi-pick ${value.length ? "active" : ""}`}
          aria-label={`${label}: ${summary}`}
          disabled={disabled}
        >
          <span>{summary}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={host ?? undefined}>
        <Popover.Content className="multi-pick-menu" sideOffset={6} align="start">
          <div className="multi-pick-search">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label={`Buscar em ${label}`}
              placeholder={`Buscar ${noun}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <button
                type="button"
                className="multi-pick-search-clear"
                aria-label="Limpar a busca"
                onClick={() => setQuery("")}
              >
                <X size={13} />
              </button>
            )}
          </div>
          <div className="multi-pick-list" role="group" aria-label={label}>
            {shown.map((o) => {
              const on = value.includes(o.value);
              return (
                <label key={o.value} className={`multi-pick-option${on ? " on" : ""}`}>
                  <Checkbox
                    checked={on}
                    onCheckedChange={(next) =>
                      onChange(
                        next === true
                          ? [...new Set([...value, o.value])]
                          : value.filter((v) => v !== o.value),
                      )
                    }
                  />
                  <span title={o.label}>{o.label}</span>
                </label>
              );
            })}
            {!shown.length && <p className="multi-pick-empty">Nada encontrado.</p>}
          </div>
          <footer className="multi-pick-foot">
            <small>
              {value.length
                ? `${value.length} ${value.length === 1 ? "selecionada" : "selecionadas"}`
                : allLabel}
            </small>
            {value.length > 0 && (
              <button type="button" className="text-btn" onClick={() => onChange([])}>
                <X size={13} /> Limpar
              </button>
            )}
          </footer>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
