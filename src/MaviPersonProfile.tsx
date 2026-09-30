import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Brain, Check, Pencil, Pin, PinOff, Plus, RotateCcw, Sparkles, ThumbsDown, ThumbsUp, Trash2, User, X } from "lucide-react";
import { Button, Loading } from "./ui";
import { MAVI_REASON_LABELS } from "./mavi-feedback";
import {
  TRAIT_KINDS,
  personProfile,
  saveTrait,
  setTrait,
  type PersonProfile,
  type Trait,
  type TraitKind,
} from "./mavi-person";
import type { Snapshot } from "./types";
import "./mavi-person.css";

/**
 * O que a MAVI sabe de uma pessoa (a base de comportamento): as
 * preferências de resposta, o contexto de trabalho e o que evitar — o que a
 * MAVI aprendeu e o que a pessoa ou um líder escreveu —, o que o sistema sabe
 * sem modelo (equipes, clientes mais consultados) e o histórico das
 * avaliações dela. Em Meu perfil (a própria pessoa) e no Painel da MAVI (os
 * líderes). Escrever ou fixar um item: a MAVI não muda; remover: não volta.
 */
export function MaviPersonProfile({
  company,
  user,
  data,
  notify,
  initial = null,
}: {
  company: string;
  /** null: quem está logado. */
  user: string | null;
  data: Snapshot;
  notify: (message: string) => void;
  /** A base já carregada (testes): mostra sem buscar. */
  initial?: PersonProfile | null;
}) {
  const [profile, setProfile] = useState<PersonProfile | null>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<{ id: string | null; kind: TraitKind; text: string } | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);

  const load = useCallback(() => {
    setError("");
    personProfile(company, user)
      .then(setProfile)
      .catch((e) => setError((e as Error).message));
  }, [company, user]);
  useEffect(() => {
    if (initial) return;
    setProfile(null);
    setEditing(null);
    load();
  }, [load, initial]);

  const name = (id: string | null) => data.members.find((m) => m.user_id === id)?.name ?? "alguém";
  async function run(key: string, fn: () => Promise<unknown>, done: string) {
    setBusy(key);
    setError("");
    try {
      await fn();
      notify(done);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const ed = editing;
    void run(
      "save",
      async () => {
        await saveTrait(company, user, ed.id, ed.kind, ed.text.trim());
        setEditing(null);
      },
      ed.id ? "Item corrigido: a MAVI não muda mais." : "Item salvo: a MAVI passa a seguir.",
    );
  }

  if (!profile)
    return (
      <section className="panel mavi-person">
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : (
          <Loading variant="list" />
        )}
      </section>
    );

  const who = profile.self ? "você" : name(profile.user);
  const active = profile.items.filter((i) => !i.dismissed);
  const removed = profile.items.filter((i) => i.dismissed);
  const h = profile.history;
  const origin = (t: Trait) =>
    t.origin === "mavi"
      ? { icon: <Sparkles size={12} aria-hidden="true" />, label: t.pinned ? "Aprendido pela MAVI · fixado" : "Aprendido pela MAVI" }
      : t.origin === "person"
        ? { icon: <User size={12} aria-hidden="true" />, label: profile.self ? "Escrito por você" : `Escrito por ${name(profile.user)}` }
        : { icon: <User size={12} aria-hidden="true" />, label: `Escrito por ${name(t.updated_by)} (gestão)` };

  const editor = (kind: TraitKind) =>
    editing && editing.kind === kind ? (
      <form className="mavi-person-editor" onSubmit={submit}>
        <textarea
          value={editing.text}
          maxLength={300}
          rows={2}
          autoFocus
          placeholder={TRAIT_KINDS.find((k) => k.id === kind)?.example}
          aria-label="O que a MAVI deve saber"
          onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        />
        <div>
          <Button type="button" className="btn secondary" onClick={() => setEditing(null)}>
            <X size={14} /> Cancelar
          </Button>
          <Button className="btn primary" loading={busy === "save"} disabled={editing.text.trim().length < 3}>
            <Check size={14} /> Salvar
          </Button>
        </div>
      </form>
    ) : null;

  return (
    <section className="panel mavi-person" aria-label={`O que a MAVI sabe sobre ${who}`}>
      <header>
        <div>
          <h2>
            <Brain size={18} aria-hidden="true" /> O que a MAVI sabe sobre {who}
          </h2>
          <p>
            A MAVI usa isto para responder do jeito {profile.self ? "que você gosta" : "desta pessoa"}. Aprende sozinha
            com as conversas e as avaliações; {profile.self ? "você" : "a pessoa"} e os administradores e gestores veem e
            editam. O que alguém escreve ou fixa, a MAVI não muda; o que é removido, ela não traz de volta.
          </p>
          <small>
            {profile.built_at
              ? `Atualizado pela MAVI em ${new Date(profile.built_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`
              : "A MAVI ainda não montou esta base: ela aparece depois das primeiras conversas."}
            {profile.pending && profile.built_at ? " · há novidades para ela ler" : ""}
          </small>
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <div className="mavi-person-groups">
        {TRAIT_KINDS.map((k) => {
          const items = active.filter((i) => i.kind === k.id);
          return (
            <div key={k.id} className="mavi-person-group">
              <div className="mavi-person-group-head">
                <strong>{k.label}</strong>
                <small>{k.hint}</small>
                <button
                  type="button"
                  className="mavi-person-add"
                  disabled={!!editing}
                  onClick={() => setEditing({ id: null, kind: k.id, text: "" })}
                >
                  <Plus size={13} /> Adicionar
                </button>
              </div>
              {editing && !editing.id && editor(k.id)}
              {!items.length && !(editing && !editing.id && editing.kind === k.id) && (
                <p className="mavi-person-empty">Nada ainda.</p>
              )}
              <ul>
                {items.map((t) =>
                  editing?.id === t.id ? (
                    <li key={t.id}>{editor(k.id)}</li>
                  ) : (
                    <li key={t.id} className={t.pinned ? "pinned" : ""}>
                      <p>{t.text}</p>
                      <div className="mavi-person-meta">
                        <span>
                          {origin(t).icon} {origin(t).label}
                        </span>
                        <span className="mavi-person-actions">
                          <button
                            type="button"
                            title="Corrigir"
                            aria-label="Corrigir"
                            onClick={() => setEditing({ id: t.id, kind: t.kind, text: t.text })}
                          >
                            <Pencil size={13} />
                          </button>
                          {t.origin === "mavi" && (
                            <button
                              type="button"
                              title={t.pinned ? "Soltar (a MAVI pode ajustar)" : "Fixar (a MAVI não muda)"}
                              aria-label={t.pinned ? "Soltar" : "Fixar"}
                              disabled={busy === `p${t.id}`}
                              onClick={() =>
                                void run(`p${t.id}`, () => setTrait(company, t.id, t.pinned ? "unpin" : "pin"), t.pinned ? "Item solto." : "Item fixado.")
                              }
                            >
                              {t.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                            </button>
                          )}
                          <button
                            type="button"
                            title="Remover (a MAVI não traz de volta)"
                            aria-label="Remover"
                            disabled={busy === `d${t.id}`}
                            onClick={() => void run(`d${t.id}`, () => setTrait(company, t.id, "dismiss"), "Item removido.")}
                          >
                            <Trash2 size={13} />
                          </button>
                        </span>
                      </div>
                    </li>
                  ),
                )}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="mavi-person-facts">
        <div>
          <strong>O que o sistema já sabe</strong>
          <p>
            {profile.facts.teams.length ? `Equipes: ${profile.facts.teams.join(", ")}.` : "Sem equipe."}{" "}
            {profile.facts.clients.length
              ? `Clientes que ${profile.self ? "você mais consulta" : "mais consulta"} com a MAVI (90 dias): ${profile.facts.clients.map((c) => c.name).join(", ")}.`
              : ""}
          </p>
        </div>
        <div>
          <strong>Avaliações das respostas</strong>
          <p>
            <ThumbsUp size={12} aria-hidden="true" /> {h.up} · <ThumbsDown size={12} aria-hidden="true" /> {h.down}
            {Object.keys(h.reasons).length > 0 &&
              ` · ${Object.entries(h.reasons)
                .sort((a, b) => b[1] - a[1])
                .map(([r, n]) => `${MAVI_REASON_LABELS[r] ?? r} (${n})`)
                .join(", ")}`}
          </p>
          {h.recent.length > 0 && (
            <ul className="mavi-person-history">
              {h.recent.map((r, i) => (
                <li key={i}>
                  {r.vote === "up" ? "👍" : "👎"} {r.question ? `“${r.question}”` : "Resposta da MAVI"}
                  {r.reason ? ` · ${MAVI_REASON_LABELS[r.reason] ?? r.reason}` : ""}
                  {r.comment ? ` — ${r.comment}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {removed.length > 0 && (
        <div className="mavi-person-removed">
          <button type="button" onClick={() => setShowRemoved((v) => !v)}>
            {showRemoved ? "Esconder" : "Ver"} os {removed.length} removidos
          </button>
          {showRemoved && (
            <ul>
              {removed.map((t) => (
                <li key={t.id}>
                  <span>{t.text}</span>
                  <button
                    type="button"
                    disabled={busy === `r${t.id}`}
                    onClick={() => void run(`r${t.id}`, () => setTrait(company, t.id, "restore"), "Item de volta.")}
                  >
                    <RotateCcw size={12} /> Trazer de volta
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
