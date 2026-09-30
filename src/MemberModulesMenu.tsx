import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { LayoutGrid, PlugZap } from "lucide-react";
import { Checkbox } from "./ui";
import type { Member } from "./types";
import {
  ADMIN_PAGES,
  MODULES,
  hiddenModules,
  optInFor,
  roleAllows,
} from "./modules";

// A burst of clicks becomes a single save.
const SAVE_DELAY = 500;

const sameList = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join() === [...b].sort().join();

/**
 * Shortcut to the "Módulos visíveis" of the user form: from the person's row,
 * each click shows or hides a module and is saved by itself, without opening
 * the form. Only administrators (set_member_pages). The list handled here is
 * every module off for the person, including a collaborator's opt-in ones
 * not turned on; the database splits it by profile.
 */
export function MemberModulesMenu({
  member,
  save,
  saveMcp,
}: {
  member: Member;
  /** Saves the person's hidden modules. */
  save: (hidden: string[]) => Promise<unknown>;
  /** Liga ou desliga a IA externa (MCP) da pessoa (set_member_mcp). */
  saveMcp?: (access: "default" | "on" | "off") => Promise<unknown>;
}) {
  const saved = hiddenModules(member);
  const [hidden, setHidden] = useState<string[]>(saved);
  const [status, setStatus] = useState<"" | "saving" | "saved" | "error">("");
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef(false);
  // The latest choice still to be sent.
  const pending = useRef<string[] | null>(null);
  // What the database holds, as far as this menu knows.
  const lastSaved = useRef<string[]>(saved);
  const savedKey = [...saved].sort().join();

  // Follows changes made elsewhere (the form, another admin) when idle.
  useEffect(() => {
    if (inFlight.current || pending.current) return;
    lastSaved.current = saved;
    setHidden(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function flush() {
    clearTimeout(timer.current);
    if (inFlight.current || !pending.current) return;
    const next = pending.current;
    pending.current = null;
    if (sameList(next, lastSaved.current)) {
      setStatus("");
      return;
    }
    inFlight.current = true;
    setStatus("saving");
    try {
      await save(next);
      lastSaved.current = next;
      inFlight.current = false;
      if (pending.current) void flush();
      else setStatus("saved");
    } catch (err) {
      inFlight.current = false;
      pending.current = null;
      setHidden(lastSaved.current);
      setError((err as Error).message);
      setStatus("error");
    }
  }

  function change(next: string[]) {
    setHidden(next);
    setError("");
    setStatus("saving");
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DELAY);
  }

  const leader = member.role === "admin" || member.role === "manager";
  const mcpSaved = member.mcp_access ?? "default";
  const [mcp, setMcp] = useState(mcpSaved);
  const [mcpBusy, setMcpBusy] = useState(false);
  useEffect(() => {
    if (!mcpBusy) setMcp(mcpSaved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcpSaved]);
  const mcpOn = mcp === "on" || (mcp === "default" && leader);
  async function toggleMcp(on: boolean) {
    if (!saveMcp) return;
    // Ligado volta ao padrão para quem já o tem pelo perfil.
    const next = on ? (leader ? "default" : "on") : "off";
    const previous = mcp;
    setMcp(next);
    setMcpBusy(true);
    setError("");
    try {
      await saveMcp(next);
      setStatus("saved");
    } catch (err) {
      setMcp(previous);
      setError((err as Error).message);
      setStatus("error");
    } finally {
      setMcpBusy(false);
    }
  }

  const allowed = MODULES.filter((m) => roleAllows(m.id, member.role));
  const shown = allowed.filter((m) => !hidden.includes(m.id)).length;
  // The badge: modules the profile gives and someone hid (a collaborator's
  // opt-in modules start off, which isn't hiding).
  const count = saved.filter(
    (id) => allowed.some((m) => m.id === id) && !optInFor(id, member.role),
  ).length;

  return (
    <Popover.Root
      onOpenChange={(open) => {
        if (open) {
          setError("");
          setStatus("");
        } else void flush();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="icon-btn member-modules-trigger"
          title="Módulos visíveis"
          aria-label={`Módulos visíveis de ${member.name}`}
        >
          <LayoutGrid size={15} />
          {count > 0 && (
            <span className="member-modules-badge" aria-hidden="true">
              {count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="member-modules-menu"
          align="end"
          sideOffset={6}
          collisionPadding={16}
        >
          <div className="member-modules-head">
            <strong>Módulos visíveis</strong>
            <span>
              {member.name} · {shown} de {allowed.length}
            </span>
          </div>
          <div
            className="member-modules-list"
            role="group"
            aria-label={`Módulos visíveis de ${member.name}`}
          >
            {MODULES.map((m) => {
              const byRole = roleAllows(m.id, member.role);
              return (
                <label
                  key={m.id}
                  className="checkbox-label member-modules-option"
                  title={
                    byRole
                      ? undefined
                      : ADMIN_PAGES.includes(m.id)
                        ? "Só administradores veem este módulo"
                        : "Só gestores e administradores veem este módulo"
                  }
                >
                  <Checkbox
                    checked={byRole && !hidden.includes(m.id)}
                    disabled={!byRole}
                    onCheckedChange={(on) =>
                      change(
                        on === true
                          ? hidden.filter((id) => id !== m.id)
                          : [...new Set([...hidden, m.id])],
                      )
                    }
                  />
                  <span>{m.label}</span>
                  {!byRole && (
                    <small>
                      {ADMIN_PAGES.includes(m.id) ? "só admin." : "gestores"}
                    </small>
                  )}
                  {optInFor(m.id, member.role) && (
                    <small title="Desligado por padrão para colaboradores. Ligado, a pessoa usa tudo do módulo, só nos clientes das equipes dela">
                      clientes dela
                    </small>
                  )}
                </label>
              );
            })}
          </div>
          {saveMcp && (
            <label
              className="checkbox-label member-modules-option member-modules-mcp"
              title="Usar a MAVI no Claude, no ChatGPT e em outros apps de IA, só para consultar"
            >
              <Checkbox
                checked={mcpOn}
                disabled={mcpBusy}
                onCheckedChange={(on) => void toggleMcp(on === true)}
              />
              <span>
                <PlugZap size={13} aria-hidden="true" /> MAVI em apps externos (MCP)
              </span>
              {mcp === "default" && <small>padrão</small>}
            </label>
          )}
          <div className="member-modules-foot">
            <button
              type="button"
              className="text-btn"
              disabled={hidden.length === 0}
              onClick={() => change([])}
            >
              Mostrar todos
            </button>
            <button
              type="button"
              className="text-btn"
              disabled={shown === 0}
              onClick={() =>
                change([...new Set([...hidden, ...allowed.map((m) => m.id)])])
              }
            >
              Esconder todos
            </button>
            <span
              className={`member-modules-status ${status}`}
              role="status"
              aria-live="polite"
            >
              {status === "saving"
                ? "Salvando…"
                : status === "saved"
                  ? "Salvo"
                  : ""}
            </span>
          </div>
          {status === "error" && (
            <p className="form-error" role="alert">
              {error || "Não foi possível salvar."}
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
