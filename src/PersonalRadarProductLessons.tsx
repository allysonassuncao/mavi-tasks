import { useCallback, useEffect, useState } from "react";
import { Button, Loading, Select, SelectOption, Textarea } from "./ui";
import {
  LESSON_KIND_LABEL,
  LESSON_STATUS_LABEL,
  loadProductLessons,
  saveProductLesson,
  setProductLesson,
  type Lesson,
  type LessonKind,
  type ProductLessonsView,
} from "./personal-radar";

/**
 * Radar pessoal › Aprendizado › Por produto (migration
 * 20270512090000_radar_agents_learning): as lições que valem para todas as
 * respostas de um produto. A MAVI sugere a partir dos retornos de todo o time
 * nesse produto, o Jev confere e um administrador ou gestor aprova; líderes
 * também escrevem as suas (valem na hora), editam, pausam e excluem. Os
 * demais veem só as em uso dos produtos dos clientes que atendem.
 */
export function ProductLessons({ company, notify }: { company: string; notify: (message: string) => void }) {
  const [view, setView] = useState<ProductLessonsView | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; product: string; kind: LessonKind; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Os produtos abertos: de início, os com sugestão para aprovar.
  const [opened, setOpened] = useState<Set<string> | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    loadProductLessons(company)
      .then((v) => {
        setView(v);
        setOpened(
          (o) => o ?? new Set(v.products.filter((p) => p.suggested > 0 || v.products.length === 1).map((p) => p.id)),
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [company]);
  useEffect(load, [load]);
  // O Jev conferiu uma sugestão: a lista se atualiza.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<{ lessons?: boolean }>).detail?.lessons) load();
    };
    window.addEventListener("mavi:personal-radar", on);
    return () => window.removeEventListener("mavi:personal-radar", on);
  }, [load]);
  const run = (work: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError("");
    work()
      .then(() => {
        notify(message);
        setEditing(null);
        load();
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  if (!view) return error ? <p className="form-error">{error}</p> : <Loading variant="list" />;
  const can = view.can_edit;
  const products = can ? view.products : view.products.filter((p) => p.lessons.length);

  const form = (product: string) =>
    editing?.product === product && (
      <div className="pradar-dismiss">
        <Select aria-label="Tipo da lição" value={editing.kind} onValueChange={(v) => setEditing({ ...editing, kind: v as LessonKind })}>
          <SelectOption value="reply">{LESSON_KIND_LABEL.reply}</SelectOption>
          <SelectOption value="detection">O que é uma situação</SelectOption>
        </Select>
        <Textarea
          rows={2}
          maxLength={400}
          value={editing.text}
          placeholder="Ex.: Pedido de ajuste no robô: confirme o que muda, quem aprova e quando entra no ar."
          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        />
        <div className="pradar-actions">
          <Button
            className="btn primary compact"
            loading={busy}
            disabled={editing.text.trim().length < 5}
            onClick={() =>
              run(
                () => saveProductLesson(company, editing.id, editing.product, editing.kind, editing.text),
                editing.id ? "Lição salva." : "Lição do produto salva: já vale nas respostas.",
              )
            }
          >
            Salvar
          </Button>
          <Button className="btn secondary compact" onClick={() => setEditing(null)} disabled={busy}>
            Cancelar
          </Button>
        </div>
      </div>
    );

  const row = (l: Lesson, product: string) => (
    <li key={l.id} className={`pradar-lesson status-${l.status}`}>
      <div className="pradar-lesson-top">
        <span className={`pradar-lesson-kind k-${l.kind}`}>{l.kind === "reply" ? LESSON_KIND_LABEL.reply : "O que é uma situação"}</span>
        <span className={`pradar-lesson-status s-${l.status}`}>{LESSON_STATUS_LABEL[l.status]}</span>
        <span className="muted">
          {l.origin === "mavi"
            ? `sugerida pela MAVI${l.evidence ? ` · ${l.evidence} ${l.evidence === 1 ? "retorno" : "retornos"}` : ""}`
            : "por um líder"}
        </span>
      </div>
      <p>{l.text}</p>
      {l.check_note && <p className="pradar-lesson-note muted">{l.check_note}</p>}
      {can && (
        <div className="pradar-actions">
          {(l.status === "suggested" || l.status === "refused") && (
            <Button className="btn primary compact" loading={busy} onClick={() => run(() => setProductLesson(company, l.id, "active"), "Lição aprovada: já vale nas respostas.")}>
              Aprovar
            </Button>
          )}
          {l.status === "paused" && (
            <Button className="btn quiet compact" onClick={() => run(() => setProductLesson(company, l.id, "active"), "Lição ligada.")}>
              Ligar
            </Button>
          )}
          {l.status !== "dismissed" && l.status !== "checking" && (
            <Button className="btn quiet compact" onClick={() => setEditing({ id: l.id, product, kind: l.kind, text: l.text })}>
              Editar
            </Button>
          )}
          {l.status === "active" && (
            <Button className="btn quiet compact" onClick={() => run(() => setProductLesson(company, l.id, "paused"), "Lição pausada.")}>
              Pausar
            </Button>
          )}
          {l.status !== "dismissed" && (
            <Button
              className="btn quiet compact"
              onClick={() =>
                run(
                  () => setProductLesson(company, l.id, "dismissed"),
                  l.status === "suggested" ? "Sugestão recusada. A MAVI não sugere de novo." : "Lição excluída.",
                )
              }
            >
              {l.status === "suggested" || l.status === "refused" ? "Recusar" : "Excluir"}
            </Button>
          )}
        </div>
      )}
      {editing?.id === l.id && form(product)}
    </li>
  );

  return (
    <section>
      <small className="muted">
        {can
          ? "Valem para todas as respostas sugeridas nas situações do produto, de qualquer pessoa. A MAVI sugere lições a partir do que o time copia, edita, reprova e ensina; o Jev confere e elas só valem depois que você ou outro líder aprovar."
          : "As lições dos produtos dos seus clientes que a MAVI segue ao escrever as respostas. Administradores e gestores cuidam delas."}
      </small>
      {!products.length && <p className="muted pradar-empty-note">Nenhuma lição de produto ainda.</p>}
      {products.map((p) => {
        const shown = p.lessons.filter((l) => l.status !== "dismissed");
        const gone = p.lessons.filter((l) => l.status === "dismissed");
        return (
          <details
            key={p.id}
            className="pradar-product-lessons"
            open={!!opened?.has(p.id)}
            onToggle={(e) => {
              const isOpen = (e.currentTarget as HTMLDetailsElement).open;
              setOpened((o) => {
                const next = new Set(o ?? []);
                if (isOpen) next.add(p.id);
                else next.delete(p.id);
                return next;
              });
            }}
          >
            <summary>
              <strong>{p.name}</strong>
              <span className="muted">
                {" "}
                · {shown.length} {shown.length === 1 ? "lição" : "lições"}
              </span>
              {p.suggested > 0 && <span className="pradar-lesson-status s-suggested"> {p.suggested} para aprovar</span>}
            </summary>
            {can && editing?.product !== p.id && (
              <Button className="btn secondary compact" onClick={() => setEditing({ id: null, product: p.id, kind: "reply", text: "" })}>
                Escrever uma lição
              </Button>
            )}
            {editing?.product === p.id && !editing.id && form(p.id)}
            {shown.length ? (
              <ul className="pradar-lessons">{shown.map((l) => row(l, p.id))}</ul>
            ) : (
              <p className="muted pradar-empty-note">Nenhuma ainda.</p>
            )}
            {can && gone.length > 0 && (
              <details className="pradar-dismissed">
                <summary>Recusadas e excluídas ({gone.length})</summary>
                <ul className="pradar-lessons">{gone.map((l) => row(l, p.id))}</ul>
              </details>
            )}
          </details>
        );
      })}
      {error && <p className="form-error">{error}</p>}
    </section>
  );
}
