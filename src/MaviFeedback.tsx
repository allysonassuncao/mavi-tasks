import { useEffect, useState } from "react";
import { Check, Send, ThumbsDown, ThumbsUp, X } from "lucide-react";
import { MAVI_REASONS, voteAnswer, type MaviReason, type MyVote } from "./mavi-feedback";
import "./mavi-feedback.css";

/**
 * 👍/👎 numa resposta da MAVI (como no Copiloto das tarefas): o voto grava
 * na hora; o 👎 abre "O que faltou?" com os motivos e um comentário. Clicar
 * de novo no mesmo voto tira. A MAVI aprende com isso (e os líderes revisam).
 */
export function AnswerFeedback({
  message,
  mine,
  onChange,
}: {
  /** A resposta salva (ai_messages.id). */
  message: number;
  mine: MyVote | null;
  onChange: (vote: MyVote | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<MaviReason | null>(mine?.reason ?? null);
  const [comment, setComment] = useState(mine?.comment ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [thanks, setThanks] = useState(false);
  useEffect(() => {
    if (!thanks) return;
    const t = setTimeout(() => setThanks(false), 2500);
    return () => clearTimeout(t);
  }, [thanks]);

  async function send(vote: MyVote["vote"] | null, why: MaviReason | null = null, text = "") {
    setBusy(true);
    setError("");
    const before = mine;
    // Otimista: o botão muda na hora; volta se o banco recusar.
    onChange(vote ? { message, vote, reason: why, comment: text } : null);
    try {
      const saved = await voteAnswer(message, vote, why, text);
      onChange(saved ?? null);
      return true;
    } catch (e) {
      onChange(before);
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function up() {
    setOpen(false);
    void send(mine?.vote === "up" ? null : "up").then((ok) => ok && mine?.vote !== "up" && setThanks(true));
  }
  function down() {
    if (mine?.vote === "down") {
      setOpen(false);
      void send(null);
      return;
    }
    setReason(null);
    setComment("");
    setOpen(true);
    void send("down");
  }
  async function submit() {
    if (await send("down", reason, comment.trim())) {
      setOpen(false);
      setThanks(true);
    }
  }

  return (
    <span className="mavi-feedback">
      <button
        type="button"
        className={`mavi-vote${mine?.vote === "up" ? " on" : ""}`}
        aria-pressed={mine?.vote === "up"}
        aria-label="Boa resposta"
        title="Boa resposta"
        disabled={busy}
        onClick={up}
      >
        <ThumbsUp size={14} />
      </button>
      <button
        type="button"
        className={`mavi-vote down${mine?.vote === "down" ? " on" : ""}`}
        aria-pressed={mine?.vote === "down"}
        aria-label="Resposta ruim"
        title="Resposta ruim"
        disabled={busy}
        onClick={down}
      >
        <ThumbsDown size={14} />
      </button>
      {thanks && (
        <span className="mavi-feedback-thanks" role="status">
          <Check size={12} aria-hidden="true" /> Obrigado! A MAVI vai aprender com isso.
        </span>
      )}
      {error && (
        <span className="mavi-feedback-error" role="alert">
          {error}
        </span>
      )}
      {open && (
        <div className="mavi-feedback-panel" role="group" aria-label="O que faltou nesta resposta?">
          <header>
            <strong>O que faltou nesta resposta?</strong>
            <button type="button" aria-label="Fechar" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </header>
          <div className="mavi-feedback-reasons" role="radiogroup">
            {MAVI_REASONS.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={reason === r.id}
                className={reason === r.id ? "on" : ""}
                onClick={() => setReason(reason === r.id ? null : r.id)}
              >
                {reason === r.id && <Check size={12} aria-hidden="true" />}
                {r.label}
              </button>
            ))}
          </div>
          <textarea
            value={comment}
            maxLength={500}
            rows={2}
            placeholder="Opcional: o que a MAVI deveria ter feito? (ex.: “faltou a temperatura de cada cliente”)"
            aria-label="Comentário sobre a resposta"
            onChange={(e) => setComment(e.target.value)}
          />
          <footer>
            <small>A pergunta e um trecho da resposta vão para a revisão dos administradores e gestores.</small>
            <button type="button" className="btn primary" disabled={busy || (!reason && !comment.trim())} onClick={() => void submit()}>
              <Send size={13} /> Enviar
            </button>
          </footer>
        </div>
      )}
    </span>
  );
}
