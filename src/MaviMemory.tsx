import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { BookMarked, Brain, Check, RotateCcw, Undo2, X } from "lucide-react";
import { navigate, pageUrl, routeParts } from "./router";
import type { DossierCheckArtifact, MemoryArtifact, MemoryReviewArtifact } from "./mavi-artifacts";
import { contestItem, decideProposal, lookupDossier, proposalState, type DossierLookup } from "./dossier-memory";
import { lookupTraits, setTrait, validityLabel, type TraitLookup } from "./mavi-person";
import "./mavi-memory.css";

/**
 * MAVI · memória de quem pergunta, na conversa (migração
 * 20270611090000_mavi_memory_person):
 * - o cartão "Anotei" (remember_about_me): o que a MAVI anotou, corrigiu ou
 *   tirou da memória, com Desfazer;
 * - o chip "Memória" da resposta: os itens que ela leu, cada um com "Não vale
 *   mais". Só quem pode ver a base da pessoa vê os textos (na conversa
 *   compartilhada, os colegas não veem). Com o dossiê do cliente (Fase 2,
 *   20270613090000_mavi_memory_client): "Está errado" contesta o item;
 * - o cartão "A MAVI notou… Confere?": uma sugestão do dossiê para quem
 *   trabalha com o cliente confirmar.
 */

const profileUrl = () =>
  pageUrl("profile", routeParts(typeof window === "undefined" ? "/" : window.location.pathname).company);
const openProfile = (e: ReactMouseEvent<HTMLAnchorElement>) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(profileUrl());
};

