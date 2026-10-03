import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button, Checkbox, Input } from "./ui";
import { Badge } from "./components";
import { tasksByIds } from "./api";
import { namesFrom, type NameLookup } from "./domain";
import type { Task } from "./types";
import { dateBr, linkCandidates, taskSuggestions, type LinkCandidate, type RadarItemDetail } from "./radar";

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * "Vincular tarefa" no painel do item do Radar: as parecidas com o item (a
 * busca por significado da MAVI) no topo e, abaixo, as tarefas do cliente;
 * digitando, a busca pelo título vai a todas as tarefas que a pessoa vê, as
 * do cliente primeiro. Marca uma ou várias e vincula de uma vez.
 */
export function RadarTaskPicker({
  company,
  item,
  lookup,
  demoTasks,
  onCancel,
  onLink,
}: {
  company: string;
  item: RadarItemDetail;
  lookup: NameLookup;
  /** As tarefas carregadas (a demonstração procura nelas). */
  demoTasks?: Task[];
  onCancel: () => void;
  onLink: (ids: string[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  // A lista com o termo que a trouxe (enquanto a pessoa digita, a anterior fica).
  const [list, setList] = useState<{ q: string; rows: LinkCandidate[] } | null>(null);
  const [similar, setSimilar] = useState<Task[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const linked = useMemo(() => item.tasks.map((t) => t.id), [item.tasks]);
  const clientOf = (t: Task) => lookup.contracts.get(t.contract_id)?.client_id;

  // As parecidas, uma vez por abertura.
  useEffect(() => {
    let alive = true;
    taskSuggestions(company, item.id)
      .then(async (ids) => {
        const found = ids.length && UUID.test(company) ? await tasksByIds(company, ids) : [];
        const byId = new Map(found.map((t) => [t.id, t]));
        // Na ordem da MAVI (a mais parecida primeiro).
        return ids
          .map((id) => byId.get(id))
          .filter((t): t is Task => !!t && !t.archived && !linked.includes(t.id));
      })
      .then((found) => alive && setSimilar(found))
      .catch(() => alive && setSimilar([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, item.id]);

  // A lista: as do cliente ou a busca pelo título (espera a pessoa parar de digitar).
  useEffect(() => {
    let alive = true;
    const wait = setTimeout(
      () => {
        linkCandidates(company, item.client_id, query, linked, demoTasks, clientOf)
          .then((rows) => alive && setList({ q: query.trim(), rows }))
          .catch((e) => {
            if (!alive) return;
            setList({ q: query.trim(), rows: [] });
            setError((e as Error).message);
          });
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      alive = false;
      clearTimeout(wait);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company, item.client_id, query, linked.join(",")]);

  const suggested = new Set((similar ?? []).map((t) => t.id));
  const rows = (list?.rows ?? []).filter((r) => !suggested.has(r.task.id));
  const searching = query.trim().length >= 2;
  const listed = (list?.q ?? "").length >= 2;

  function toggle(id: string) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function link() {
    setBusy(true);
    setError("");
    try {
      await onLink([...picked]);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  const row = (t: Task, other = false) => {
    const n = namesFrom(lookup, t);
    return (
      <li key={t.id}>
        <label className={picked.has(t.id) ? "picked" : ""}>
          <Checkbox checked={picked.has(t.id)} onCheckedChange={() => toggle(t.id)} />
          <span className="radar-pick-text">
            <strong>{t.title}</strong>
            <small>
              {other && n.client ? <em>{n.client.name}</em> : n.client?.name}
              {n.product && <> / {n.product.name}</>}
              {n.member && <> · {n.member.name}</>}
              {t.due_date && <> · prazo {dateBr(t.due_date)}</>}
            </small>
          </span>
          <Badge status={t.status} />
        </label>
      </li>
    );
  };

  return (
    <div className="radar-pick">
      <Input
        type="search"
        autoFocus
        aria-label="Buscar tarefa pelo título"
        placeholder="Buscar pelo título em todas as tarefas…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {!searching && (
        <section aria-label="Parecidas com este item">
          <h5>
            <Sparkles size={13} aria-hidden="true" /> Parecidas com este item
          </h5>
          {similar === null ? (
            <p className="muted">A MAVI está procurando tarefas parecidas…</p>
          ) : similar.length ? (
            <ul>{similar.map((t) => row(t, clientOf(t) !== item.client_id))}</ul>
          ) : (
            <p className="muted">A MAVI não achou tarefas parecidas.</p>
          )}
        </section>
      )}

      <section aria-label={listed ? "Resultados" : `Tarefas de ${item.client_name}`}>
        <h5>{listed ? "Resultados" : `Tarefas de ${item.client_name}`}</h5>
        {list === null ? (
          <p className="muted">Carregando…</p>
        ) : rows.length ? (
          <ul>{rows.map((r) => row(r.task, !r.same_client))}</ul>
        ) : (
          <p className="muted">
            {listed
              ? "Nenhuma tarefa com esse título."
              : "Nenhuma outra tarefa deste cliente. Busque pelo título para ver as dos outros clientes."}
          </p>
        )}
      </section>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="radar-pick-actions">
        <Button className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button className="btn primary" onClick={link} disabled={!picked.size} loading={busy}>
          {picked.size > 1 ? `Vincular ${picked.size} tarefas` : "Vincular tarefa"}
        </Button>
      </div>
    </div>
  );
}
