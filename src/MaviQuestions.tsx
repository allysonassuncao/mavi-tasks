import { useState } from "react";
import { Check, CircleHelp, Send } from "lucide-react";
import type { QuestionArtifact } from "./mavi-artifacts";

/**
 * As perguntas da MAVI antes de seguir (como o Claude Code e o Codex): cada
 * uma com respostas prováveis e "Outro" para escrever. Responder manda as
 * respostas como a próxima mensagem; "Pode seguir" deixa a MAVI escolher.
 */
export function questionReply(
  a: QuestionArtifact,
  picks: string[][],
  other: string[],
) {
  const lines = a.questions.map((q, i) => {
    const answer = [...picks[i], other[i]?.trim()].filter(Boolean).join("; ");
    return `${i + 1}. ${q.question}\n→ ${answer || "tanto faz"}`;
  });
  return `Minhas respostas:\n${lines.join("\n")}`;
}

export function QuestionCard({
  artifact: a,
  answered,
  disabled,
  onReply,
}: {
  artifact: QuestionArtifact;
  /** A conversa já seguiu depois das perguntas. */
  answered: boolean;
  /** A resposta ainda está chegando, ou a conversa é só leitura. */
  disabled: boolean;
  onReply: (text: string) => void;
}) {
  const [picks, setPicks] = useState<string[][]>(() => a.questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => a.questions.map(() => ""));
  const [sent, setSent] = useState(false);
  const done = answered || sent;
  const ready = a.questions.every((_, i) => picks[i].length || other[i].trim());
  function toggle(i: number, option: string, multiple?: boolean) {
    setPicks((all) =>
      all.map((p, k) =>
        k !== i ? p : multiple ? (p.includes(option) ? p.filter((x) => x !== option) : [...p, option]) : p[0] === option ? [] : [option],
      ),
    );
    // Uma escolha única troca o "Outro".
    if (!multiple) setOther((all) => all.map((o, k) => (k === i ? "" : o)));
  }
  function send(text: string) {
    setSent(true);
    onReply(text);
  }
  return (
    <section className={`mavi-questions${done ? " done" : ""}`} aria-label="Perguntas da MAVI">
      <header>
        <CircleHelp size={15} aria-hidden="true" />
        <strong>{done ? "Perguntas respondidas" : "Antes de seguir, a MAVI quer saber"}</strong>
        {done && <Check size={14} aria-hidden="true" />}
      </header>
      <ol>
        {a.questions.map((q, i) => (
          <li key={i}>
            <p>{q.question}</p>
            {!done && (
              <>
                {!!q.options.length && (
                  <div className="mavi-question-options" role={q.multiple ? "group" : "radiogroup"}>
                    {q.options.map((o) => {
                      const on = picks[i].includes(o);
                      return (
                        <button
                          key={o}
                          type="button"
                          role={q.multiple ? "checkbox" : "radio"}
                          aria-checked={on}
                          className={on ? "on" : ""}
                          disabled={disabled}
                          onClick={() => toggle(i, o, q.multiple)}
                        >
                          {on && <Check size={12} aria-hidden="true" />}
                          {o}
                        </button>
                      );
                    })}
                  </div>
                )}
                <input
                  className="mavi-question-other"
                  placeholder={q.options.length ? "Outro (escreva)" : "Sua resposta"}
                  aria-label={`Outra resposta para: ${q.question}`}
                  value={other[i]}
                  disabled={disabled}
                  maxLength={400}
                  onChange={(e) => {
                    const v = e.target.value;
                    setOther((all) => all.map((x, k) => (k === i ? v : x)));
                    if (v && !q.multiple) setPicks((all) => all.map((p, k) => (k === i ? [] : p)));
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && ready && !disabled) {
                      e.preventDefault();
                      send(questionReply(a, picks, other));
                    }
                  }}
                />
              </>
            )}
          </li>
        ))}
      </ol>
      {!done && (
        <footer>
          <button
            type="button"
            className="mavi-question-skip"
            disabled={disabled}
            onClick={() => send("Pode seguir com o que achar melhor e me diga o que assumiu.")}
          >
            Pode seguir sem responder
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={disabled || !ready}
            onClick={() => send(questionReply(a, picks, other))}
          >
            <Send size={14} /> Responder
          </button>
        </footer>
      )}
    </section>
  );
}
