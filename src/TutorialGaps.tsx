import { useEffect, useState } from "react";
import { BookCheck, Plus, RotateCcw, Search, Sparkles, X } from "lucide-react";
import { Empty } from "./components";
import { Button, Loading } from "./ui";
import {
  moduleLabel,
  type GapStatus,
  type TutorialGap,
  type TutorialsApi,
} from "./tutorials";

const FILTERS: { value: GapStatus; label: string }[] = [
  { value: "open", label: "Em aberto" },
  { value: "resolved", label: "Resolvidas" },
  { value: "dismissed", label: "Dispensadas" },
];
const when = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    timeZone: "America/Sao_Paulo",
  });

/**
 * Tutoriais › Dúvidas sem tutorial (administradores e gestores): o que o time
 * buscou sem achar e o que perguntou à MAVI sem haver tutorial. A mesma
 * dúvida soma (quantas vezes, quantas pessoas). Criar o tutorial a partir
 * dela a resolve ao publicar; dispensar tira da lista.
 */
export function TutorialGaps({
  api,
  company,
  tick,
  notify,
  onCreate,
  onOpenTutorial,
  onChanged,
}: {
  api: TutorialsApi;
  company: string;
  /** Muda com os avisos ao vivo: a lista pergunta de novo. */
  tick: number;
  notify: (message: string) => void;
  onCreate: (gap: TutorialGap) => void;
  onOpenTutorial: (id: string) => void;
  onChanged: () => void;
}) {
  const [status, setStatus] = useState<GapStatus>("open");
  const [rows, setRows] = useState<TutorialGap[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    let alive = true;
    setError("");
    api
      .gaps(company, status)
      .then((list) => alive && setRows(list))
      .catch((e) => alive && setError((e as Error).message || "Não foi possível carregar as dúvidas."));
    return () => {
      alive = false;
    };
  }, [api, company, status, tick]);

  const change = async (gap: TutorialGap, next: GapStatus, message: string) => {
    setBusy(gap.id);
    try {
      await api.setGap(gap.id, next);
      setRows((list) => list?.filter((g) => g.id !== gap.id) ?? null);
      notify(message);
      onChanged();
    } catch (e) {
      notify((e as Error).message || "Não foi possível mudar a dúvida.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="tutorial-gaps">
      <p className="tutorial-gaps-intro">
        O que o time buscou nos tutoriais sem achar e o que perguntou à MAVI sem haver
        tutorial. A mesma dúvida soma; quando o tutorial resolver, ela sai da lista.
      </p>
      <div className="tutorial-gaps-filter" role="group" aria-label="Situação">
        {FILTERS.map((f) => (
          <button
            type="button"
            key={f.value}
            className={`chip ${status === f.value ? "selected" : ""}`}
            aria-pressed={status === f.value}
            onClick={() => {
              setRows(null);
              setStatus(f.value);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      {rows === null && !error ? (
        <Loading variant="list" />
      ) : rows && rows.length ? (
        <ul className="tutorial-gap-list">
          {rows.map((g) => (
            <li key={g.id} className="tutorial-gap">
              <div className="tutorial-gap-main">
                <strong>“{g.question}”</strong>
                <span className="tutorial-gap-meta">
                  <span title={g.source === "mavi" ? "Perguntada à MAVI" : "Buscada nos tutoriais"}>
                    {g.source === "mavi" ? <Sparkles size={13} /> : <Search size={13} />}
                    {g.asks === 1 ? "1 vez" : `${g.asks} vezes`}
                    {g.people > 1 ? ` · ${g.people} pessoas` : ""}
                  </span>
                  {g.module && <span className="tutorial-module">{moduleLabel(g.module)}</span>}
                  <span>
                    {g.asker_names.slice(0, 3).join(", ")}
                    {g.people > 3 ? ` e mais ${g.people - 3}` : ""}
                  </span>
                  <span>Última vez em {when(g.last_asked_at)}</span>
                  {g.status !== "open" && g.handled_by_name && (
                    <span>
                      {g.status === "resolved" ? "Resolvida" : "Dispensada"} por {g.handled_by_name}
                    </span>
                  )}
                </span>
                {g.status === "resolved" && g.tutorial_id && (
                  <button
                    type="button"
                    className="text-btn"
                    onClick={() => onOpenTutorial(g.tutorial_id!)}
                  >
                    <BookCheck size={14} /> {g.tutorial_title ?? "Abrir o tutorial"}
                  </button>
                )}
              </div>
              <div className="tutorial-gap-actions">
                {g.status === "open" ? (
                  <>
                    <Button className="btn primary" onClick={() => onCreate(g)} disabled={!!busy}>
                      <Plus size={15} /> Criar tutorial
                    </Button>
                    <Button
                      className="btn secondary"
                      loading={busy === g.id}
                      disabled={!!busy}
                      onClick={() =>
                        void change(g, "dismissed", "Dúvida dispensada. Se voltar a ser perguntada, continua dispensada.")
                      }
                    >
                      <X size={15} /> Dispensar
                    </Button>
                  </>
                ) : (
                  <Button
                    className="btn secondary"
                    loading={busy === g.id}
                    disabled={!!busy}
                    onClick={() => void change(g, "open", "Dúvida reaberta.")}
                  >
                    <RotateCcw size={15} /> Reabrir
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="panel">
          <Empty
            title={
              status === "open"
                ? "Nenhuma dúvida sem tutorial"
                : status === "resolved"
                  ? "Nenhuma dúvida resolvida ainda"
                  : "Nenhuma dúvida dispensada"
            }
            body={
              status === "open"
                ? "Quando alguém buscar nos tutoriais sem achar, ou perguntar à MAVI algo que nenhum tutorial responde, a dúvida aparece aqui."
                : "As dúvidas que viraram tutorial ou foram dispensadas aparecem aqui."
            }
          />
        </div>
      )}
    </div>
  );
}
