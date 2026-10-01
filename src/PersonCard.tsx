import * as Popover from "@radix-ui/react-popover";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  CalendarPlus,
  Check,
  Copy,
  History as HistoryIcon,
  ListChecks,
  MessageCircle,
  Palmtree,
  Pencil,
  Plus,
  UserRound,
} from "lucide-react";
import { Avatar } from "./components";
import { PresenceDot } from "./OnlineMembers";
import type { PresenceMap } from "./presence";
import {
  PERSON_SELECTOR,
  personAbsence,
  personOf,
  personTaskSummary,
  personTeams,
  shortDate,
  whatsappUrl,
  type PersonTaskSummary,
} from "./person";
import { navigate, pageUrl, useLocation, type Page } from "./router";
import { loadMemberPhones, phoneLabel } from "./temperature";
import { absenceKinds, type Member, type Role, type Snapshot } from "./types";
import "./person-card.css";

export const ROLE_NAMES: Record<Role, string> = {
  admin: "Administrador",
  manager: "Gestor",
  member: "Colaborador",
};

/** What the person's balloon and page need from the app. */
export type PersonEnv = {
  data: Snapshot;
  company: string;
  companyPath: string;
  /** Who is signed in (their own name opens nothing). */
  user: string;
  isAdmin: boolean;
  isLeader: boolean;
  presence: PresenceMap;
  today: string;
  canOpen: (page: Page) => boolean;
  onNewTask: (assignee: string) => void;
  onEdit: (member: Member) => void;
  onLogs: (member: Member) => void;
  notify: (message: string) => void;
};

export function personUrl(user: string, companyPath: string) {
  return `${pageUrl("person", companyPath)}/${encodeURIComponent(user)}`;
}
export function personTasksUrl(user: string, companyPath: string, status = "") {
  const q = new URLSearchParams({ resp: user });
  if (status) q.set("situacao", status);
  return `${pageUrl("search", companyPath)}?${q}`;
}
export function personMeetingUrl(user: string, companyPath: string) {
  return `${pageUrl("agenda", companyPath)}?convidar=${encodeURIComponent(user)}`;
}

/** A link inside the app: a plain click navigates without reloading. */
export function follow(
  event: MouseEvent<HTMLAnchorElement>,
  then?: () => void,
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(event.currentTarget.getAttribute("href") ?? "/");
  then?.();
}

