import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Brain, RotateCcw, Undo2, X } from "lucide-react";
import { navigate, pageUrl, routeParts } from "./router";
import type { MemoryArtifact } from "./mavi-artifacts";
import { lookupTraits, setTrait, validityLabel, type TraitLookup } from "./mavi-person";
import "./mavi-memory.css";

/**
 * MAVI · memória de quem pergunta, na conversa (migração
 * 20270611090000_mavi_memory_person):
 * - o cartão "Anotei" (remember_about_me): o que a MAVI anotou, corrigiu ou
 *   tirou da memória, com Desfazer;
 * - o chip "Memória" da resposta: os itens que ela leu, cada um com "Não vale
 *   mais". Só quem pode ver a base da pessoa vê os textos (na conversa
 *   compartilhada, os colegas não veem).
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

/** O chip da resposta: os itens da memória que ela leu. */
export function MemoryChip({
  company,
  ids,
  notify,
}: {
  company: string;
  ids: string[];
  notify: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TraitLookup[] | null>(null);
  const [busy, setBusy] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    lookupTraits(company, ids)
      .then((list) => alive && setItems(list))
      .catch(() => alive && setItems([]));
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => {
      alive = false;
      document.removeEventListener("mousedown", close);
    };
  }, [open, company, ids]);

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

  return (
    <div className="mavi-memory-chip" ref={box}>
      <button
        type="button"
        className="mavi-memory-chip-btn"
        aria-expanded={open}
        title="O que a MAVI considerou sobre você nesta resposta"
        onClick={() => setOpen((v) => !v)}
      >
        <Brain size={13} aria-hidden="true" /> Memória · {ids.length}
      </button>
      {open && (
        <div className="mavi-memory-pop" role="dialog" aria-label="Memória usada nesta resposta">
          <strong>O que considerei sobre você</strong>
          {items === null ? (
            <p className="mavi-memory-note">Carregando…</p>
          ) : !items.length ? (
            <p className="mavi-memory-note">Só quem fez a pergunta vê estes itens.</p>
          ) : (
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
          )}
          <a className="mavi-memory-link" href={profileUrl()} onClick={openProfile}>
            Ver e editar a memória
          </a>
        </div>
      )}
    </div>
  );
}
