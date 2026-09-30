import * as Popover from "@radix-ui/react-popover";
import {
  AtSign,
  BellRing,
  CalendarClock,
  Check,
  CheckCheck,
  Inbox,
  ListChecks,
  Sparkles,
  Thermometer,
  Trophy,
  Puzzle,
  Radar,
} from "lucide-react";
import "./due-rules.css";
import { useState } from "react";
import { Avatar } from "./components";
import type { AppNotification, Member } from "./types";

function when(value: string) {
  const d = new Date(value);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

/**
 * The person's inbox, as in ClickUp: who mentioned or replied to them, and
 * where, plus notices of the Social Leads (a plan the AI finished). Opening
 * one marks it read and opens the task (or the notice's place); the check
 * beside an unread one marks just it read, without opening anything.
 */
export function NotificationInbox({
  items,
  members,
  onOpen,
  onRead,
  onReadAll,
}: {
  items: AppNotification[];
  members: Member[];
  onOpen: (n: AppNotification) => void;
  onRead: (n: AppNotification) => void;
  onReadAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unread = items.filter((n) => !n.read_at).length;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="inbox-toggle"
          aria-label={
            unread
              ? `Caixa de entrada: ${unread} não lida${unread > 1 ? "s" : ""}`
              : "Caixa de entrada"
          }
          title="Caixa de entrada"
        >
          <Inbox size={17} />
          {unread > 0 && <span>{unread > 9 ? "9+" : unread}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="inbox-panel"
        align="end"
        sideOffset={8}
        collisionPadding={10}
      >
        <header>
          <strong>Caixa de entrada</strong>
          {unread > 0 && (
            <button type="button" className="text-btn" onClick={onReadAll}>
              <CheckCheck size={14} /> Marcar todas como lidas
            </button>
          )}
        </header>
        {items.length ? (
          <ul>
            {items.map((n) => {
              const actor = members.find((m) => m.user_id === n.actor_id);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    className={n.read_at ? "inbox-item" : "inbox-item unread"}
                    onClick={() => {
                      setOpen(false);
                      onOpen(n);
                    }}
                  >
                    {n.kind === "notice" ? (
                      <span className="inbox-system notice" aria-hidden="true">
                        <BellRing size={15} />
                      </span>
                    ) : n.kind === "success_case" ? (
                      <span className="inbox-system" aria-hidden="true">
                        <Trophy size={15} />
                      </span>
                    ) : n.kind === "temperature" ? (
                      <span className="inbox-system temperature" aria-hidden="true">
                        <Thermometer size={15} />
                      </span>
                    ) : n.kind === "due_risk" ? (
                      <span className="inbox-system due-risk" aria-hidden="true">
                        <CalendarClock size={15} />
                      </span>
                    ) : n.kind === "tasks_assigned" ? (
                      <span className="inbox-system" aria-hidden="true">
                        <ListChecks size={15} />
                      </span>
                    ) : n.kind === "radar_report" ? (
                      <span className="inbox-system temperature" aria-hidden="true">
                        <Radar size={15} />
                      </span>
                    ) : n.kind === "ai_skill" ? (
                      <span className="inbox-system" aria-hidden="true">
                        <Puzzle size={15} />
                      </span>
                    ) : n.kind === "social_leads" || n.kind === "ai_share" || n.kind === "ai_answer" ? (
                      <span className="inbox-system" aria-hidden="true">
                        <Sparkles size={15} />
                      </span>
                    ) : (
                      <Avatar
                        name={n.actor_name ?? "?"}
                        src={actor?.avatar_url}
                        size="small"
                      />
                    )}
                    <span>
                      {n.kind === "social_leads" ||
                      n.kind === "ai_share" ||
                      n.kind === "ai_skill" ||
                      n.kind === "ai_answer" ||
                      n.kind === "success_case" ||
                      n.kind === "temperature" ||
                      n.kind === "radar_report" ||
                      n.kind === "tasks_assigned" ||
                      n.kind === "due_risk" ||
                      n.kind === "notice" ? (
                        <span className="inbox-line">
                          <strong>{n.task_title}</strong>
                        </span>
                      ) : (
                        <span className="inbox-line">
                          <strong>{n.actor_name ?? "Alguém"}</strong>{" "}
                          {n.headline
                            ? `${n.headline}:`
                            : n.kind === "assigned"
                            ? "criou uma tarefa para você:"
                            : n.kind === "reply"
                              ? "respondeu um comentário em"
                              : "mencionou você em"}{" "}
                          <strong>{n.task_title}</strong>
                        </span>
                      )}
                      {n.excerpt && <small>{n.excerpt}</small>}
                    </span>
                    <time dateTime={n.created_at}>{when(n.created_at)}</time>
                  </button>
                  {!n.read_at && (
                    <button
                      type="button"
                      className="inbox-read"
                      title="Marcar como lida"
                      aria-label="Marcar como lida"
                      onClick={() => onRead(n)}
                    >
                      <Check size={13} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="inbox-empty">
            <AtSign size={18} />
            Quando criarem uma tarefa para você, mencionarem você com @,
            responderem um comentário seu, uma tarefa chegar para você validar,
            a agência publicar um aviso no Mural ou um cliente seu esfriar, o
            aviso aparece aqui. Escolha o que receber em Meu perfil ›
            Notificações.
          </p>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}
