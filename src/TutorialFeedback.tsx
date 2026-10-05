import { useEffect, useState } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { Modal } from "./components";
import { Button, Loading, Textarea } from "./ui";
import {
  VOTE_REASONS,
  type TutorialFeedbackRow,
  type TutorialVote,
  type TutorialsApi,
  type VoteReason,
} from "./tutorials";

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", timeZone: "America/Sao_Paulo" });
const reasonLabel = (r: VoteReason | null) => VOTE_REASONS.find((x) => x.id === r)?.label ?? "";

/**
 * "Isso ajudou?" no fim do tutorial: um voto por pessoa (troca ou tira); no
 * 👎, um motivo pronto e um comentário opcional.
 */
export function TutorialFeedback({
  api,
  tutorial,
  version,
  initial,
  notify,
}: {
  api: TutorialsApi;
  tutorial: string;
  version: number;
  initial: TutorialVote | null;
  notify: (message: string) => void;
}) {
  const [vote, setVote] = useState<TutorialVote | null>(initial);
  // Abre o "O que faltou?" depois de um 👎 (ou ao mudar o motivo).
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState<VoteReason | null>(initial?.reason ?? null);
  const [comment, setComment] = useState(initial?.comment ?? "");
  const [busy, setBusy] = useState(false);

  const send = async (next: "up" | "down" | null, r: VoteReason | null = null, c = "") => {
    setBusy(true);
    try {
      const saved = await api.vote(tutorial, next, r, c);
      setVote(saved);
      return saved;
    } catch (e) {
      notify((e as Error).message || "Não foi possível registrar o voto.");
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const up = async () => {
    setAsking(false);
    if (vote?.vote === "up") return void (await send(null));
    if ((await send("up")) !== undefined) notify("Obrigado! Que bom que ajudou.");
  };
  const down = async () => {
    if (vote?.vote === "down" && !asking) {
      setAsking(true);
      return;
    }
    if (vote?.vote !== "down") await send("down", reason, comment);
    setAsking(true);
  };
  const submit = async () => {
    if ((await send("down", reason, comment)) !== undefined) {
      setAsking(false);
      notify("Obrigado! Quem escreve o tutorial vai ver o seu comentário.");
    }
  };
  const old = vote && vote.version < version;

  return (
    <section className="tutorial-feedback" aria-label="Isso ajudou?">
      <div className="tutorial-feedback-row">
        <strong>Este tutorial ajudou?</strong>
        <span className="tutorial-feedback-buttons">
          <button
            type="button"
            className={`tutorial-vote ${vote?.vote === "up" ? "on" : ""}`}
            aria-pressed={vote?.vote === "up"}
            onClick={() => void up()}
            disabled={busy}
          >
            <ThumbsUp size={15} /> Sim
          </button>
          <button
            type="button"
            className={`tutorial-vote down ${vote?.vote === "down" ? "on" : ""}`}
            aria-pressed={vote?.vote === "down"}
            onClick={() => void down()}
            disabled={busy}
          >
            <ThumbsDown size={15} /> Não
          </button>
        </span>
      </div>
      {vote && !asking && (
        <small className="tutorial-feedback-note">
          {vote.vote === "up"
            ? "Você marcou que ajudou."
            : `Você marcou que não ajudou${vote.reason ? `: ${reasonLabel(vote.reason).toLowerCase()}` : ""}.`}
          {old ? " O tutorial mudou desde o seu voto." : ""}{" "}
          {vote.vote === "down" && (
            <button type="button" className="link-btn" onClick={() => setAsking(true)}>
              Mudar o motivo
            </button>
          )}
        </small>
      )}
      {asking && (
        <div className="tutorial-feedback-why">
          <span>O que faltou?</span>
          <div className="tutorial-feedback-reasons" role="radiogroup" aria-label="Motivo">
            {VOTE_REASONS.map((r) => (
              <button
                type="button"
                key={r.id}
                role="radio"
                aria-checked={reason === r.id}
                className={`chip ${reason === r.id ? "selected" : ""}`}
                onClick={() => setReason(reason === r.id ? null : r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <Textarea
            value={comment}
            maxLength={500}
            rows={2}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Conte o que não funcionou ou o que faltou (opcional)"
            aria-label="Comentário"
          />
          <span className="tutorial-feedback-actions">
            <button type="button" className="text-btn" onClick={() => setAsking(false)} disabled={busy}>
              Agora não
            </button>
            <Button className="btn primary" onClick={() => void submit()} loading={busy}>
              Enviar
            </Button>
          </span>
        </div>
      )}
    </section>
  );
}

/** Os votos de um tutorial (quem edita): quem, o motivo, o comentário e a versão. */
export function FeedbackDialog({
  api,
  tutorial,
  version,
  onClose,
}: {
  api: TutorialsApi;
  tutorial: string;
  version: number;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TutorialFeedbackRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api
      .feedback(tutorial)
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, [api, tutorial]);
  const ups = rows?.filter((r) => r.vote === "up").length ?? 0;
  const downs = rows?.filter((r) => r.vote === "down").length ?? 0;
  return (
    <Modal title="Isso ajudou? · votos" onClose={onClose}>
      <div className="tutorial-feedback-dialog">
      {error && <p className="form-error">{error}</p>}
      {!rows ? (
        <Loading variant="list" />
      ) : !rows.length ? (
        <p className="tutorial-versions-empty">Ninguém votou ainda.</p>
      ) : (
        <>
          <p className="tutorial-feedback-sum">
            <ThumbsUp size={14} /> {ups} · <ThumbsDown size={14} /> {downs}
          </p>
          <ul className="tutorial-feedback-list">
            {rows.map((r) => (
              <li key={r.user_id} className={r.vote}>
                <span className="tutorial-feedback-who">
                  {r.vote === "up" ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}
                  <strong data-person={r.user_id}>{r.name}</strong>
                  <small>
                    {when(r.updated_at)} · versão {r.version}
                    {r.version < version ? " (anterior)" : ""}
                  </small>
                </span>
                {r.reason && <span className="tutorial-feedback-reason">{reasonLabel(r.reason)}</span>}
                {r.comment && <p>{r.comment}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      </div>
    </Modal>
  );
}
