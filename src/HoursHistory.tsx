import { useEffect, useMemo, useRef, useState } from "react";
import { companyHoursPage, HOURS_PAGE_SIZE, type HoursPage } from "./api";
import { Empty, LiveDuration } from "./components";
import { Pagination } from "./Pagination";
import { Button, Loading } from "./ui";
import type { Member, Snapshot } from "./types";

export function HoursHistory({
  company,
  user,
  isLeader,
  members,
  refreshKey,
  demoData,
}: {
  company: string;
  user: string;
  isLeader: boolean;
  members: Member[];
  refreshKey: string;
  demoData?: Snapshot;
}) {
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<(HoursPage & { page: number }) | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const top = useRef<HTMLElement>(null);
  const names = useMemo(
    () => new Map(members.map((member) => [member.user_id, member.name])),
    [members],
  );

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const load = async (): Promise<HoursPage> => {
      if (!demoData)
        return companyHoursPage(
          company,
          page,
          isLeader ? undefined : user,
          controller.signal,
        );
      const entries = demoData.hours
        .filter(
          (h) => h.company_id === company && (isLeader || h.user_id === user),
        )
        .sort(
          (a, b) =>
            b.started_at.localeCompare(a.started_at) ||
            b.id.localeCompare(a.id),
        );
      const tasks = new Map(
        demoData.tasks.map((task) => [task.id, task.title]),
      );
      return {
        entries: entries
          .slice(page * HOURS_PAGE_SIZE, (page + 1) * HOURS_PAGE_SIZE)
          .map((h) => ({
            ...h,
            task: tasks.has(h.task_id)
              ? { title: tasks.get(h.task_id)! }
              : null,
          })),
        count: entries.length,
      };
    };
    void load()
      .then((next) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(
          0,
          Math.ceil(next.count / HOURS_PAGE_SIZE) - 1,
        );
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setResult({ ...next, page });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        // PostgREST rejects an offset past the end after records disappear.
        if (e.code === "PGRST103" && page > 0) setPage(0);
        else
          setError(e.message || "Não foi possível carregar os apontamentos.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [company, user, isLeader, page, refreshKey, retry, demoData]);

  const shown = result?.page === page ? result : null;
  const pending = loading || (!shown && !error);
  return (
    <section className="panel" ref={top} aria-busy={pending}>
      <div className="panel-heading">
        <div>
          <h2>Apontamentos recentes</h2>
          <p>
            {isLeader
              ? "Registros do mais recente ao mais antigo"
              : "Seus registros do mais recente ao mais antigo"}
          </p>
        </div>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <Button
            className="btn secondary"
            onClick={() => setRetry((n) => n + 1)}
          >
            Tentar novamente
          </Button>
        </div>
      )}
      {pending && !shown ? (
        <Loading variant="table" label="Carregando apontamentos" />
      ) : (
        shown && (
          <div className="table-scroll">
            <table className="stack-mobile stack-3">
              <thead>
                <tr>
                  <th>Tarefa</th>
                  {isLeader && <th>Pessoa</th>}
                  <th>Data</th>
                  <th>Origem</th>
                  <th>Tempo</th>
                </tr>
              </thead>
              <tbody>
                {shown.entries.map((h) => (
                  <tr key={h.id}>
                    <td>
                      {h.task?.title ?? "Tarefa indisponível"}
                      <small className="cell-note">{h.note}</small>
                    </td>
                    {isLeader && (
                      <td data-label="Pessoa">{names.get(h.user_id) ?? "—"}</td>
                    )}
                    <td data-label="Data">
                      {new Date(h.started_at).toLocaleDateString("pt-BR")}
                    </td>
                    <td data-label="Origem">
                      {h.source === "timer" ? "Cronômetro" : "Manual"}
                    </td>
                    <td data-label="Tempo">
                      <strong>
                        <LiveDuration entry={h} />
                      </strong>
                      {!h.ended_at && (
                        <span className="running-label"> em andamento</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
      {!pending && !error && !shown?.entries.length && (
        <Empty
          title="Nenhum apontamento"
          body="Registre o tempo dedicado às suas tarefas."
        />
      )}
      {result && (
        <Pagination
          page={result.page}
          pageCount={Math.max(1, Math.ceil(result.count / HOURS_PAGE_SIZE))}
          pageSize={HOURS_PAGE_SIZE}
          total={result.count}
          noun="apontamentos"
          onPage={setPage}
          disabled={pending}
          always
          anchor={top}
        />
      )}
    </section>
  );
}
