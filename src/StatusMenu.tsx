import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown } from "lucide-react";
import { useRef, useState } from "react";
import { shortSpan } from "./domain";
import { statuses, type Status } from "./types";

/** A status the menu offers; `disabled` holds why it can't be picked. */
export interface StatusChoice {
  status: Status;
  disabled?: string;
}

/** The status as a solid pill, as in ClickUp. */
export function StatusPill({ status }: { status: Status }) {
  return (
    <span
      className="status-pill"
      style={{ background: statuses[status].color }}
    >
      {statuses[status].label}
    </span>
  );
}

/**
 * The task's status, and the menu to move it: every working status in any
 * order, then Entregue apart. Each row shows how long the task has spent in
 * that status. Picking the current status keeps it and only reassigns.
 */
export function StatusMenu({
  current,
  choices,
  durations,
  onPick,
}: {
  current: Status;
  choices: StatusChoice[];
  durations: Partial<Record<Status, number>>;
  onPick: (status: Status) => void;
}) {
  const [open, setOpen] = useState(false);
  // After a pick, focus goes to the form that opens, not back to the pill.
  const picked = useRef(false);
  const usable = choices.some((c) => !c.disabled);
  if (!usable) return <StatusPill status={current} />;
  const row = (c: StatusChoice) => {
    const spent = durations[c.status];
    return (
      <button
        key={c.status}
        type="button"
        role="menuitemradio"
        aria-checked={c.status === current}
        className={`status-option${c.status === current ? " current" : ""}`}
        disabled={!!c.disabled}
        title={c.disabled}
        onClick={() => {
          picked.current = true;
          setOpen(false);
          onPick(c.status);
        }}
      >
        <i style={{ background: statuses[c.status].color }} />
        <span>{statuses[c.status].label}</span>
        {spent ? <small>{shortSpan(spent)}</small> : null}
        {c.status === current && <Check size={14} />}
      </button>
    );
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="status-pill status-trigger"
          style={{ background: statuses[current].color }}
          aria-label={`Status: ${statuses[current].label}. Mudar status`}
        >
          {statuses[current].label}
          <ChevronDown size={14} />
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="status-menu"
        role="menu"
        sideOffset={6}
        align="start"
        collisionPadding={10}
        onCloseAutoFocus={(e) => {
          if (picked.current) e.preventDefault();
          picked.current = false;
        }}
      >
        <p>Ativos</p>
        {choices.filter((c) => c.status !== "done").map(row)}
        <p>Fechado</p>
        {choices.filter((c) => c.status === "done").map(row)}
      </Popover.Content>
    </Popover.Root>
  );
}
