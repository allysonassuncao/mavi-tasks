import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { CalendarClock, Radar, RefreshCw, Settings2 } from "lucide-react";
import { Button, Checkbox, Loading } from "./ui";
import { Empty } from "./components";
import type { Member } from "./types";
import { appPath, openInApp } from "./temperature";
import { RadarItemPanel, SeverityDot } from "./RadarItemPanel";
import { dateBr, isClosed, loadClientRadar, overdue, statusOf, type ClientRadarData } from "./radar";

/**
 * Drive › cliente › Radar: o que este cliente reclamou, o que o time
 * prometeu e os outros tópicos, com o andamento de cada item. Quem vê é
 * quem vê o cliente no Drive; só líderes mudam status e responsável.
 */
export function ClientRadar({
  company,
  client,
  clientName,
  members,
  isLeader,
}: {
  company: string;
  client: string;
  clientName: string;
  members: Member[];
  isLeader: boolean;
}) {
  const [data, setData] = useState<ClientRadarData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => {
    setError("");
    setBusy(true);
    loadClientRadar(company, client)
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }, [company, client]);
  useEffect(load, [load]);

  if (!data)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="list" />
    );

  return (
    <section className="thermo radar-client" aria-label={`Radar de ${clientName}`}>
      <header className="thermo-head">
        <div>
          <h2>
            <Radar size={18} aria-hidden="true" /> Radar
          </h2>
          <p>
            O que {clientName} reclamou, o que o time prometeu e os outros tópicos que a MAVI acompanha nas reuniões
            gravadas e nos grupos de WhatsApp.
          </p>
          {data.pending > 0 && (
            <small className="thermo-meta">
              {data.pending} {data.pending === 1 ? "reunião ou conversa na fila" : "reuniões e conversas na fila"}
            </small>
          )}
        </div>
        <div className="thermo-head-actions">
          <label className="thermo-check">
            <Checkbox checked={closed} onCheckedChange={(v) => setClosed(v === true)} />
            Mostrar fechados
          </label>
          <Button className="icon-btn" onClick={load} loading={busy} aria-label="Atualizar" title="Atualizar">
            <RefreshCw size={15} />
          </Button>
          {isLeader && (
            <a
              className="btn secondary"
              href={appPath("/radar")}
              onClick={(e) => {
                e.preventDefault();
                openInApp("/radar");
              }}
            >
              <Settings2 size={15} aria-hidden="true" /> Todos os clientes
            </a>
          )}
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!data.items.length ? (
        <Empty
          title="Nada no Radar ainda"
          body="A MAVI anota aqui as reclamações e as promessas das próximas reuniões gravadas e das mensagens dos grupos de WhatsApp deste cliente."
        />
      ) : (
        <ClientRadarGroups data={data} closed={closed} onOpen={setOpen} />
      )}
      {open && (
        <RadarItemPanel
          company={company}
          itemId={open}
          members={members}
          onClose={() => setOpen(null)}
          onChanged={(next) =>
            setData((d) => d && { ...d, items: d.items.map((x) => (x.id === next.id ? { ...x, ...next } : x)) })
          }
        />
      )}
    </section>
  );
}

/** Os itens do cliente por tópico (os fechados só quando pedidos). */
export function ClientRadarGroups({
  data,
  closed,
  onOpen,
}: {
  data: ClientRadarData;
  closed: boolean;
  onOpen: (id: string) => void;
}) {
  const groups = useMemo(() => {
    return data.topics
      .map((t) => {
        const all = data.items.filter((i) => i.topic_id === t.id);
        return {
          topic: t,
          all,
          shown: all.filter((i) => closed || !isClosed(t, i.status)),
        };
      })
      .filter((g) => g.topic.active || g.all.length);
  }, [data, closed]);
  return (
    <>
      {groups.map(({ topic, all, shown }) => (
        <div key={topic.id} className="radar-client-group" style={{ "--topic": topic.color } as CSSProperties}>
          <h3>
            {topic.name}
            <small>
              {all.filter((i) => !isClosed(topic, i.status)).length} em aberto · {all.length} no total
            </small>
          </h3>
          {!shown.length ? (
            <p className="muted radar-client-none">Nada em aberto.</p>
          ) : (
            <ul className="radar-client-list">
              {shown.map((i) => {
                const s = statusOf(topic, i.status);
                const late = overdue(topic, i);
                return (
                  <li key={i.id}>
                    <button type="button" onClick={() => onOpen(i.id)}>
                      <span className="radar-status" style={{ "--status": s?.color ?? "#a3acab" } as CSSProperties}>
                        {s?.label ?? i.status}
                      </span>
                      <span className="radar-client-title">
                        <strong>{i.title}</strong>
                        <small>
                          {i.product_name ?? "Geral / Agência"} · {i.mentions} {i.mentions === 1 ? "vez" : "vezes"} ·
                          última em {dateBr(i.last_seen_at)}
                          {i.assignee_name && ` · ${i.assignee_name}`}
                        </small>
                      </span>
                      {topic.has_due && i.due_date && (
                        <span className={`radar-client-due${late ? " radar-late" : ""}`}>
                          <CalendarClock size={12} aria-hidden="true" /> {dateBr(i.due_date)}
                        </span>
                      )}
                      <SeverityDot topic={topic} value={i.severity} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}
