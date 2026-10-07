import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  BookMarked,
  Check,
  Flag,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import { Button, Loading, Select, SelectOption, Textarea } from "./ui";
import { Empty } from "./components";
import { supabase } from "./supabase";
import type { Snapshot } from "./types";
import {
  PROPOSAL_OP,
  contestItem,
  decideProposal,
  isNew,
  resolveContest,
  type DossierProposal,
} from "./dossier-memory";
import "./dossier-memory.css";

/**
 * Drive › cliente › Dossiê da MAVI: o que quem cria tarefas para o cliente
 * precisa saber (gosta, não gosta, regras, tom, contexto, histórico). A MAVI
 * mantém sozinha com o material novo do cliente; administradores e gestores
 * escrevem, corrigem, fixam (a MAVI não muda) e removem (a MAVI não traz de
 * volta). É o começo de toda análise do Assistente MAVI nas tarefas.
 *
 * Fase 2 da memória por cliente (migração 20270613090000_mavi_memory_client):
 * o que a MAVI pôs sozinha fica com "Novo" por 7 dias; o de risco alto
 * aparece em "Para confirmar" (quem vê o dossiê confirma ou recusa; vence em
 * 14 dias); "Está errado" contesta um item (sai na hora) e os líderes
 * restauram ou descartam em "Contestados".
 */

export type DossierKind =
  "prefers" | "avoids" | "rule" | "style" | "context" | "history";
export type DossierItem = {
  id: string;
  kind: DossierKind;
  text: string;
  origin: "mavi" | "person";
  pinned: boolean;
  dismissed: boolean;
  sources: { type: string; title: string; date: string | null }[];
  seen_at: string | null;
  updated_at: string;
  updated_by: string | null;
  created_at?: string | null;
};
export type Dossier = {
  items: DossierItem[];
  version: number;
  built_at: string | null;
  pending: boolean;
  failed: boolean;
  can_edit: boolean;
  /** Quem vê o dossiê confirma as sugestões (20270613090000). */
  can_confirm?: boolean;
  proposals?: DossierProposal[];
  /** Só para líderes. */
  contested?: DossierProposal[];
};

export const DOSSIER_KINDS: { id: DossierKind; label: string; hint: string }[] =
  [
    {
      id: "avoids",
      label: "Não gosta",
      hint: "O que recusou, reclamou ou pediu para não fazer",
    },
    {
      id: "prefers",
      label: "Prefere",
      hint: "O que gosta, aprovou e quer repetido",
    },
    {
      id: "rule",
      label: "Regras e combinados",
      hint: "Aprovações, prazos, quem aprova, canais",
    },
    {
      id: "style",
      label: "Tom e identidade",
      hint: "Voz, cores, linguagem, palavras proibidas",
    },
    {
      id: "context",
      label: "Contexto do negócio",
      hint: "Produtos, público, ofertas, sazonalidade",
    },
    {
      id: "history",
      label: "Histórico",
      hint: "Problemas e decisões que pesam nas entregas",
    },
  ];
const SOURCE_LABELS: Record<string, string> = {
  meeting: "Reunião",
  whatsapp: "WhatsApp",
  task: "Tarefa",
  drive_file: "Arquivo",
  social_briefing: "Social Leads",
  social_plan: "Social Leads",
  campaign: "Campanha",
  client_note: "Anotação do cliente",
};

const DEMO: Dossier = {
  version: 1,
  built_at: new Date().toISOString(),
  pending: false,
  failed: false,
  can_edit: true,
  items: [
    {
      id: "d1",
      kind: "avoids",
      text: "Não usar vermelho nas artes: lembra a principal concorrente (desde set/2026).",
      origin: "mavi",
      pinned: false,
      dismissed: false,
      sources: [
        { type: "meeting", title: "Alinhamento mensal", date: "2026-09-10" },
      ],
      seen_at: "2026-09-10",
      updated_at: "2026-09-10",
      updated_by: null,
    },
    {
      id: "d2",
      kind: "rule",
      text: "Toda peça passa pela gerente de marketing antes de publicar.",
      origin: "person",
      pinned: true,
      dismissed: false,
      sources: [],
      seen_at: "2026-09-01",
      updated_at: "2026-09-01",
      updated_by: null,
    },
  ],
};

const dateLabel = (iso: string | null) =>
  iso
    ? new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString(
        "pt-BR",
        { timeZone: "America/Sao_Paulo" },
      )
    : "";

