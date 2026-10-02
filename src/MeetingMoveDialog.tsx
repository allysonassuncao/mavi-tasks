import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Building2,
  Check,
  Globe,
  Lock,
  Radar,
  Search,
  Sparkles,
  Thermometer,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading } from "./ui";
import { fold } from "./task-search";
import {
  moveMeetingRecordings,
  previewMeetingMove,
  type MeetingMovePreview,
} from "./meetings";
import type { Snapshot } from "./types";

/** Os clientes que a pessoa vê no Drive (o mesmo que drive_can_read). */
export function driveReadableClients(
  data: Snapshot,
  user: string,
  isLeader: boolean,
) {
  const teams = new Set(
    data.teamMembers.filter((tm) => tm.user_id === user).map((tm) => tm.team_id),
  );
  const mine = new Set(
    data.clientTeams.filter((ct) => teams.has(ct.team_id)).map((ct) => ct.client_id),
  );
  return data.clients.filter((c) => isLeader || mine.has(c.id));
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/**
 * Levar gravações para as Gravações da MAVI de outro cliente: escolhe o
 * cliente (só os que a pessoa atende), confere com o banco o que muda
 * (MAVI, Radar, Termômetro, link público) e só então move.
 */
export function MeetingMoveDialog({
  company,
  data,
  user,
  isLeader,
  from,
  recordings,
  label,
  onClose,
  onMoved,
}: {
  company: string;
  data: Snapshot;
  user: string;
  isLeader: boolean;
  /** O cliente de onde as gravações saem. */
  from: string;
  recordings: string[];
  /** O título da gravação (uma só) ou "3 gravações". */
  label: string;
  onClose: () => void;
  onMoved: (result: MeetingMovePreview) => void;
}) {
  const [query, setQuery] = useState("");
  const [to, setTo] = useState<string | null>(null);
  const [preview, setPreview] = useState<MeetingMovePreview | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const clientName = (id: string) =>
    data.clients.find((c) => c.id === id)?.name ?? "Cliente";
  const options = useMemo(() => {
    const q = fold(query.trim());
    return driveReadableClients(data, user, isLeader)
      .filter((c) => !c.archived && c.id !== from)
      .filter((c) => !q || fold(c.name).includes(q))
      .sort((a, b) =>
        a.name.localeCompare(b.name, "pt-BR", {
          numeric: true,
          sensitivity: "base",
        }),
      );
  }, [data, user, isLeader, from, query]);

  // A cada cliente escolhido, o banco confere (permissão, o que muda).
  useEffect(() => {
    setPreview(null);
    setProblem("");
    if (!to) return;
    let alive = true;
    previewMeetingMove(company, recordings, to)
      .then((p) => alive && setPreview(p))
      .catch((e) => alive && setProblem((e as Error).message));
    return () => {
      alive = false;
    };
  }, [company, recordings, to]);

  async function confirm() {
    if (!to) return;
    setBusy(true);
    setError("");
    try {
      onMoved(await moveMeetingRecordings(company, recordings, to));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const warnings = (p: MeetingMovePreview) => {
    const target = clientName(p.to.client_id);
    const one = p.recordings === 1;
    const out: { icon: typeof Globe; tone: "mavi" | "warn" | "info"; text: string }[] = [
      {
        icon: Sparkles,
        tone: "mavi",
        text: `Sai de ${p.from_clients.map(clientName).join(", ")}. A MAVI passa a usar ${
          one ? "a reunião" : `as ${p.recordings} reuniões`
        } só no contexto de ${target}, e quem não atende ${target} deixa de ver.`,
      },
    ];
    if (p.radar_mentions)
      out.push({
        icon: Radar,
        tone: "info",
        text: `${plural(p.radar_mentions, "ocorrência sai", "ocorrências saem")} do Radar de ${p.from_clients
          .map(clientName)
          .join(", ")}; a MAVI lê ${one ? "a reunião" : "as reuniões"} de novo para ${target}.`,
      });
    if (p.temperature)
      out.push({
        icon: Thermometer,
        tone: "info",
        text: `A leitura do Termômetro é refeita para ${target}.`,
      });
    if (p.shared)
      out.push({
        icon: Globe,
        tone: "warn",
        text: `${
          p.shared === 1 && one
            ? "O link público continua abrindo"
            : `${plural(p.shared, "link público continua", "links públicos continuam")} abrindo`
        }: o link é da gravação, não do cliente.`,
      });
    return out;
  };

  return (
    <Modal
      title={`Mover ${label}`}
      onClose={onClose}
      busy={busy}
      className="drive-pick-modal drive-move-modal"
    >
      <div className="drive-pick">
        <span className="drive-search">
          <Input
            type="search"
            aria-label="Buscar cliente"
            placeholder="Buscar cliente"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            icon={Search}
            autoFocus
          />
        </span>
        <div className="drive-pick-list">
          <ul role="listbox" aria-label="Cliente de destino">
            {options.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={to === c.id}
                  className={`drive-pick-folder ${to === c.id ? "on" : ""}`}
                  onClick={() => setTo(c.id)}
                >
                  <Building2 size={17} aria-hidden="true" />
                  <span>
                    {c.name}
                    <small>Gravações da MAVI</small>
                  </span>
                  {to === c.id && <Check size={15} aria-hidden="true" />}
                </button>
              </li>
            ))}
            {!options.length && (
              <li className="drive-pick-empty">
                {query.trim()
                  ? "Nenhum cliente com esse nome entre os que você atende."
                  : "Você não atende outro cliente para onde levar as gravações."}
              </li>
            )}
          </ul>
        </div>
        <div className="drive-move-check" aria-live="polite">
          {!to ? (
            <p className="drive-move-note">
              <ArrowRight size={14} aria-hidden="true" />
              Escolha o cliente certo. A lista mostra só os clientes que você
              atende.
            </p>
          ) : problem ? (
            <p className="drive-move-note">
              <Lock size={14} aria-hidden="true" />
              {problem}
            </p>
          ) : !preview ? (
            <Loading compact />
          ) : (
            <>
              <p className="drive-move-summary">
                <ArrowRight size={14} aria-hidden="true" />
                <span>
                  {plural(preview.recordings, "gravação", "gravações")} para{" "}
                  <strong>{preview.to.label}</strong>
                </span>
              </p>
              {warnings(preview).map((w, i) => (
                <p key={i} className={`drive-move-warning ${w.tone}`}>
                  <w.icon size={15} aria-hidden="true" />
                  {w.text}
                </p>
              ))}
            </>
          )}
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer drive-pick-footer">
          <small>O histórico do Drive guarda de onde e para onde.</small>
          <Button type="button" className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            type="button"
            className="btn primary"
            disabled={!preview || !!problem}
            loading={busy}
            onClick={() => void confirm()}
          >
            <ArrowRight size={15} /> Mover para{" "}
            {to ? clientName(to) : "o cliente"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
