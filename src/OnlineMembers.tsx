import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { Avatar } from "./components";
import { presentMembers, type PresenceMap } from "./presence";
import type { Member } from "./types";

function since(value: string) {
  const d = new Date(value);
  const today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return today
    ? `desde ${time}`
    : `desde ${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}, ${time}`;
}

/** A presence dot to sit on an avatar: green online, amber away. */
export function PresenceDot({ state }: { state?: "online" | "away" }) {
  if (!state) return null;
  return (
    <i
      className={`presence-dot ${state}`}
      title={state === "online" ? "Online" : "Ausente"}
      aria-label={state === "online" ? "Online" : "Ausente"}
      role="img"
    />
  );
}

/**
 * Who from the company has the app open right now, in the top bar: the
 * count, a few faces, and the full list on click.
 */
export function OnlineMembers({
  members,
  presence,
  user,
  demo,
}: {
  members: Member[];
  presence: PresenceMap;
  user: string;
  demo: boolean;
}) {
  const [open, setOpen] = useState(false);
  const present = presentMembers(members, presence);
  const online = present.filter((p) => p.state === "online").length;
  const faces = present.filter((p) => p.member.user_id !== user).slice(0, 3);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="online-toggle"
          aria-label={`Pessoas online: ${online}`}
          title="Quem está usando o workspace agora"
        >
          <span className="online-faces" aria-hidden="true">
            {faces.map((p) => (
              <Avatar
                key={p.member.user_id}
                name={p.member.name}
                src={p.member.avatar_url}
                size="small"
              />
            ))}
          </span>
          <span className="online-count">
            <i className="presence-dot online" aria-hidden="true" />
            {online} online
          </span>
          {demo && <small className="online-demo">Demonstração</small>}
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="online-panel"
        align="end"
        sideOffset={8}
        collisionPadding={10}
      >
        <header>
          <strong>Online agora</strong>
          <small>
            {online} online
            {present.length > online &&
              ` · ${present.length - online} ausente${present.length - online > 1 ? "s" : ""}`}
          </small>
        </header>
        {present.length ? (
          <ul>
            {present.map((p) => (
              <li key={p.member.user_id}>
                <span className="online-avatar">
                  <Avatar
                    name={p.member.name}
                    src={p.member.avatar_url}
                    size="small"
                  />
                  <PresenceDot state={p.state} />
                </span>
                <span>
                  <strong>
                    {p.member.name}
                    {p.member.user_id === user && (
                      <span className="you-tag">Você</span>
                    )}
                  </strong>
                  <small>
                    {p.state === "online" ? "Online" : "Ausente"} ·{" "}
                    {since(p.since)}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="online-empty">Conectando…</p>
        )}
        <footer>
          Ausente: com a aba em segundo plano ou sem uso há 5 minutos.
        </footer>
      </Popover.Content>
    </Popover.Root>
  );
}
