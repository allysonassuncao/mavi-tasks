import { useEffect, useState } from "react";
import { BellRing, Pencil, Plus, Trash2 } from "lucide-react";
import { Button, Checkbox, Input, Loading, Select, SelectOption } from "./ui";
import { Modal } from "./components";
import type { Snapshot } from "./types";
import {
  ALERT_EVENTS,
  deleteAlertRule,
  loadAlertRules,
  saveAlertRule,
  type AlertEvent,
  type AlertRule,
  type TopicCounts,
} from "./radar";

const ANY = "__any__";
const NONE = "__none__";
const SEVERITY = ["Baixa", "Média", "Alta", "Crítica"];

const blank = (): AlertRule => ({
  name: "",
  topic_id: null,
  product_id: null,
  product_none: false,
  client_id: null,
  team_id: null,
  min_severity: null,
  events: ["new"],
  channel: "now",
  active: true,
});

/** "Item novo e Reabriu · Problemas / reclamações · Make Ads · Alta ou mais · na hora". */
function ruleLine(r: AlertRule) {
  const events = ALERT_EVENTS.filter((e) => r.events.includes(e.key)).map((e) => e.label);
  return [
    events.join(", "),
    r.labels?.topic ?? "todos os tópicos",
    r.labels?.product ?? "todos os produtos",
    r.labels?.client,
    r.labels?.team && `equipe ${r.labels.team}`,
    r.min_severity !== null && `${SEVERITY[r.min_severity]}${r.min_severity < 3 ? " ou mais" : ""}`,
    r.channel === "now" ? "na hora" : "no resumo das 8h",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Radar › Meus avisos: as regras de cada administrador ou gestor. Sem regra,
 * nenhum aviso do Radar chega. Na hora vai para a caixa de entrada e o push
 * (pelas preferências de notificação); o resumo chega uma vez por dia, às 8h.
 */
export function RadarAlerts({
  company,
  data,
  topics,
  notify,
  onClose,
}: {
  company: string;
  data: Snapshot;
  topics: TopicCounts[];
  notify: (message: string) => void;
  onClose: () => void;
}) {
  const [rules, setRules] = useState<AlertRule[] | null>(null);
  const [editing, setEditing] = useState<AlertRule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadAlertRules(company)
      .then(setRules)
      .catch((e) => setError((e as Error).message));
  }, [company]);

  function save() {
    if (!editing) return;
    setBusy(true);
    setError("");
    saveAlertRule(company, editing)
      .then((list) => {
        setRules(list);
        setEditing(null);
        notify("Aviso salvo.");
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  }
  const set = (p: Partial<AlertRule>) => setEditing((r) => (r ? { ...r, ...p } : r));
  const toggleEvent = (e: AlertEvent, on: boolean) =>
    editing && set({ events: on ? [...new Set([...editing.events, e])] : editing.events.filter((x) => x !== e) });
  const hasDue = topics.some((t) => t.has_due && (!editing?.topic_id || t.id === editing.topic_id));

  return (
    <Modal title="Meus avisos do Radar" onClose={onClose} busy={busy}>
      <div className="entity-form radar-report-form radar-alerts">
        {!editing ? (
          <>
            <p className="muted radar-report-note">
              Escolha o que você quer saber e como. Sem nenhum aviso aqui, o Radar não manda nada para você. As
              reuniões e conversas antigas (o histórico) não avisam.
            </p>
            {!rules ? (
              <Loading variant="list" />
            ) : !rules.length ? (
              <p className="muted">Você ainda não tem avisos do Radar.</p>
            ) : (
              <ul className="radar-alert-list">
                {rules.map((r) => (
                  <li key={r.id} className={r.active ? "" : "off"}>
                    <BellRing size={15} aria-hidden="true" />
                    <div>
                      <strong>{r.name}</strong>
                      <small>
                        {ruleLine(r)}
                        {!r.active && " · desligado"}
                      </small>
                    </div>
                    <button type="button" className="icon-btn" aria-label={`Editar ${r.name}`} onClick={() => setEditing(r)}>
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Excluir ${r.name}`}
                      onClick={() =>
                        void deleteAlertRule(company, r.id!)
                          .then((list) => {
                            setRules(list);
                            notify("Aviso excluído.");
                          })
                          .catch((e) => setError((e as Error).message))
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <Button className="btn primary" onClick={() => setEditing(blank())} disabled={(rules?.length ?? 0) >= 20}>
              <Plus size={15} aria-hidden="true" /> Novo aviso
            </Button>
          </>
        ) : (
          <>
            <label>
              <span>Nome</span>
              <Input
                autoFocus
                value={editing.name}
                maxLength={120}
                placeholder="Ex.: Reclamações sérias de Make Ads"
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <fieldset className="radar-report-filter">
              <legend>Quando</legend>
              <div>
                {ALERT_EVENTS.filter((e) => hasDue || (e.key !== "due_soon" && e.key !== "overdue")).map((e) => (
                  <label key={e.key} className="thermo-check" title={e.hint}>
                    <Checkbox checked={editing.events.includes(e.key)} onCheckedChange={(v) => toggleEvent(e.key, v === true)} />
                    {e.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="radar-report-dates">
              <label>
                <span>Tópico</span>
                <Select
                  aria-label="Tópico"
                  value={editing.topic_id ?? ANY}
                  onValueChange={(v) => set({ topic_id: v === ANY ? null : v })}
                >
                  <SelectOption value={ANY}>Todos os tópicos</SelectOption>
                  {topics.map((t) => (
                    <SelectOption key={t.id} value={t.id}>
                      {t.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                <span>Produto</span>
                <Select
                  aria-label="Produto"
                  value={editing.product_none ? NONE : (editing.product_id ?? ANY)}
                  onValueChange={(v) =>
                    set({ product_id: v === ANY || v === NONE ? null : v, product_none: v === NONE })
                  }
                >
                  <SelectOption value={ANY}>Todos os produtos</SelectOption>
                  <SelectOption value={NONE}>Geral / Agência</SelectOption>
                  {data.products.map((p) => (
                    <SelectOption key={p.id} value={p.id}>
                      {p.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                <span>Cliente</span>
                <Select
                  aria-label="Cliente"
                  value={editing.client_id ?? ANY}
                  onValueChange={(v) => set({ client_id: v === ANY ? null : v })}
                >
                  <SelectOption value={ANY}>Todos os clientes</SelectOption>
                  {data.clients
                    .filter((c) => !c.archived)
                    .map((c) => (
                      <SelectOption key={c.id} value={c.id}>
                        {c.name}
                      </SelectOption>
                    ))}
                </Select>
              </label>
              <label>
                <span>Equipe</span>
                <Select
                  aria-label="Equipe"
                  value={editing.team_id ?? ANY}
                  onValueChange={(v) => set({ team_id: v === ANY ? null : v })}
                >
                  <SelectOption value={ANY}>Todas as equipes</SelectOption>
                  {data.teams.map((t) => (
                    <SelectOption key={t.id} value={t.id}>
                      {t.name}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                <span>Gravidade</span>
                <Select
                  aria-label="Gravidade mínima"
                  value={editing.min_severity === null ? ANY : String(editing.min_severity)}
                  onValueChange={(v) => set({ min_severity: v === ANY ? null : Number(v) })}
                >
                  <SelectOption value={ANY}>Qualquer uma</SelectOption>
                  {SEVERITY.map((l, i) => (
                    <SelectOption key={l} value={String(i)}>
                      {`${l}${i < 3 ? " ou mais" : ""}`}
                    </SelectOption>
                  ))}
                </Select>
              </label>
              <label>
                <span>Como</span>
                <Select
                  aria-label="Como avisar"
                  value={editing.channel}
                  onValueChange={(v) => set({ channel: v as AlertRule["channel"] })}
                >
                  <SelectOption value="now">Na hora (caixa e push)</SelectOption>
                  <SelectOption value="digest">Um resumo por dia, às 8h</SelectOption>
                </Select>
              </label>
            </div>
            <label className="thermo-check">
              <Checkbox checked={editing.active} onCheckedChange={(v) => set({ active: v === true })} />
              Ligado
            </label>
            <p className="muted radar-report-note">
              {ruleLine({
                ...editing,
                labels: {
                  topic: topics.find((t) => t.id === editing.topic_id)?.name ?? null,
                  product: editing.product_none
                    ? "Geral / Agência"
                    : (data.products.find((p) => p.id === editing.product_id)?.name ?? null),
                  client: data.clients.find((c) => c.id === editing.client_id)?.name ?? null,
                  team: data.teams.find((t) => t.id === editing.team_id)?.name ?? null,
                },
              })}
            </p>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <div className="radar-report-actions">
              <Button className="btn primary" onClick={save} loading={busy} disabled={!editing.events.length}>
                <BellRing size={15} aria-hidden="true" /> Salvar aviso
              </Button>
              <Button className="btn secondary" onClick={() => setEditing(null)}>
                Voltar
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