export function MemoryCard({
  artifact,
  company,
  readOnly,
  notify,
}: {
  artifact: MemoryArtifact;
  company: string;
  readOnly: boolean;
  notify: (message: string) => void;
}) {
  // undone: Desfazer já foi usado (aqui ou na tela do perfil); null: não dá para saber (não é a base de quem vê).
  const [undone, setUndone] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    lookupTraits(company, [artifact.item])
      .then((list) => {
        if (!alive) return;
        const t = list[0];
        setUndone(t ? (artifact.op === "forget" ? !t.dismissed : t.dismissed) : null);
      })
      .catch(() => alive && setUndone(null));
    return () => {
      alive = false;
    };
  }, [company, artifact.item, artifact.op]);

  async function undo() {
    setBusy(true);
    try {
      if (artifact.op === "forget") await setTrait(company, artifact.item, "restore");
      else {
        await setTrait(company, artifact.item, "dismiss");
        if (artifact.op === "replace" && artifact.previous_id) await setTrait(company, artifact.previous_id, "restore");
      }
      setUndone(true);
      notify("Desfeito: a memória voltou a ser como era.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title =
    artifact.op === "forget" ? "Tirei da sua memória" : artifact.op === "replace" ? "Corrigi na sua memória" : "Anotei na sua memória";
  return (
    <div className={`mavi-memory-card${undone ? " undone" : ""}`}>
      <Brain size={16} aria-hidden="true" />
      <span>
        <strong>{undone ? "Desfeito" : title}</strong>
        <small className={artifact.op === "forget" ? "gone" : undefined}>“{artifact.text}”</small>
        {artifact.previous && <small className="gone">antes: “{artifact.previous}”</small>}
        {artifact.durability === "situation" && !undone && <small>Passageiro: vale 60 dias.</small>}
      </span>
      {!readOnly && undone === false && (
        <button type="button" className="mavi-memory-undo" disabled={busy} onClick={() => void undo()}>
          <Undo2 size={13} aria-hidden="true" /> Desfazer
        </button>
      )}
      <a className="mavi-memory-link" href={profileUrl()} onClick={openProfile}>
        Ver memória
      </a>
    </div>
  );
}

/** O chip da resposta: os itens da memória e do dossiê do cliente que ela leu. */
export function MemoryChip({
  company,
  ids,
  clientIds = [],
  notify,
}: {
  company: string;
  ids: string[];
  /** Os itens do dossiê do cliente (migração 20270613090000_mavi_memory_client). */
  clientIds?: string[];
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TraitLookup[] | null>(null);
  const [client, setClient] = useState<(DossierLookup & { contested?: boolean })[] | null>(null);
  const [busy, setBusy] = useState("");
  // O item do dossiê que a pessoa está contestando (e o porquê).
  const [contesting, setContesting] = useState<{ id: string; reason: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    lookupTraits(company, ids)
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]));
    lookupDossier(company, clientIds)
      .then((list) => alive && setClient(list))
      .catch(() => alive && setClient([]));
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", close);
    };
  }, [open, company, ids, clientIds]);

  async function toggle(t: TraitLookup) {
    setBusy(t.id);
    try {
      await setTrait(company, t.id, t.dismissed ? "restore" : "dismiss");
      setItems((list) => (list ?? []).map((x) => (x.id === t.id ? { ...x, dismissed: !t.dismissed } : x)));
      notify(t.dismissed ? "De volta à memória." : "Tirado da memória: a MAVI não usa mais.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function contest() {
    if (!contesting) return;
    const c = contesting;
    setBusy(c.id);
    try {
      await contestItem(company, c.id, c.reason.trim());
      setClient((list) => (list ?? []).map((x) => (x.id === c.id ? { ...x, contested: true } : x)));
      setContesting(null);
      notify("Contestado: o item saiu do dossiê e foi para os líderes decidirem.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const total = ids.length + clientIds.length;
  const loading = (ids.length && items === null) || (clientIds.length && client === null);
  return (
    <div className="mavi-memory-chip" ref={box}>
      <button
        type="button"
        className="mavi-memory-chip-btn"
        aria-expanded={open}
        title="O que a MAVI considerou sobre você e sobre o cliente nesta resposta"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={13} aria-hidden="true" /> Memória · {total}
      </button>
      {open && (
        <div className="mavi-memory-pop" role="dialog" aria-label="Memória usada nesta resposta">
          {loading ? (
            <p className="mavi-memory-note">Carregando…</p>
          ) : !(items?.length || client?.length) ? (
            <p className="mavi-memory-note">Só quem fez a pergunta vê estes itens.</p>
          ) : (
            <>
              {!!items?.length && (
                <>
                  <strong>O que considerei sobre você</strong>
                  <ul>
                    {items.map((t) => (
                      <li key={t.id} className={t.dismissed ? "gone" : undefined}>
                        <span>
                          {t.text}
                          {validityLabel(t) && <small>{validityLabel(t)}</small>}
                        </span>
                        <button
                          type="button"
                          disabled={busy === t.id}
                          title={t.dismissed ? "Trazer de volta" : "Não vale mais (a MAVI não usa e não traz de volta)"}
                          onClick={() => void toggle(t)}
                        >
                          {t.dismissed ? <RotateCcw size={12} aria-hidden="true" /> : <X size={12} aria-hidden="true" />}
                          {t.dismissed ? "Trazer de volta" : "Não vale mais"}
                        </button>
                      </li>
                    ))}
                  </ul>
                  <a className="mavi-memory-link" href={profileUrl()} onClick={openProfile}>
                    Ver e editar a memória
                  </a>
                </>
              )}
              {!!client?.length && (
                <>
                  <strong>O que considerei sobre o cliente</strong>
                  <ul>
                    {client.map((t) =>
                      contesting?.id === t.id ? (
                        <li key={t.id} className="mavi-memory-contest">
                          <span>{t.text}</span>
                          <input
                            autoFocus
                            maxLength={300}
                            placeholder="O que está errado? (opcional)"
                            aria-label="O que está errado"
                            value={contesting.reason}
                            onChange={(e) => setContesting({ ...contesting, reason: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void contest();
                              if (e.key === "Escape") setContesting(null);
                            }}
                          />
                          <div>
                            <button type="button" onClick={() => setContesting(null)}>
                              Cancelar
                            </button>
                            <button type="button" className="strong" disabled={busy === t.id} onClick={() => void contest()}>
                              Contestar
                            </button>
                          </div>
                        </li>
                      ) : (
                        <li key={t.id} className={t.contested || t.dismissed ? "gone" : undefined}>
                          <span>
                            {t.text}
                            {t.contested && <small>Contestado: com os líderes</small>}
                          </span>
                          {!t.contested && !t.dismissed && (
                            <button
                              type="button"
                              title="Está errado: sai do dossiê na hora e vai para os líderes"
                              onClick={() => setContesting({ id: t.id, reason: "" })}
                            >
                              <X size={12} aria-hidden="true" /> Está errado
                            </button>
                          )}
                        </li>
                      ),
                    )}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** "A MAVI notou… Confere?": uma sugestão do dossiê para confirmar ou recusar. */
export function DossierCheckCard({
  artifact,
  company,
  readOnly,
  notify,
}: {
  artifact: DossierCheckArtifact;
  company: string;
  readOnly: boolean;
  notify: (message: string) => void;
}) {
  // null: ainda não sabe (ou quem vê não vê o dossiê do cliente).
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    proposalState(company, [artifact.proposal])
      .then((list) => alive && setStatus(list[0]?.status ?? "hidden"))
      .catch(() => alive && setStatus("hidden"));
    return () => {
      alive = false;
    };
  }, [company, artifact.proposal]);

  async function decide(decision: "confirm" | "refuse") {
    setBusy(true);
    try {
      const r = await decideProposal(company, artifact.proposal, decision);
      setStatus(r.status);
      notify(
        r.status === "confirmed"
          ? "Confirmado: entrou no dossiê do cliente."
          : r.status === "refused"
            ? "Recusado: a MAVI não propõe de novo."
            : "Esta sugestão já não está aberta.",
      );
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (status === "hidden") return null;
  const done = status && status !== "suggested";
  const what =
    artifact.op === "remove"
      ? "deixou de valer"
      : artifact.op === "update"
        ? "mudou"
        : artifact.op === "review"
          ? "ainda vale"
          : "é assim";
  return (
    <div className={`mavi-memory-card dossier-check${done ? " undone" : ""}`}>
      <BookMarked size={16} aria-hidden="true" />
      <span>
        <strong>
          {status === "confirmed"
            ? "Confirmado no dossiê"
            : status === "refused"
              ? "Recusado"
              : status === "expired"
                ? "Sugestão vencida"
                : `A MAVI notou sobre ${artifact.client || "o cliente"}: ${what}?`}
        </strong>
        <small className={artifact.op === "remove" ? "gone" : undefined}>“{artifact.text}”</small>
        {artifact.previous && <small className="gone">antes: “{artifact.previous}”</small>}
        {!done && (
          <small>
            {[
              artifact.reasons.length ? `Pede confirmação: ${artifact.reasons.join(", ")}` : "",
              artifact.sources.length ? `De: ${artifact.sources.map((s) => s.title).slice(0, 2).join(", ")}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        )}
      </span>
      {!readOnly && status === "suggested" && (
        <span className="dossier-check-actions">
          <button type="button" className="mavi-memory-undo" disabled={busy} onClick={() => void decide("confirm")}>
            <Check size={13} aria-hidden="true" /> {artifact.op === "review" ? "Ainda vale" : "Está certo"}
          </button>
          <button type="button" className="mavi-memory-undo no" disabled={busy} onClick={() => void decide("refuse")}>
            <X size={13} aria-hidden="true" /> {artifact.op === "review" ? "Não vale mais" : "Não está"}
          </button>
        </span>
      )}
    </div>
  );
}

/** "Isso ainda vale?": um item de situação vencido da memória de quem perguntou. */
export function MemoryReviewCard({
  artifact,
  company,
  readOnly,
  notify,
}: {
  artifact: MemoryReviewArtifact;
  company: string;
  readOnly: boolean;
  notify: (message: string) => void;
}) {
  // renewed/gone: já decidido (aqui ou no perfil); null: ainda não sabe.
  const [state, setState] = useState<"open" | "renewed" | "gone" | "hidden" | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    lookupTraits(company, [artifact.item])
      .then((list) => {
        if (!alive) return;
        const t = list[0];
        setState(!t ? "hidden" : t.dismissed ? "gone" : t.expired ? "open" : "renewed");
      })
      .catch(() => alive && setState("hidden"));
    return () => {
      alive = false;
    };
  }, [company, artifact.item]);

  async function decide(action: "renew" | "dismiss") {
    setBusy(true);
    try {
      await setTrait(company, artifact.item, action);
      setState(action === "renew" ? "renewed" : "gone");
      notify(action === "renew" ? "Renovado: vale mais 60 dias." : "Tirado da memória: a MAVI não usa mais.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (state === "hidden") return null;
  const until = artifact.valid_until
    ? new Date(artifact.valid_until).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit" })
    : "";
  return (
    <div className={`mavi-memory-card${state === "gone" ? " undone" : ""}`}>
      <Brain size={16} aria-hidden="true" />
      <span>
        <strong>
          {state === "renewed" ? "Renovado na sua memória" : state === "gone" ? "Tirado da sua memória" : "Isso ainda vale?"}
        </strong>
        <small>“{artifact.text}”</small>
        {state !== "renewed" && state !== "gone" && until && (
          <small>Venceu em {until}: a MAVI parou de usar até você dizer.</small>
        )}
      </span>
      {!readOnly && state === "open" && (
        <span className="dossier-check-actions">
          <button type="button" className="mavi-memory-undo" disabled={busy} onClick={() => void decide("renew")}>
            <Check size={13} aria-hidden="true" /> Ainda vale
          </button>
          <button type="button" className="mavi-memory-undo no" disabled={busy} onClick={() => void decide("dismiss")}>
            <X size={13} aria-hidden="true" /> Não vale mais
          </button>
        </span>
      )}
    </div>
  );
}
