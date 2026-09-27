import { useState } from "react";
import { Check, Sparkles, Users, Wand2, X } from "lucide-react";
import { Button } from "./ui";
import { LevelChip } from "./NoticeParts";
import {
  FORMATS,
  matchAudience,
  noticePlain,
  noticeScope,
  plainToRich,
  type NoticeFormats,
  type NoticeLevel,
  type NoticesApi,
  type NoticeTarget,
  type WriterMode,
  type WriterResult,
  type WriterStyle,
} from "./notices";
import type { Snapshot } from "./types";

const STYLES: { value: WriterStyle; label: string }[] = [
  { value: "clear", label: "Mais claro" },
  { value: "short", label: "Mais curto" },
  { value: "formal", label: "Mais formal" },
  { value: "friendly", label: "Mais próximo" },
];

/**
 * A MAVI no formulário do aviso: escreve a partir de uma ideia, revisa o
 * texto e sugere nível, formatos e público. Só sugere — cada parte tem o seu
 * "Aplicar" — e nunca trava o formulário: enquanto ela pensa, dá para
 * continuar escrevendo.
 */
export function NoticeMavi({
  api,
  company,
  data,
  scope,
  demo,
  title,
  readBody,
  onText,
  onFormats,
  onTargets,
}: {
  api: NoticesApi;
  company: string;
  data: Snapshot;
  scope: ReturnType<typeof noticeScope>;
  demo: boolean;
  title: string;
  /** O texto do editor agora (texto rico). */
  readBody: () => string;
  onText: (title: string | undefined, body: string | undefined) => void;
  onFormats: (s: {
    level?: NoticeLevel;
    formats?: NoticeFormats;
    require_ack?: boolean;
  }) => void;
  onTargets: (targets: NoticeTarget[]) => void;
}) {
  const [idea, setIdea] = useState("");
  const [working, setWorking] = useState<string>("");
  const [result, setResult] = useState<
    (WriterResult & { mode: WriterMode }) | null
  >(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");

  async function ask(mode: WriterMode, style?: WriterStyle) {
    setError("");
    const text = noticePlain(readBody());
    if (mode === "write" && idea.trim().length < 3)
      return setError("Conte em poucas palavras do que é o aviso.");
    if (mode !== "write" && !text && !title.trim())
      return setError(
        "Escreva o aviso primeiro (ou peça para a MAVI escrever).",
      );
    setWorking(mode === "improve" ? `improve-${style}` : mode);
    try {
      const r = await api.writer(company, {
        mode,
        idea: idea.trim(),
        title: title.trim(),
        text,
        style,
      });
      setResult({ ...r, mode });
      setApplied(new Set());
    } catch (e) {
      setError((e as Error).message || "A MAVI não conseguiu responder agora.");
    } finally {
      setWorking("");
    }
  }

  const matched = result?.audience?.length
    ? matchAudience(result.audience, data, scope)
    : null;
  const done = (k: string) => setApplied((a) => new Set(a).add(k));
  const hasFormats =
    !!result &&
    (!!result.level || !!result.formats || result.require_ack !== undefined);

  return (
    <section className="notice-mavi" aria-label="MAVI">
      <header>
        <Sparkles size={16} aria-hidden="true" />
        <strong>MAVI</strong>
        <small>Sugere; nada muda no aviso sem você aplicar.</small>
      </header>
      <div className="notice-mavi-ask">
        <input
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder="Do que é o aviso? Ex.: sexta não tem expediente por causa do feriado"
          aria-label="Ideia do aviso para a MAVI"
          maxLength={2000}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!working) void ask("write");
            }
          }}
          disabled={demo}
        />
        <Button
          type="button"
          className="btn primary"
          loading={working === "write"}
          disabled={!!working || demo}
          onClick={() => void ask("write")}
        >
          <Wand2 size={16} /> Escrever
        </Button>
      </div>
      <div className="notice-mavi-tools">
        <span>Revisar o texto:</span>
        {STYLES.map((s) => (
          <button
            type="button"
            key={s.value}
            className="chip"
            disabled={!!working || demo}
            aria-busy={working === `improve-${s.value}` || undefined}
            onClick={() => void ask("improve", s.value)}
          >
            {working === `improve-${s.value}` ? "Revisando…" : s.label}
          </button>
        ))}
        <button
          type="button"
          className="chip"
          disabled={!!working || demo}
          onClick={() => void ask("suggest")}
        >
          {working === "suggest"
            ? "Pensando…"
            : "Sugerir nível, formatos e público"}
        </button>
      </div>
      {demo && (
        <small className="notice-mavi-note">
          Na demonstração a MAVI não escreve avisos.
        </small>
      )}
      {error && <p className="form-error">{error}</p>}

      {result && (
        <div className="notice-mavi-result">
          <button
            type="button"
            className="icon-btn notice-mavi-close"
            aria-label="Dispensar a sugestão"
            onClick={() => setResult(null)}
          >
            <X size={15} />
          </button>
          {(result.title || result.body) && (
            <div className="notice-mavi-part">
              <span className="notice-mavi-label">
                {result.mode === "improve"
                  ? "Texto revisado"
                  : "Texto sugerido"}
              </span>
              {result.title && <strong>{result.title}</strong>}
              {result.body && <p className="notice-mavi-body">{result.body}</p>}
              <Button
                type="button"
                className="btn secondary"
                disabled={applied.has("text")}
                onClick={() => {
                  onText(
                    result.title,
                    result.body ? plainToRich(result.body) : undefined,
                  );
                  done("text");
                }}
              >
                {applied.has("text") ? (
                  <>
                    <Check size={15} /> Aplicado
                  </>
                ) : (
                  "Usar este texto"
                )}
              </Button>
            </div>
          )}
          {hasFormats && (
            <div className="notice-mavi-part">
              <span className="notice-mavi-label">Como chega</span>
              <span className="notice-mavi-formats">
                {result.level && <LevelChip level={result.level} />}
                {result.formats &&
                  FORMATS.filter((f) => result.formats![f.key]).map((f) => (
                    <span key={f.key} className="notice-pin">
                      {f.label}
                    </span>
                  ))}
                {result.require_ack && (
                  <span className="notice-pin">Li e entendi</span>
                )}
              </span>
              {result.why && <small>{result.why}</small>}
              <Button
                type="button"
                className="btn secondary"
                disabled={applied.has("formats")}
                onClick={() => {
                  onFormats({
                    level: result.level,
                    formats: result.formats,
                    require_ack: result.require_ack,
                  });
                  done("formats");
                }}
              >
                {applied.has("formats") ? (
                  <>
                    <Check size={15} /> Aplicado
                  </>
                ) : (
                  "Aplicar nível e formatos"
                )}
              </Button>
            </div>
          )}
          {matched && (
            <div className="notice-mavi-part">
              <span className="notice-mavi-label">
                <Users size={13} aria-hidden="true" /> Público citado
              </span>
              {matched.targets.length ? (
                <span className="notice-mavi-formats">
                  {matched.targets.map((t) => (
                    <span key={`${t.kind}-${t.id}`} className="notice-pin">
                      {targetName(t, data)}
                    </span>
                  ))}
                </span>
              ) : null}
              {!!matched.missing.length && (
                <small>
                  Não encontrei no que você pode avisar:{" "}
                  {matched.missing.join(", ")}.
                </small>
              )}
              {!!matched.targets.length && (
                <Button
                  type="button"
                  className="btn secondary"
                  disabled={applied.has("audience")}
                  onClick={() => {
                    onTargets(matched.targets);
                    done("audience");
                  }}
                >
                  {applied.has("audience") ? (
                    <>
                      <Check size={15} /> Adicionado
                    </>
                  ) : (
                    "Adicionar ao público"
                  )}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function targetName(t: NoticeTarget, data: Snapshot) {
  if (t.kind === "everyone") return "Todos da agência";
  if (t.kind === "user")
    return data.members.find((m) => m.user_id === t.id)?.name ?? "Pessoa";
  if (t.kind === "team")
    return data.teams.find((x) => x.id === t.id)?.name ?? "Equipe";
  if (t.kind === "client")
    return data.clients.find((x) => x.id === t.id)?.name ?? "Cliente";
  return data.projects.find((x) => x.id === t.id)?.name ?? "Projeto";
}
