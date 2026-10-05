import { useEffect, useMemo, useRef, useState } from "react";
import { Film, Lightbulb, RotateCcw, Sparkles, Wand2 } from "lucide-react";
import { Modal } from "./components";
import { Button, Textarea } from "./ui";
import { RichTextContent } from "./RichTextContent";
import { draftBody, transcribedVideos, writerOutline, type WriterDraft, type WriterMode } from "./tutorial-writer";
import { moduleLabel, type TutorialMedia, type TutorialsApi } from "./tutorials";

const MODES: { id: WriterMode; label: string; icon: typeof Lightbulb }[] = [
  { id: "idea", label: "De uma ideia", icon: Lightbulb },
  { id: "video", label: "De um vídeo", icon: Film },
  { id: "improve", label: "Melhorar o texto", icon: Wand2 },
];

/**
 * A MAVI escreve o tutorial: de uma ideia, da transcrição de um vídeo do
 * tutorial ou melhorando o texto aberto. Mostra o resultado e só troca o
 * título, o resumo e o texto do editor quando quem escreve aplica. As
 * imagens e os vídeos do texto ficam (no lugar que a MAVI escolheu, ou no
 * fim).
 */
export function TutorialWriter({
  api,
  company,
  title,
  summary,
  body,
  modules,
  media,
  onApply,
  onClose,
}: {
  api: TutorialsApi;
  company: string;
  title: string;
  summary: string;
  body: string;
  modules: string[];
  media: TutorialMedia[];
  onApply: (draft: { title: string; summary: string; body: string }) => void;
  onClose: () => void;
}) {
  const outline = useMemo(() => writerOutline(body), [body]);
  const videos = useMemo(() => transcribedVideos(body, media), [body, media]);
  const [mode, setMode] = useState<WriterMode>(outline.text.trim() ? "improve" : "idea");
  const [idea, setIdea] = useState("");
  const [video, setVideo] = useState(videos[0]?.key ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<(WriterDraft & { body: string }) | null>(null);
  // O Mural abre o diálogo e leva o foco ao fechar; o campo pega o foco depois.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => field.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [mode, draft]);

  const run = async () => {
    setError("");
    setBusy(true);
    try {
      const picked = videos.find((v) => v.key === video);
      const r = await api.write(company, {
        mode,
        idea: idea.trim(),
        title,
        summary,
        source: mode === "video" ? (picked?.transcript ?? "") : mode === "improve" ? outline.text : "",
        media: outline.media.length,
        modules: modules.map(moduleLabel),
        module_ids: modules,
      });
      setDraft({ ...r, body: draftBody(r.blocks, outline.media) });
    } catch (e) {
      setError((e as Error).message || "A MAVI não conseguiu escrever agora.");
    } finally {
      setBusy(false);
    }
  };
  const canRun =
    mode === "idea" ? idea.trim().length >= 5 : mode === "video" ? !!video : outline.text.trim().length >= 20;
  const replaces = !!(title.trim() || summary.trim() || outline.text.trim());

  return (
    <Modal title="Escrever com a MAVI" className="tutorial-writer-modal" onClose={onClose} busy={busy}>
      {!draft ? (
        <div className="tutorial-writer">
          <div className="cases-tabs" role="tablist" aria-label="Como a MAVI escreve">
            {MODES.map((m) => (
              <button
                type="button"
                key={m.id}
                role="tab"
                aria-selected={mode === m.id}
                className={mode === m.id ? "active" : ""}
                onClick={() => setMode(m.id)}
                disabled={busy}
              >
                <m.icon size={15} /> {m.label}
              </button>
            ))}
          </div>
          {mode === "idea" && (
            <label className="field">
              <span>Do que é o tutorial?</span>
              <Textarea
                value={idea}
                onChange={(e) => setIdea(e.target.value)}
                rows={4}
                maxLength={3000}
                placeholder="Ex.: como o colaborador muda o prazo de uma tarefa, quando precisa de motivo e quem é avisado."
                disabled={busy}
                ref={field}
              />
              <small>A MAVI usa os tutoriais já publicados como referência e marca com [confirmar] o que não sabe.</small>
            </label>
          )}
          {mode === "video" &&
            (videos.length ? (
              <>
                <div className="tutorial-writer-videos" role="radiogroup" aria-label="Vídeo">
                  {videos.map((v) => (
                    <label key={v.key} className={`tutorial-writer-video ${video === v.key ? "on" : ""}`}>
                      <input
                        type="radio"
                        name="writer-video"
                        checked={video === v.key}
                        onChange={() => setVideo(v.key)}
                        disabled={busy}
                      />
                      <span>
                        <strong>{v.label}</strong>
                        <small>{v.transcript.slice(0, 140)}…</small>
                      </span>
                    </label>
                  ))}
                </div>
                <label className="field">
                  <span>O que destacar (opcional)</span>
                  <Textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={2} maxLength={3000} disabled={busy} />
                </label>
              </>
            ) : (
              <p className="tutorial-writer-empty">
                Nenhum vídeo com transcrição ainda. Envie um vídeo (a transcrição sai sozinha) ou cole a transcrição de um
                vídeo de link no player.
              </p>
            ))}
          {mode === "improve" &&
            (outline.text.trim().length >= 20 ? (
              <label className="field">
                <span>O que melhorar (opcional)</span>
                <Textarea
                  value={idea}
                  onChange={(e) => setIdea(e.target.value)}
                  rows={2}
                  maxLength={3000}
                  placeholder="Ex.: deixe mais curto e separe em passos."
                  disabled={busy}
                  ref={field}
                />
                <small>
                  A MAVI reorganiza em seções e passos, corrige e encurta, sem acrescentar informação. Imagens e vídeos ficam.
                </small>
              </label>
            ) : (
              <p className="tutorial-writer-empty">Escreva um pouco do tutorial antes de pedir para melhorar.</p>
            ))}
          {error && <p className="form-error">{error}</p>}
          <div className="tutorial-writer-actions">
            <Button className="btn primary" onClick={() => void run()} loading={busy} disabled={!canRun}>
              <Sparkles size={15} /> Escrever
            </Button>
          </div>
        </div>
      ) : (
        <div className="tutorial-writer-result">
          <h3>{draft.title}</h3>
          {draft.summary && <p className="tutorial-lead">{draft.summary}</p>}
          {draft.notes && <p className="tutorial-banner">{draft.notes}</p>}
          <div className="tutorial-writer-preview">
            <RichTextContent value={draft.body} />
          </div>
          {replaces && <small>Aplicar troca o título, o resumo e o texto do editor. Nada vai ao ar até você publicar.</small>}
          <div className="tutorial-writer-actions">
            <button type="button" className="text-btn" onClick={() => setDraft(null)}>
              <RotateCcw size={14} /> Tentar de novo
            </button>
            <Button
              className="btn primary"
              onClick={() => onApply({ title: draft.title, summary: draft.summary, body: draft.body })}
            >
              Aplicar no tutorial
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