export async function loadDossier(company: string, client: string) {
  if (!supabase) return DEMO;
  const { data, error } = await supabase.rpc("client_dossier", {
    p_company: company,
    p_client: client,
  });
  if (error) throw Error(error.message);
  return data as Dossier;
}
async function saveItem(
  company: string,
  client: string,
  id: string | null,
  kind: DossierKind,
  text: string,
) {
  if (!supabase) return;
  const { error } = await supabase.rpc("client_dossier_save", {
    p_company: company,
    p_client: client,
    p_id: id,
    p_kind: kind,
    p_text: text,
  });
  if (error) throw Error(error.message);
}
async function setItem(
  company: string,
  id: string,
  action: "pin" | "unpin" | "remove" | "restore",
) {
  if (!supabase) return;
  const { error } = await supabase.rpc("client_dossier_set", {
    p_company: company,
    p_id: id,
    p_action: action,
  });
  if (error) throw Error(error.message);
}

export function ClientDossier({
  company,
  client,
  clientName,
  data,
  notify,
  initial = null,
}: {
  company: string;
  client: string;
  clientName: string;
  data: Snapshot;
  notify: (text: string) => void;
  /** O dossiê já carregado (testes): mostra sem buscar. */
  initial?: Dossier | null;
}) {
  const [dossier, setDossier] = useState<Dossier | null>(initial);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [editing, setEditing] = useState<{
    id: string | null;
    kind: DossierKind;
    text: string;
  } | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  // O item que a pessoa está contestando (e o porquê).
  const [contesting, setContesting] = useState<{ id: string; reason: string } | null>(null);

  const load = useCallback(() => {
    setError("");
    loadDossier(company, client)
      .then(setDossier)
      .catch((e) => setError((e as Error).message));
  }, [company, client]);
  useEffect(() => {
    if (!initial) load();
  }, [load, initial]);

  async function run(key: string, fn: () => Promise<void>, done?: string) {
    setBusy(key);
    setError("");
    try {
      await fn();
      if (done) notify(done);
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
    const { id, kind, text } = editing;
    void run(
      "save",
      async () => {
        await saveItem(company, client, id, kind, text);
        setEditing(null);
      },
      id ? "Item corrigido e fixado." : "Item adicionado ao dossiê.",
    );
  }

  if (!dossier)
    return error ? (
      <p className="form-error" role="alert">
        {error}
      </p>
    ) : (
      <Loading variant="list" />
    );
  const active = dossier.items.filter((i) => !i.dismissed);
  const removed = dossier.items.filter((i) => i.dismissed);
  const who = (id: string | null) =>
    id ? data.members.find((m) => m.user_id === id)?.name : undefined;

  const editor = editing && (
    <form className="dossier-editor" onSubmit={submit}>
      <Select
        aria-label="Tipo"
        value={editing.kind}
        onValueChange={(v) =>
          setEditing({ ...editing, kind: v as DossierKind })
        }
      >
        {DOSSIER_KINDS.map((k) => (
          <SelectOption key={k.id} value={k.id}>
            {k.label}
          </SelectOption>
        ))}
      </Select>
      <Textarea
        aria-label="Texto do item"
        value={editing.text}
        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        maxLength={600}
        rows={2}
        placeholder="Ex.: Não usar vermelho nas artes (lembra a concorrente)."
        autoFocus
      />
      <div className="dossier-editor-actions">
        <Button
          type="button"
          className="btn secondary"
          onClick={() => setEditing(null)}
        >
          Cancelar
        </Button>
        <Button
          className="btn primary"
          loading={busy === "save"}
          disabled={editing.text.trim().length < 3}
        >
          Salvar
        </Button>
      </div>
      <small>
        Itens escritos ou corrigidos por líderes ficam fixados: a MAVI não os
        muda.
      </small>
    </form>
  );

  return (
    <section className="dossier" aria-label={`Dossiê da MAVI de ${clientName}`}>
      <header className="dossier-head">
        <div>
          <h2>
            <BookMarked size={18} aria-hidden="true" /> Dossiê da MAVI
          </h2>
          <p>
            O que quem cria tarefas para {clientName} precisa saber. A MAVI
            confere cada tarefa nova contra este dossiê e o histórico do
            cliente.
          </p>
          <small className="dossier-meta">
            {dossier.pending
              ? dossier.built_at
                ? "Há material novo: a MAVI atualiza em alguns minutos."
                : "A MAVI está lendo o histórico do cliente. Os itens aparecem em alguns minutos."
              : dossier.built_at
                ? `Atualizado pela MAVI em ${dateLabel(dossier.built_at)}.`
                : ""}
            {dossier.failed &&
              " A última leitura falhou; a MAVI tenta de novo com o próximo material."}
          </small>
        </div>
        <div className="dossier-head-actions">
          <Button
            className="icon-btn"
            onClick={load}
            aria-label="Atualizar"
            title="Atualizar"
          >
            <RefreshCw size={15} />
          </Button>
          {dossier.can_edit && (
            <Button
              className="btn primary"
              onClick={() => setEditing({ id: null, kind: "avoids", text: "" })}
              disabled={!!editing}
            >
              <Plus size={15} /> Novo item
            </Button>
          )}
        </div>
      </header>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {editing && !editing.id && editor}

      {!!dossier.proposals?.length && (
        <section className="dossier-review" aria-label="Para confirmar">
          <h3>
            Para confirmar <small>A MAVI notou e quer conferir com quem trabalha com o cliente. Sem resposta em 14 dias, sai.</small>
          </h3>
          <ul>
            {dossier.proposals.map((p) => (
              <li key={p.id}>
                <div>
                  <small className="dossier-review-op">
                    {PROPOSAL_OP[p.op] ?? p.op} · {DOSSIER_KINDS.find((k) => k.id === p.kind)?.label ?? p.kind}
                  </small>
                  <p className={p.op === "remove" ? "gone" : undefined}>{p.text}</p>
                  {p.previous && <p className="gone">antes: {p.previous}</p>}
                  <div className="dossier-item-meta">
                    {p.reasons.length > 0 && <span>Pede confirmação: {p.reasons.join(", ")}</span>}
                    {p.sources.slice(0, 3).map((s, n) => (
                      <span key={n} className="dossier-source" title={s.title}>
                        {SOURCE_LABELS[s.type] ?? s.type}
                        {s.date ? ` ${dateLabel(s.date)}` : ""}
                      </span>
                    ))}
                    {p.expires_at && <span>até {dateLabel(p.expires_at)}</span>}
                  </div>
                </div>
                {dossier.can_confirm && (
                  <span className="dossier-review-actions">
                    <Button
                      className="btn secondary"
                      loading={busy === `c${p.id}`}
                      onClick={() =>
                        run(`c${p.id}`, async () => void (await decideProposal(company, p.id, "confirm")), "Confirmado: entrou no dossiê.")
                      }
                    >
                      <Check size={14} /> {p.op === "review" ? "Ainda vale" : "Está certo"}
                    </Button>
                    <Button
                      className="btn secondary"
                      loading={busy === `r${p.id}`}
                      onClick={() =>
                        run(`r${p.id}`, async () => void (await decideProposal(company, p.id, "refuse")), "Recusado: a MAVI não propõe de novo.")
                      }
                    >
                      <X size={14} /> {p.op === "review" ? "Não vale mais" : "Não está"}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dossier.can_edit && !!dossier.contested?.length && (
        <section className="dossier-review contested" aria-label="Contestados">
          <h3>
            Contestados <small>Saíram do dossiê na hora; decida se voltam.</small>
          </h3>
          <ul>
            {dossier.contested.map((p) => (
              <li key={p.id}>
                <div>
                  <small className="dossier-review-op">
                    {DOSSIER_KINDS.find((k) => k.id === p.kind)?.label ?? p.kind} · contestado por {who(p.created_by) ?? "alguém"} em{" "}
                    {dateLabel(p.created_at)}
                  </small>
                  <p>{p.text}</p>
                  {p.contest_reason && <p className="dossier-review-why">“{p.contest_reason}”</p>}
                </div>
                <span className="dossier-review-actions">
                  <Button
                    className="btn secondary"
                    loading={busy === `v${p.id}`}
                    onClick={() => run(`v${p.id}`, () => resolveContest(company, p.id, "restore"), "Item de volta ao dossiê.")}
                  >
                    <RotateCcw size={14} /> Restaurar
                  </Button>
                  <Button
                    className="btn secondary"
                    loading={busy === `x${p.id}`}
                    onClick={() => run(`x${p.id}`, () => resolveContest(company, p.id, "discard"), "Descartado: a MAVI não traz de volta.")}
                  >
                    <Trash2 size={14} /> Descartar
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!active.length && !editing ? (
        <Empty
          title="Dossiê vazio"
          body={
            dossier.pending
              ? "A MAVI está lendo reuniões, WhatsApp, tarefas e arquivos do cliente."
              : "Ainda não há gostos, regras ou histórico registrados para este cliente."
          }
        />
      ) : (
        <div className="dossier-groups">
          {DOSSIER_KINDS.map((k) => {
            const list = active.filter((i) => i.kind === k.id);
            if (!list.length) return null;
            return (
              <section key={k.id} className={`dossier-group kind-${k.id}`}>
                <h3>
                  {k.label} <small>{k.hint}</small>
                </h3>
                <ul>
                  {list.map((i) =>
                    editing?.id === i.id ? (
                      <li key={i.id}>{editor}</li>
                    ) : contesting?.id === i.id ? (
                      <li key={i.id} className="dossier-item dossier-contest">
                        <p>{i.text}</p>
                        <input
                          autoFocus
                          maxLength={300}
                          placeholder="O que está errado? (opcional)"
                          aria-label="O que está errado"
                          value={contesting.reason}
                          onChange={(e) => setContesting({ ...contesting, reason: e.target.value })}
                        />
                        <span className="dossier-review-actions">
                          <Button type="button" className="btn secondary" onClick={() => setContesting(null)}>
                            Cancelar
                          </Button>
                          <Button
                            className="btn primary"
                            loading={busy === `k${i.id}`}
                            onClick={() =>
                              run(
                                `k${i.id}`,
                                async () => {
                                  await contestItem(company, i.id, contesting.reason.trim());
                                  setContesting(null);
                                },
                                "Contestado: o item saiu e foi para os líderes decidirem.",
                              )
                            }
                          >
                            Contestar
                          </Button>
                        </span>
                      </li>
                    ) : (
                      <li key={i.id} className="dossier-item">
                        <p>{i.text}</p>
                        <div className="dossier-item-meta">
                          {i.origin === "person" ? (
                            <span title="Escrito por uma pessoa">
                              <User size={12} aria-hidden="true" />
                              {who(i.updated_by) ?? "Pessoa"}
                            </span>
                          ) : (
                            <span title="Encontrado pela MAVI">
                              <Sparkles size={12} aria-hidden="true" />
                              MAVI
                            </span>
                          )}
                          {isNew(i) && <span className="dossier-new">Novo</span>}
                          {i.pinned && (
                            <span className="dossier-pinned">
                              <Pin size={12} aria-hidden="true" /> Fixado
                            </span>
                          )}
                          {i.seen_at && <span>{dateLabel(i.seen_at)}</span>}
                          {i.sources.slice(0, 3).map((s, n) => (
                            <span
                              key={n}
                              className="dossier-source"
                              title={s.title}
                            >
                              {SOURCE_LABELS[s.type] ?? s.type}
                              {s.date ? ` ${dateLabel(s.date)}` : ""}
                            </span>
                          ))}
                        </div>
                        {!dossier.can_edit && dossier.can_confirm && (
                          <div className="dossier-item-actions">
                            <button
                              type="button"
                              onClick={() => setContesting({ id: i.id, reason: "" })}
                              title="Está errado (sai do dossiê na hora e vai para os líderes)"
                              aria-label="Está errado"
                            >
                              <Flag size={14} />
                            </button>
                          </div>
                        )}
                        {dossier.can_edit && (
                          <div className="dossier-item-actions">
                            <button
                              type="button"
                              onClick={() =>
                                setEditing({
                                  id: i.id,
                                  kind: i.kind,
                                  text: i.text,
                                })
                              }
                              title="Corrigir"
                              aria-label="Corrigir"
                            >
                              <Pencil size={14} />
                            </button>
                            {i.origin === "mavi" && (
                              <button
                                type="button"
                                onClick={() =>
                                  run(i.id, () =>
                                    setItem(
                                      company,
                                      i.id,
                                      i.pinned ? "unpin" : "pin",
                                    ),
                                  )
                                }
                                disabled={busy === i.id}
                                title={
                                  i.pinned
                                    ? "Soltar (a MAVI pode atualizar)"
                                    : "Fixar (a MAVI não muda)"
                                }
                                aria-label={i.pinned ? "Soltar" : "Fixar"}
                              >
                                {i.pinned ? (
                                  <PinOff size={14} />
                                ) : (
                                  <Pin size={14} />
                                )}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() =>
                                run(
                                  i.id,
                                  () => setItem(company, i.id, "remove"),
                                  "Item removido do dossiê.",
                                )
                              }
                              disabled={busy === i.id}
                              title="Remover"
                              aria-label="Remover"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )}
                      </li>
                    ),
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {dossier.can_edit && removed.length > 0 && (
        <section className="dossier-removed">
          <button
            type="button"
            className="dossier-toggle"
            onClick={() => setShowRemoved((v) => !v)}
          >
            {showRemoved ? "Esconder" : "Ver"} removidos ({removed.length})
          </button>
          {showRemoved && (
            <ul>
              {removed.map((i) => (
                <li key={i.id}>
                  <span>{i.text}</span>
                  <button
                    type="button"
                    onClick={() =>
                      run(
                        i.id,
                        () => setItem(company, i.id, "restore"),
                        "Item restaurado.",
                      )
                    }
                    disabled={busy === i.id}
                    title="Restaurar"
                    aria-label="Restaurar"
                  >
                    <RotateCcw size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <small>A MAVI não traz de volta o que foi removido.</small>
        </section>
      )}
    </section>
  );
}
