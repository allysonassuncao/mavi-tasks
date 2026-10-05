import * as Popover from "@radix-ui/react-popover";
import {
  ArrowRight,
  AtSign,
  BellRing,
  Brain,
  CalendarClock,
  Check,
  CheckCheck,
  Inbox,
  Flag,
  Mail,
  GraduationCap,
  ListChecks,
  Sparkles,
  Thermometer,
  Trophy,
  Puzzle,
  Radar,
  Wallet,
  Megaphone,
  Lightbulb,
  ServerCrash,
  Route,
} from "lucide-react";
import "./due-rules.css";
import { useState } from "react";
import { navigate } from "./router";
import { Avatar } from "./components";
import type { AppNotification, Member } from "./types";

function when(value: string) {
  const d = new Date(value);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "short",
        // Older ones, on the page, say the year.
        year:
          d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
      });
}

/**
 * The notices, one per row: who did what, and where. Opening one marks it
 * read and opens the task (or the notice's place); the check beside an
 * unread one marks just it read, without opening anything, and the envelope
 * beside a read one marks it unread again. Shared by the top bar's panel
 * and the "Caixa de entrada" page.
 */
export function InboxList({
  items,
  members,
  onOpen,
  onRead,
  onUnread,
}: {
  items: AppNotification[];
  members: Member[];
  onOpen: (n: AppNotification) => void;
  onRead: (n: AppNotification) => void;
  onUnread: (n: AppNotification) => void;
}) {
  return (
    <ul className="inbox-list">
      {items.map((n) => {
        const actor = members.find((m) => m.user_id === n.actor_id);
        return (
          <li key={n.id}>
            <button
              type="button"
              className={n.read_at ? "inbox-item" : "inbox-item unread"}
              onClick={() => onOpen(n)}
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
              ) : n.kind === "tasks_priority" ? (
                <span className="inbox-system due-risk" aria-hidden="true">
                  <Flag size={15} />
                </span>
              ) : n.kind === "radar_report" || n.kind === "radar_alert" ? (
                <span className="inbox-system temperature" aria-hidden="true">
                  <Radar size={15} />
                </span>
              ) : n.kind === "campaign_alert" ? (
                <span className="inbox-system due-risk" aria-hidden="true">
                  <Megaphone size={15} />
                </span>
              ) : n.kind === "campaign_insight" ? (
                <span className="inbox-system" aria-hidden="true">
                  <Lightbulb size={15} />
                </span>
              ) : n.kind === "job_alert" ? (
                <span className="inbox-system due-risk" aria-hidden="true">
                  <ServerCrash size={15} />
                </span>
              ) : n.kind === "tutorial_trail" ? (
                <span className="inbox-system" aria-hidden="true">
                  <Route size={15} />
                </span>
              ) : n.kind === "tutorial" ? (
                <span className="inbox-system" aria-hidden="true">
                  <GraduationCap size={15} />
                </span>
              ) : n.kind === "media_balance" || n.kind === "rq_closing" ? (
                <span className="inbox-system due-risk" aria-hidden="true">
                  <Wallet size={15} />
                </span>
              ) : n.kind === "copilot_lessons" ? (
                <span className="inbox-system" aria-hidden="true">
                  <GraduationCap size={15} />
                </span>
              ) : n.kind === "mavi_lessons" ? (
                <span className="inbox-system" aria-hidden="true">
                  <Brain size={15} />
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
                  person={actor?.user_id}
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
                n.kind === "radar_alert" ||
                n.kind === "media_balance" ||
                n.kind === "rq_closing" ||
                n.kind === "campaign_alert" ||
                n.kind === "campaign_insight" ||
                n.kind === "job_alert" ||
                n.kind === "tutorial_trail" ||
                n.kind === "tutorial" ||
                n.kind === "tasks_assigned" ||
                n.kind === "tasks_priority" ||
                n.kind === "copilot_lessons" ||
                n.kind === "mavi_lessons" ||
                n.kind === "due_risk" ||
                n.kind === "notice" ? (
                  <span className="inbox-line">
                    <strong>{n.task_title}</strong>
                  </span>
                ) : (
                  <span className="inbox-line">
                    <strong data-person={actor?.user_id}>
                      {n.actor_name ?? "Alguém"}
                    </strong>{" "}
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
            {n.read_at ? (
              <button
                type="button"
                className="inbox-read"
                title="Marcar como não lida"
                aria-label="Marcar como não lida"
                onClick={() => onUnread(n)}
              >
                <Mail size={13} />
              </button>
            ) : (
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
  );
}

/** What the inbox is for, when it has nothing (or nothing matches). */
export function InboxEmpty() {
  return (
    <p className="inbox-empty">
      <AtSign size={18} />
      Quando criarem uma tarefa para você, mencionarem você com @, responderem
      um comentário seu, uma tarefa chegar para você validar, a agência
      publicar um aviso no Mural ou um cliente seu esfriar, o aviso aparece
      aqui. Escolha o que receber em Meu perfil › Notificações.
    </p>
  );
}

/**
 * The person's inbox in the top bar, as in ClickUp: the latest notices, 10
 * at a time ("Carregar mais"), and "Ver tudo" for the "Caixa de entrada"
 * page with the filters. The count is of every unread one, not only the
 * loaded ones.
 */
export function NotificationInbox({
  items,
  unread,
  more,
  loadingMore,
  members,
  pageHref,
  onOpen,
  onRead,
  onUnread,
  onReadAll,
  onLoadMore,
}: {
  items: AppNotification[];
  unread: number;
  /** Whether there may be older notices to load. */
  more: boolean;
  loadingMore: boolean;
  members: Member[];
  /** The "Caixa de entrada" page, inside the current company. */
  pageHref: string;
  onOpen: (n: AppNotification) => void;
  onRead: (n: AppNotification) => void;
  onUnread: (n: AppNotification) => void;
  onReadAll: () => void;
  onLoadMore: () => void;
}) {
  const [open, setOpen] = useState(false);
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
          <InboxList
            items={items}
            members={members}
            onOpen={(n) => {
              setOpen(false);
              onOpen(n);
            }}
            onRead={onRead}
            onUnread={onUnread}
          />
        ) : (
          <InboxEmpty />
        )}
        <footer>
          {more && items.length > 0 && (
            <button
              type="button"
              className="text-btn"
              onClick={onLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? "Carregando…" : "Carregar mais"}
            </button>
          )}
          <a
            href={pageHref}
            className="text-btn"
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button)
                return;
              event.preventDefault();
              setOpen(false);
              navigate(pageHref);
            }}
          >
            Ver tudo <ArrowRight size={13} />
          </a>
        </footer>
      </Popover.Content>
    </Popover.Root>
  );
}
