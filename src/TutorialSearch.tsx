import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, GraduationCap, Plus, RotateCcw, Sparkles } from "lucide-react";
import { Empty } from "./components";
import { Button, Loading, Skeleton } from "./ui";
import {
  moduleLabel,
  tutorialQueryWords,
  type TutorialAnswer,
  type TutorialHit,
  type TutorialSearchQuery,
  type TutorialsApi,
} from "./tutorials";

/** A letra sem acento e minúscula, uma por uma (as posições batem com o texto). */
const foldEach = (text: string) =>
  [...text]
    .map((c) => {
      const f = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      return f.length === 1 ? f : c;
    })
    .join("");
export const queryWords = (query: string) => tutorialQueryWords(foldEach(query));

/**
 * O pedaço da seção em volta da primeira palavra buscada, com as palavras
 * marcadas (sem acento e sem diferença de maiúscula).
 */
export function snippet(content: string, words: string[], size = 220) {
  const text = content.replace(/^Seção: [^\n]*\n/, "").replace(/\s+/g, " ").trim();
  const folded = foldEach(text);
  const first = words
    .map((w) => folded.indexOf(w))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  const start = first === undefined || first < size / 3 ? 0 : first - Math.round(size / 3);
  const end = Math.min(text.length, start + size);
  const piece = text.slice(start, end);
  const marks: [number, number][] = [];
  const foldedPiece = folded.slice(start, end);
  for (const w of words) {
    let i = foldedPiece.indexOf(w);
    while (i >= 0) {
      marks.push([i, i + w.length]);
      i = foldedPiece.indexOf(w, i + w.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (const [a, b] of marks) {
    if (a < at) continue;
    if (a > at) parts.push({ text: piece.slice(at, a), mark: false });
    parts.push({ text: piece.slice(a, b), mark: true });
    at = b;
  }
  if (at < piece.length) parts.push({ text: piece.slice(at), mark: false });
  return { parts, before: start > 0, after: end < text.length };
}

/** As seções agrupadas por tutorial, na ordem em que a busca as trouxe. */
export function groupHits(hits: TutorialHit[], perTutorial = 3) {
  const groups: { tutorial: TutorialHit; sections: TutorialHit[] }[] = [];
  for (const h of hits) {
    const g = groups.find((x) => x.tutorial.tutorial_id === h.tutorial_id);
    if (!g) groups.push({ tutorial: h, sections: [h] });
    else if (g.sections.length < perTutorial && !g.sections.some((s) => s.anchor === h.anchor))
      g.sections.push(h);
  }
  return groups;
}

/**
 * Os resultados da busca com a MAVI (Enter na página Tutoriais): a resposta
 * curta dela no topo (citando as seções) e as seções encontradas, agrupadas
 * por tutorial, cada uma levando direto ao trecho.
 */
export function TutorialSearchResults({
  api,
  company,
  query,
  isLeader,
  onOpen,
  onCreate,
}: {
  api: TutorialsApi;
  company: string;
  query: TutorialSearchQuery;
  isLeader: boolean;
  /** searchId: a busca registrada (as métricas contam o que abriu dela). */
  onOpen: (tutorial: string, anchor: string, searchId: number | null) => void;
  onCreate: (question: string) => void;
}) {
  const [hits, setHits] = useState<TutorialHit[] | null>(null);
  const [error, setError] = useState("");
  const [embedding, setEmbedding] = useState<string | null>(null);
  const [searchId, setSearchId] = useState<number | null>(null);
  const [answer, setAnswer] = useState<TutorialAnswer | null>(null);
  const [answerError, setAnswerError] = useState("");
  const [answering, setAnswering] = useState(false);
  const words = useMemo(() => queryWords(query.query), [query.query]);

  const ask = (vector: string | null) => {
    setAnswering(true);
    setAnswerError("");
    api
      .answer(company, { ...query, embedding: vector })
      .then(setAnswer)
      .catch((e) => setAnswerError((e as Error).message || "A MAVI não conseguiu responder agora."))
      .finally(() => setAnswering(false));
  };
  useEffect(() => {
    let alive = true;
    api
      .search(company, query)
      .then((r) => {
        if (!alive) return;
        setHits(r.hits);
        setEmbedding(r.embedding);
        setSearchId(r.search_id ?? null);
        if (r.hits.length) ask(r.embedding);
      })
      .catch((e) => alive && setError((e as Error).message || "Não foi possível buscar nos tutoriais."));
    return () => {
      alive = false;
    };
    // A chave do componente muda com a busca.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p className="form-error">{error}</p>;
  if (hits === null)
    return (
      <div className="tutorial-results">
        <div className="tutorial-answer loading" role="status" aria-label="Buscando nos tutoriais">
          <Skeleton className="skeleton-inline" />
          <Skeleton className="skeleton-inline" />
        </div>
        <Loading variant="list" />
      </div>
    );
  const groups = groupHits(hits);
  const create = isLeader ? (
    <Button className="btn secondary" onClick={() => onCreate(query.query)}>
      <Plus size={15} /> Escrever um tutorial sobre isso
    </Button>
  ) : undefined;
  if (!groups.length)
    return (
      <div className="panel">
        <Empty
          title="Ainda não há tutorial sobre isso"
          body={
            isLeader
              ? "A dúvida ficou em Dúvidas sem tutorial. Tente outras palavras ou escreva o tutorial."
              : "A dúvida foi registrada para os administradores e gestores escreverem o tutorial. Tente outras palavras ou pergunte à MAVI."
          }
          action={create}
        />
      </div>
    );

  const cite = (n: number) => answer?.citations.find((c) => c.n === n);
  // "[1]" na resposta vira o atalho para a seção citada.
  const answerText = (text: string): ReactNode[] =>
    text.split(/(\[\d+\])/g).map((part, i) => {
      const n = /^\[(\d+)\]$/.exec(part)?.[1];
      const c = n ? cite(Number(n)) : undefined;
      return c ? (
        <button
          type="button"
          key={i}
          className="tutorial-cite"
          title={`${c.title}${c.section ? ` › ${c.section}` : ""}`}
          onClick={() => onOpen(c.tutorial_id, c.anchor, searchId)}
        >
          {n}
        </button>
      ) : (
        <Fragment key={i}>{n ? "" : part}</Fragment>
      );
    });

  return (
    <div className="tutorial-results">
      <section className="tutorial-answer" aria-live="polite">
        <span className="tutorial-answer-head">
          <Sparkles size={15} aria-hidden="true" /> A MAVI responde
        </span>
        {answering ? (
          <div role="status" aria-label="A MAVI está escrevendo">
            <Skeleton className="skeleton-inline" />
            <Skeleton className="skeleton-inline" />
          </div>
        ) : answerError ? (
          <p className="tutorial-answer-error">
            {answerError}{" "}
            <button type="button" className="text-btn" onClick={() => ask(embedding)}>
              <RotateCcw size={13} /> Tentar de novo
            </button>
          </p>
        ) : answer?.found ? (
          <>
            <p>{answerText(answer.answer)}</p>
            {!!answer.citations.length && (
              <span className="tutorial-answer-sources">
                {answer.citations.map((c) => (
                  <button
                    type="button"
                    key={c.n}
                    className="chip"
                    onClick={() => onOpen(c.tutorial_id, c.anchor, searchId)}
                  >
                    <b>{c.n}</b> {c.title}
                    {c.section ? ` › ${c.section}` : ""}
                  </button>
                ))}
              </span>
            )}
          </>
        ) : answer ? (
          <p className="tutorial-answer-none">
            Os tutoriais abaixo falam do assunto, mas nenhum responde a isso diretamente. A dúvida
            foi registrada para quem escreve os tutoriais.
            {create && <span className="tutorial-answer-create">{create}</span>}
          </p>
        ) : null}
      </section>

      <p className="cases-count">
        {groups.length === 1 ? "1 tutorial" : `${groups.length} tutoriais`} para “{query.query}”
        {query.module ? ` em ${moduleLabel(query.module)}` : ""}
      </p>
      <ul className="tutorial-hits">
        {groups.map(({ tutorial, sections }) => (
          <li key={tutorial.tutorial_id} className="tutorial-hit">
            <button
              type="button"
              className="tutorial-hit-title"
              onClick={() => onOpen(tutorial.tutorial_id, "", searchId)}
            >
              <GraduationCap size={17} aria-hidden="true" />
              <span>
                {tutorial.category && <small>{tutorial.category}</small>}
                <strong>{tutorial.title}</strong>
              </span>
            </button>
            {!!tutorial.modules.length && (
              <span className="tutorial-modules">
                {tutorial.modules.slice(0, 4).map((m) => (
                  <span key={m} className="tutorial-module">
                    {moduleLabel(m)}
                  </span>
                ))}
              </span>
            )}
            <ul className="tutorial-hit-sections">
              {sections.map((sec) => {
                const piece = snippet(sec.content, words);
                return (
                  <li key={sec.chunk_id}>
                    <button type="button" onClick={() => onOpen(sec.tutorial_id, sec.anchor, searchId)}>
                      <span className="tutorial-hit-section">
                        {sec.section || "Introdução"}
                        <ArrowRight size={13} aria-hidden="true" />
                      </span>
                      <span className="tutorial-hit-snippet">
                        {piece.before && "… "}
                        {piece.parts.map((p, i) =>
                          p.mark ? <mark key={i}>{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>,
                        )}
                        {piece.after && " …"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