/** "Online", "Ausente" or nothing, with since when. */
export function presenceText(presence: PresenceMap, user: string) {
  const p = presence.get(user);
  if (!p) return "";
  const time = new Date(p.since).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${p.state === "online" ? "Online" : "Ausente"} · desde ${time}`;
}

/** The away line ("De férias até 12/10", "Folga a partir de 20/10"). */
export function AbsenceLine({
  env,
  member,
}: {
  env: PersonEnv;
  member: Member;
}) {
  const away = personAbsence(env.data.absences, member.user_id, env.today);
  if (!away) return null;
  const kind = absenceKinds[away.absence.kind];
  const one = away.absence.starts_on === away.absence.ends_on;
  return (
    <p className={`person-away ${away.now ? "now" : ""}`}>
      <Palmtree size={14} aria-hidden="true" />
      {away.now
        ? one
          ? `${kind} hoje`
          : `${kind} até ${shortDate(away.absence.ends_on)}`
        : one
          ? `${kind} em ${shortDate(away.absence.starts_on)}`
          : `${kind} de ${shortDate(away.absence.starts_on)} a ${shortDate(away.absence.ends_on)}`}
    </p>
  );
}

/** The person's numbers as responsible (only what the viewer sees). */
export function useTaskSummary(env: PersonEnv, user: string, on = true) {
  const [summary, setSummary] = useState<PersonTaskSummary | null | "loading">(
    "loading",
  );
  useEffect(() => {
    if (!on) return;
    let alive = true;
    setSummary("loading");
    void personTaskSummary(env.company, user, env.data).then(
      (s) => alive && setSummary(s),
    );
    return () => {
      alive = false;
    };
    // env.data only matters in the demo, where it is read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.company, user, on]);
  return summary;
}

/** The WhatsApp numbers, for leaders (public.member_phones allows them). */
export function usePhones(env: PersonEnv, user: string, on = true) {
  const [phones, setPhones] = useState<string[]>([]);
  useEffect(() => {
    if (!on || !env.isLeader) return;
    let alive = true;
    setPhones([]);
    loadMemberPhones(env.company, user)
      .then((list) => alive && setPhones(list ?? []))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [env.company, env.isLeader, user, on]);
  return phones;
}

function CopyEmail({ email, env }: { email: string; env: PersonEnv }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="person-action"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(email);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          env.notify("Não foi possível copiar o e-mail.");
        }
      }}
    >
      {done ? <Check size={15} /> : <Copy size={15} />}
      {done ? "Copiado" : "Copiar e-mail"}
    </button>
  );
}

/**
 * The shortcuts to the person, the same in the balloon and on their page:
 * profile, tasks, a new task for them, a meeting, contact and — for leaders,
 * as in Pessoas do espaço — their registration and access logs.
 */
export function PersonActions({
  env,
  member,
  phones,
  profile = true,
  onDone,
}: {
  env: PersonEnv;
  member: Member;
  phones: string[];
  /** The "Ver perfil" link (not on the profile itself). */
  profile?: boolean;
  /** After a shortcut is used (the balloon closes). */
  onDone?: () => void;
}) {
  const id = member.user_id;
  const path = env.companyPath;
  const manages = env.isLeader && (env.isAdmin || member.role !== "admin");
  const link = (href: string, icon: ReactNode, label: string) => (
    <a className="person-action" href={href} onClick={(e) => follow(e, onDone)}>
      {icon}
      {label}
    </a>
  );
  return (
    <div className="person-actions">
      {profile &&
        link(personUrl(id, path), <UserRound size={15} />, "Ver perfil")}
      {env.canOpen("search") &&
        link(personTasksUrl(id, path), <ListChecks size={15} />, "Ver tarefas")}
      {member.active && env.canOpen("tasks") && (
        <button
          type="button"
          className="person-action"
          onClick={() => {
            onDone?.();
            env.onNewTask(id);
          }}
        >
          <Plus size={15} /> Nova tarefa
        </button>
      )}
      {member.active &&
        member.email &&
        env.canOpen("agenda") &&
        link(
          personMeetingUrl(id, path),
          <CalendarPlus size={15} />,
          "Agendar reunião",
        )}
      {member.email && <CopyEmail email={member.email} env={env} />}
      {phones[0] && (
        <a
          className="person-action"
          href={whatsappUrl(phones[0])}
          target="_blank"
          rel="noopener noreferrer"
          title={phoneLabel(phones[0])}
          onClick={onDone}
        >
          <MessageCircle size={15} /> WhatsApp
        </a>
      )}
      {manages && (
        <button
          type="button"
          className="person-action"
          onClick={() => {
            onDone?.();
            env.onEdit(member);
          }}
        >
          <Pencil size={15} /> Editar cadastro
        </button>
      )}
      {manages && (
        <button
          type="button"
          className="person-action"
          onClick={() => {
            onDone?.();
            env.onLogs(member);
          }}
        >
          <HistoryIcon size={15} /> Logs de acesso
        </button>
      )}
    </div>
  );
}

/** "3 em aberto · 1 atrasada · 2 em validação". */
export function summaryText(s: PersonTaskSummary) {
  const parts = [`${s.open} em aberto`];
  if (s.late) parts.push(`${s.late} atrasada${s.late > 1 ? "s" : ""}`);
  if (s.review) parts.push(`${s.review} em validação`);
  return parts.join(" · ");
}

function PersonCardBody({
  env,
  member,
  onDone,
}: {
  env: PersonEnv;
  member: Member;
  onDone: () => void;
}) {
  const teams = personTeams(env.data, member.user_id);
  const summary = useTaskSummary(env, member.user_id, env.isLeader);
  const phones = usePhones(env, member.user_id);
  const presence = presenceText(env.presence, member.user_id);
  return (
    <>
      <header className="person-card-head">
        <span className="online-avatar">
          <Avatar name={member.name} src={member.avatar_url} size="large" />
          <PresenceDot state={env.presence.get(member.user_id)?.state} />
        </span>
        <div>
          <a
            className="person-card-name"
            href={personUrl(member.user_id, env.companyPath)}
            onClick={(e) => follow(e, onDone)}
          >
            {member.name}
          </a>
          <span className="person-card-meta">
            <span className="role-tag">{ROLE_NAMES[member.role]}</span>
            {!member.active && <span className="person-inactive">Inativo</span>}
            {presence && <small>{presence}</small>}
          </span>
        </div>
      </header>
      <AbsenceLine env={env} member={member} />
      <dl className="person-card-facts">
        {member.email && (
          <>
            <dt>E-mail</dt>
            <dd>{member.email}</dd>
          </>
        )}
        <dt>Equipes</dt>
        <dd>
          {teams.length ? (
            <span className="person-teams">
              {teams.map((t) => (
                <span key={t.id} className="person-team">
                  {t.name}
                  {t.supervisor && <small> · supervisor</small>}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">Nenhuma</span>
          )}
        </dd>
        {env.isLeader && summary !== null && (
          <>
            <dt>Tarefas</dt>
            <dd className={summary !== "loading" && summary.late ? "late" : ""}>
              {summary === "loading" ? "…" : summaryText(summary)}
            </dd>
          </>
        )}
        {phones[0] && (
          <>
            <dt>WhatsApp</dt>
            <dd>{phones.map(phoneLabel).join(", ")}</dd>
          </>
        )}
      </dl>
      <PersonActions
        env={env}
        member={member}
        phones={phones}
        onDone={onDone}
      />
    </>
  );
}

const PersonEnvContext = createContext<PersonEnv | null>(null);
/** For the person's page and anything else that wants the app's shortcuts. */
export const usePersonEnv = () => useContext(PersonEnvContext);

// A tap inside one of these does what the control does, not open a balloon.
const INTERACTIVE =
  "button, a, input, select, textarea, label, summary, [role='button'], [role='menuitem'], [role='option'], [role='combobox']";
const OPEN_DELAY = 450;
const SWITCH_DELAY = 150;
const CLOSE_DELAY = 220;

type Side = "bottom" | "top" | "right" | "left";
type Open = { id: string; anchor: HTMLElement; host: HTMLElement; side: Side };
// About the balloon's height and width: below the name when it fits, else
// above, else beside it (it scrolls inside when even that is short).
const CARD_HEIGHT = 380;
const CARD_WIDTH = 340;
function sideFor(anchor: HTMLElement): Side {
  const r = anchor.getBoundingClientRect();
  if (window.innerHeight - r.bottom >= CARD_HEIGHT) return "bottom";
  if (r.top >= CARD_HEIGHT) return "top";
  if (window.innerWidth - r.right >= CARD_WIDTH) return "right";
  if (r.left >= CARD_WIDTH) return "left";
  return window.innerHeight - r.bottom >= r.top ? "bottom" : "top";
}

/**
 * One balloon for the whole app. Pointing at a photo or name of another
 * person (data-person, or a mention in a text) opens it after a moment;
 * leaving both the name and the balloon closes it. Without a mouse, a tap
 * opens it — except on a name inside a button or link, where the tap keeps
 * doing what it did. Nothing is mounted per name: the long lists stay light.
 */
export function PersonHoverCards({
  env,
  children,
}: {
  env: PersonEnv;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  const envRef = useRef(env);
  envRef.current = env;
  const openRef = useRef<Open | null>(null);
  openRef.current = open;
  const card = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  anchorRef.current = open?.anchor ?? null;
  const timers = useRef({ open: 0, close: 0 });
  const location = useLocation();

  const clear = () => {
    window.clearTimeout(timers.current.open);
    window.clearTimeout(timers.current.close);
  };
  const hide = (delay = CLOSE_DELAY) => {
    clear();
    timers.current.close = window.setTimeout(() => setOpen(null), delay);
  };
  const close = () => {
    clear();
    setOpen(null);
  };

  useEffect(close, [location]);

  useEffect(() => {
    let pointer = "mouse";
    function hit(target: EventTarget | null): [HTMLElement, string] | null {
      const el = (target as Element | null)?.closest?.(
        PERSON_SELECTOR,
      ) as HTMLElement | null;
      if (!el || el.closest("[contenteditable='true'], .person-card"))
        return null;
      const id = personOf(el);
      const { user, data } = envRef.current;
      if (!id || id === user || !data.members.some((m) => m.user_id === id))
        return null;
      return [el, id];
    }
    const show = (anchor: HTMLElement, id: string) =>
      setOpen({
        id,
        anchor,
        host: anchor.closest("dialog") ?? document.body,
        side: sideFor(anchor),
      });
    function over(e: PointerEvent) {
      pointer = e.pointerType;
      if (e.pointerType === "touch") return;
      const found = hit(e.target);
      if (!found) return;
      const [anchor, id] = found;
      clear();
      if (anchorRef.current === anchor) return;
      timers.current.open = window.setTimeout(
        () => anchor.isConnected && show(anchor, id),
        openRef.current ? SWITCH_DELAY : OPEN_DELAY,
      );
    }
    function out(e: PointerEvent) {
      if (e.pointerType === "touch") return;
      const found = hit(e.target);
      if (!found) return;
      const to = e.relatedTarget as Node | null;
      if (to && (found[0].contains(to) || card.current?.contains(to))) return;
      if (openRef.current) hide();
      else clear();
    }
    function down(e: PointerEvent) {
      pointer = e.pointerType;
    }
    function click(e: globalThis.MouseEvent) {
      if (pointer !== "touch") return;
      const found = hit(e.target);
      if (!found) return;
      const [anchor, id] = found;
      if (
        anchor.matches(INTERACTIVE) ||
        anchor.parentElement?.closest(INTERACTIVE)
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      clear();
      show(anchor, id);
    }
    // Scrolling moves the name away from its balloon: it closes.
    function scroll(e: Event) {
      if (!openRef.current) return;
      if (card.current?.contains(e.target as Node)) return;
      clear();
      setOpen(null);
    }
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("click", click, true);
    window.addEventListener("scroll", scroll, { capture: true, passive: true });
    return () => {
      clear();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("click", click, true);
      window.removeEventListener("scroll", scroll, { capture: true });
    };
  }, []);

  const member = open
    ? env.data.members.find((m) => m.user_id === open.id)
    : undefined;
  return (
    <PersonEnvContext.Provider value={env}>
      {children}
      <Popover.Root
        open={!!(open && member)}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <Popover.Anchor virtualRef={anchorRef} />
        {open && member && (
          <Popover.Portal container={open.host}>
            <Popover.Content
              ref={card}
              key={open.id}
              className="person-card"
              side={open.side}
              align={
                open.side === "bottom" || open.side === "top"
                  ? "start"
                  : "center"
              }
              sideOffset={6}
              collisionPadding={12}
              aria-label={`Atalhos de ${member.name}`}
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
              onPointerEnter={(e) => e.pointerType !== "touch" && clear()}
              onPointerLeave={(e) => {
                if (e.pointerType === "touch") return;
                const to = e.relatedTarget as Node | null;
                if (to && open.anchor.contains(to)) return;
                hide();
              }}
              // A click on a plain name keeps its balloon; on a name inside a
              // button, the button's own action takes over.
              onPointerDownOutside={(e) => {
                if (
                  open.anchor.contains(e.target as Node) &&
                  !open.anchor.closest(INTERACTIVE)
                )
                  e.preventDefault();
              }}
            >
              <PersonCardBody env={env} member={member} onDone={close} />
            </Popover.Content>
          </Popover.Portal>
        )}
      </Popover.Root>
    </PersonEnvContext.Provider>
  );
}
