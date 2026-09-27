import { useCallback, useEffect, useState } from "react";
import { Download, LogIn, LogOut, MonitorSmartphone } from "lucide-react";
import { Button, Select, SelectOption, Loading } from "./ui";
import { Avatar, Empty, Modal } from "./components";
import type { Member } from "./types";
import {
  ACCESS_PAGE,
  accessKinds,
  demoAccessLogs,
  describeDevice,
  memberAccessLogs,
  methodLabel,
  sessionLength,
  type AccessKind,
  type AccessLog,
  type AccessSummary,
} from "./access-logs";

const when = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
function ago(iso: string | null) {
  if (!iso) return "Nunca";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "Agora";
  if (min < 60) return `Há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Há ${h} h`;
  const d = Math.round(h / 24);
  return d < 31 ? `Há ${d} ${d === 1 ? "dia" : "dias"}` : when(iso);
}
const kindIcon = {
  login: LogIn,
  logout: LogOut,
  access: MonitorSmartphone,
} as const;

function detail(e: AccessLog) {
  if (e.kind === "login") return methodLabel(e.method);
  if (e.kind === "logout")
    return e.session_started_at
      ? `Sessão de ${sessionLength(e.session_started_at, e.created_at)}`
      : "Sessão encerrada";
  return "";
}

/**
 * Logs de login e acesso de uma pessoa do espaço (administradores e gestores):
 * resumo dos últimos 30 dias e o histórico, do mais recente ao mais antigo.
 */
export function MemberAccessLogs({
  member,
  company,
  demo,
  onClose,
}: {
  member: Member;
  company: string;
  demo: boolean;
  onClose: () => void;
}) {
  const [kind, setKind] = useState<AccessKind | "">("");
  const [items, setItems] = useState<AccessLog[] | null>(null);
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [more, setMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    if (demo) {
      const r = demoAccessLogs(kind);
      setItems(r.items);
      setSummary(r.summary);
      return;
    }
    setItems(null);
    setError("");
    memberAccessLogs(company, member.user_id, { kind })
      .then((r) => {
        setItems(r.items);
        if (r.summary) setSummary(r.summary);
        setMore(r.items.length === ACCESS_PAGE);
      })
      .catch((e) => {
        setItems([]);
        setError((e as Error).message);
      });
  }, [company, member.user_id, kind, demo]);
  useEffect(load, [load]);

  async function loadMore() {
    if (!items?.length) return;
    setLoadingMore(true);
    try {
      const r = await memberAccessLogs(company, member.user_id, {
        kind,
        before: items[items.length - 1].id,
      });
      setItems([...items, ...r.items]);
      setMore(r.items.length === ACCESS_PAGE);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  function exportCsv() {
    if (!items?.length) return;
    const cell = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["Data", "Evento", "Detalhes", "Dispositivo", "IP", "Navegador"],
      ...items.map((e) => [
        when(e.created_at),
        accessKinds[e.kind],
        detail(e),
        e.user_agent ? describeDevice(e.user_agent) : "",
        e.ip,
        e.user_agent,
      ]),
    ].map((row) => row.map(cell).join(";"));
    const url = URL.createObjectURL(
      new Blob(["﻿" + lines.join("\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    const slug = member.name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    link.download = `acessos-${slug || "pessoa"}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  return (
    <Modal title={`Acessos · ${member.name}`} onClose={onClose} wide>
      <div className="access-logs">
        <div className="access-person">
          <Avatar name={member.name} src={member.avatar_url} />
          <div>
            <strong>{member.name}</strong>
            {member.email && <span>{member.email}</span>}
          </div>
        </div>
        <dl className="access-summary">
          <div>
            <dt>Último acesso</dt>
            <dd title={summary?.last_access ? when(summary.last_access) : ""}>
              {summary ? ago(summary.last_access) : "—"}
            </dd>
          </div>
          <div>
            <dt>Último login</dt>
            <dd title={summary?.last_login ? when(summary.last_login) : ""}>
              {summary ? ago(summary.last_login) : "—"}
            </dd>
          </div>
          <div>
            <dt>Logins em 30 dias</dt>
            <dd>{summary?.logins_30d ?? "—"}</dd>
          </div>
          <div>
            <dt>IPs em 30 dias</dt>
            <dd>{summary?.ips_30d ?? "—"}</dd>
          </div>
        </dl>
        <div className="access-filters">
          <Select
            aria-label="Filtrar por evento"
            value={kind}
            onValueChange={(v) => setKind(v as AccessKind | "")}
          >
            <SelectOption value="">Todos os eventos</SelectOption>
            {(Object.keys(accessKinds) as AccessKind[]).map((k) => (
              <SelectOption key={k} value={k}>
                {accessKinds[k]}
              </SelectOption>
            ))}
          </Select>
          <Button
            className="btn secondary"
            disabled={!items?.length}
            onClick={exportCsv}
          >
            <Download size={15} /> Exportar CSV
          </Button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {items === null ? (
          <Loading compact />
        ) : items.length ? (
          <>
            <ol className="access-list">
              {items.map((e) => {
                const Icon = kindIcon[e.kind];
                const extra = detail(e);
                return (
                  <li key={e.id} className={`access-item ${e.kind}`}>
                    <span className="access-icon" aria-hidden="true">
                      <Icon size={15} />
                    </span>
                    <div className="access-main">
                      <strong>
                        {accessKinds[e.kind]}
                        {extra && <small> · {extra}</small>}
                      </strong>
                      {(e.user_agent || e.ip) && (
                        <span title={e.user_agent ?? ""}>
                          {e.user_agent ? describeDevice(e.user_agent) : ""}
                          {e.user_agent && e.ip ? " · " : ""}
                          {e.ip && <code>{e.ip}</code>}
                        </span>
                      )}
                    </div>
                    <time dateTime={e.created_at}>{when(e.created_at)}</time>
                  </li>
                );
              })}
            </ol>
            {more && (
              <Button
                className="btn secondary access-more"
                loading={loadingMore}
                onClick={() => void loadMore()}
              >
                Carregar mais
              </Button>
            )}
          </>
        ) : (
          !error && (
            <Empty
              title="Nenhum registro"
              body={
                kind
                  ? "Nenhum evento deste tipo por aqui."
                  : "Os logins, as saídas e os acessos a este espaço aparecem aqui assim que acontecerem."
              }
            />
          )
        )}
        <small className="access-note">
          Os registros são guardados por um ano. O IP e o navegador são os
          vistos pelo servidor no momento do evento.
        </small>
      </div>
    </Modal>
  );
}
