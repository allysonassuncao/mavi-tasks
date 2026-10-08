import { useEffect, useRef, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  Info,
  ListTodo,
  MoreHorizontal,
  RotateCcw,
  Send,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import { Button, Input, Textarea } from "./ui";
import { navigate, taskUrl } from "./router";
import { appPath } from "./temperature";
import { sourceUrl, type AiSource } from "./ai";
import type { FormPreset } from "./forms";
import { serializeDescription, type RichNode } from "./rich-text";
import {
  CONFIDENCE_LABEL,
  LIKE_TAG_LABEL,
  REJECT_LABEL,
  createLink,
  fillLinks,
  likeReply,
  pendingKeys,
  replyFeedback,
  requestDraft,
  itemSources,
  messagePath,
  taskOutcome,
  whenBr,
  type LikeTag,
  type PersonalItem,
  type PersonalMention,
  type RejectReason,
  type TaskSuggestion,
} from "./personal-radar";

/**
 * Radar pessoal · o próximo passo de uma situação (migration
 * 20270513090000_personal_radar_next_step): a resposta que a MAVI escreveu e,
 * quando a situação pede, a tarefa que ela sugere — juntas, com ações de um
 * clique. Marcar como boa, reprovar, refazer e ensinar ficam em menus curtos
 * no próprio cartão; tudo vira aprendizado da MAVI. A tarefa sempre abre o
 * formulário de tarefa preenchido para a pessoa revisar.
 */

/** Um botão que abre uma lista curta de escolhas (um clique decide). */
export function ChoiceMenu<T extends string>({
  label,
  title,
  options,
  onPick,
  className = "btn quiet compact",
  disabled,
}: {
  label: ReactNode;
  title: string;
  options: { value: T; label: string }[];
  onPick: (value: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={className} disabled={disabled} aria-haspopup="menu">
          {label}
        </button>
      </Popover.Trigger>
      <Popover.Content className="status-menu pradar-menu" role="menu" sideOffset={6} align="start" collisionPadding={10}>
        <p>{title}</p>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="menuitem"
            className="status-option"
            onClick={() => {
              setOpen(false);
              onPick(o.value);
            }}
          >
            {o.label}
          </button>
        ))}
      </Popover.Content>
    </Popover.Root>
  );
}

/** Uma pergunta de uma linha no próprio cartão (Enter envia, Esc fecha). */
export function InlineAsk({
  placeholder,
  busy,
  onSend,
  onCancel,
  required = true,
}: {
  placeholder: string;
  busy?: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
  required?: boolean;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const send = () => (text.trim() || !required) && onSend(text.trim());
  return (
    <div className="pradar-ask">
      <Input
        ref={ref}
        value={text}
        maxLength={1000}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            send();
          } else if (e.key === "Escape") onCancel();
        }}
      />
      <Button className="btn primary compact" loading={busy} disabled={required && !text.trim()} onClick={send} aria-label="Enviar">
        <Send size={14} aria-hidden="true" />
      </Button>
      <Button className="btn quiet compact" onClick={onCancel} disabled={busy}>
        Cancelar
      </Button>
    </div>
  );
}

const SECTION = /^(Contexto|O que fazer|Pronto quando|Atenção)\s*:\s*(.*)$/i;
const ROLE_LABEL = { client: "cliente", team: "time" } as const;
const pad = (n: number) => String(n).padStart(2, "0");
const whenFull = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const minute = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600);
  return h ? `${h}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}` : `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
};
/** Como a fonte aparece na tarefa ("Gravação “Reunião de setembro” em 12:34"). */
export function sourceLabel(s: AiSource) {
  if (s.type === "meeting") return `Gravação “${s.title}”${s.start && s.start > 0 ? ` em ${minute(s.start)}` : ""}`;
  if (s.type === "whatsapp") return `Mensagem no WhatsApp${s.title ? ` (${s.title})` : ""}`;
  if (s.type === "file") return `Arquivo “${s.title}”${s.page ? `, página ${s.page}` : ""}`;
  if (s.type === "task") return `Tarefa “${s.title}”`;
  return s.title;
}

/**
 * O formulário de tarefa preenchido com a sugestão da MAVI. A descrição leva
 * o texto da MAVI em seções (Contexto, O que fazer, Pronto quando, Atenção) e,
 * no fim, as fontes: as falas da situação no grupo, com o link de cada
 * mensagem, e as evidências que a MAVI usou (a gravação no minuto, o arquivo,
 * a tarefa…), com o link (migration 20270618090000).
 */
export function taskPreset(
  item: PersonalItem,
  t: TaskSuggestion,
  onCreated: (task: string) => void,
  mentions: PersonalMention[] = item.mentions ?? [],
): FormPreset {
  const text = (value: string, marks?: RichNode["marks"]): RichNode => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
  const bold = [{ type: "bold" }] as RichNode["marks"];
  const link = (href: string) => [{ type: "link", attrs: { href } }] as RichNode["marks"];
  const paragraph = (...content: RichNode[]): RichNode => ({ type: "paragraph", content });
  const list = (items: RichNode[][]): RichNode => ({
    type: "bulletList",
    content: items.map((c) => ({ type: "listItem", content: [paragraph(...c)] })),
  });
  const content: RichNode[] = [];
  // O texto da MAVI: os rótulos em negrito, os passos "- " em lista.
  let bullets: RichNode[][] = [];
  const flush = () => {
    if (bullets.length) content.push(list(bullets));
    bullets = [];
  };
  for (const raw of (t.description ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const step = line.match(/^[-•*]\s+(.*)$/);
    if (step) {
      bullets.push([text(step[1])]);
      continue;
    }
    flush();
    const section = line.match(SECTION);
    content.push(section ? paragraph(text(`${section[1]}:`, bold), ...(section[2] ? [text(` ${section[2]}`)] : [])) : paragraph(text(line)));
  }
  flush();
  // As fontes, montadas aqui (os links só do que existe).
  const evidence = (item.reply?.evidence ?? []).filter((e) => e.title || e.detail);
  if (mentions.length || evidence.length || item.radar) {
    content.push(paragraph(text("Fontes", bold)));
    if (mentions.length) {
      content.push(paragraph(text(`Mensagens no grupo “${item.group.title}”:`)));
      content.push(
        list(
          mentions.map((m) => [
            text(whenFull(m.at), link(appPath(messagePath(item.group.id, m.message_id)))),
            text(" · "),
            text(`${m.speaker || "Sem nome"} (${ROLE_LABEL[m.role] ?? m.role}): `, bold),
            text(`“${m.quote}”`),
          ]),
        ),
      );
    }
    if (evidence.length) {
      content.push(paragraph(text("O que a MAVI consultou:")));
      content.push(
        list(
          evidence.map((e) => {
            const href = e.source && e.source.type !== "attachment" ? sourceUrl(e.source) : null;
            return [
              ...(e.title ? [text(e.title, bold)] : []),
              ...(e.detail ? [text(`${e.title ? " — " : ""}${e.detail}`)] : []),
              ...(e.source ? [text(" · "), href ? text(sourceLabel(e.source), link(href)) : text(sourceLabel(e.source))] : []),
            ];
          }),
        ),
      );
    }
    if (item.radar)
      content.push(
        paragraph(text("Radar do cliente: "), text(item.radar.title, link(appPath(`/radar?item=${item.radar.id}`)))),
      );
  }
  const description = serializeDescription({ type: "doc", content });
  return {
    contract: t.contract_id,
    title: t.title,
    description: description || undefined,
    due: t.due,
    assignee: t.assignee_id,
    team: t.assignee_id ? undefined : t.team_id,
    priority: t.priority,
    onCreated,
  };
}

const REDO: { value: string; label: string }[] = [
  { value: "Mais curta e direta.", label: "Mais curta" },
  { value: "Com mais detalhes e os números/datas que embasam.", label: "Mais detalhada" },
  { value: "Mais formal.", label: "Mais formal" },
  { value: "Mais próxima e informal, no tom de WhatsApp.", label: "Mais informal" },
  { value: "__other__", label: "Outro pedido…" },
];

export function NextStep({
  company,
  item,
  readOnly,
  ready = false,
  onChanged,
  onNewTask,
  onDone,
}: {
  company: string;
  item: PersonalItem;
  readOnly: boolean;
  ready?: boolean;
  onChanged: (item: PersonalItem, message?: string) => void;
  onNewTask?: (preset: FormPreset) => void;
  /** A pessoa terminou esta situação (o modo foco passa para a próxima). */
  onDone?: () => void;
}) {
  const reply = item.reply;
  const base = reply?.approved_text ?? reply?.text ?? "";
  const [text, setText] = useState(base);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | "redo" | "teach" | "reject">(null);
  const [reason, setReason] = useState<RejectReason>("wrong_info");
  const [showEvidence, setShowEvidence] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = reply?.version ?? 0;
  // Uma versão nova da MAVI troca o texto (a edição da anterior fica no aprendizado).
  useEffect(() => {
    setText(base);
    setLinks({});
  }, [version, item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const work = (fn: () => Promise<PersonalItem | { item?: PersonalItem }>, message: string, done = false) => {
    setBusy(true);
    setError("");
    fn()
      .then((r) => {
        setAsk(null);
        const next = "id" in r ? (r as PersonalItem) : (r as { item?: PersonalItem }).item;
        if (next) onChanged(next, message);
        if (done) onDone?.();
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(false));
  };
  const write = (opts: { force?: boolean; guidance?: string } = {}) =>
    work(() => requestDraft(company, item.id, opts), "A MAVI escreveu uma nova resposta.");

  if (!reply || reply.status === "pending")
    return (
      <div className="pradar-reply waiting">
        <Sparkles size={14} aria-hidden="true" />
        <span>A MAVI ainda não escreveu a resposta.</span>
        {!readOnly && (
          <Button className="btn secondary compact" onClick={() => write()} loading={busy}>
            Escrever agora
          </Button>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    );
  if (reply.status === "running")
    return (
      <div className="pradar-reply waiting" role="status">
        <Sparkles size={14} aria-hidden="true" className="pradar-pulse" />
        <span>A MAVI está preparando o próximo passo: lendo o cliente, as reuniões e as campanhas…</span>
      </div>
    );
  if (reply.status === "failed" && !reply.text)
    return (
      <div className="pradar-reply waiting">
        <span>A MAVI não conseguiu escrever a resposta{reply.error ? `: ${reply.error}` : "."}</span>
        {!readOnly && (
          <Button className="btn secondary compact" onClick={() => write({ force: true })} loading={busy}>
            Tentar de novo
          </Button>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    );

  const filled = fillLinks(text, links);
  const missing = pendingKeys(filled);
  const original = fillLinks(reply.text ?? "", links);
  const task = reply.task;
  const taskOpen = !!task && !task.outcome;
  const copy = (thenTask = false) => {
    // Os marcadores sem link criado saem do texto copiado.
    const final = missing.reduce((t, k) => t.replaceAll(`{{${k}}}`, ""), filled).replace(/[ \t]{2,}/g, " ").trim();
    void navigator.clipboard?.writeText(final).catch(() => {});
    const edited = final !== original.trim() && final !== (reply.approved_text ?? "").trim();
    work(
      () => replyFeedback(company, item.id, edited ? "edited" : "approved", edited ? final : ""),
      edited ? "Copiado com as suas edições. A MAVI vai aprender com elas." : "Copiado. Cole no grupo do cliente.",
      !thenTask && !taskOpen,
    );
    if (thenTask) createTask();
  };
  const createTask = async () => {
    if (!task || !onNewTask) return;
    // Todas as falas da situação (não só as 4 que a lista mostra) vão para as fontes.
    const mentions = await itemSources(company, item);
    onNewTask(
      taskPreset(
        item,
        task,
        (id) =>
          work(() => taskOutcome(company, item.id, "created", id), "Tarefa criada e ligada à situação. A MAVI aprende com o que você mudou.", true),
        mentions.length ? mentions : item.mentions,
      ),
    );
  };
  const makeLink = async (key: string) => {
    const a = reply.actions.find((x) => x.key === key);
    if (!a) return;
    setLinking(key);
    setError("");
    try {
      const url = await createLink(company, a);
      setLinks((l) => ({ ...l, [key]: url }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLinking(null);
    }
  };
  const liked = !!reply.liked_at;
  const tags = reply.liked_tags ?? [];
  const toggleTag = (t: LikeTag) =>
    work(
      () => likeReply(company, item.id, true, tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]),
      "Anotado. A MAVI repete o que funcionou.",
    );
  const rejected = reply.status === "rejected";
  const who = task?.assignee_name ?? (task?.team_name ? `equipe ${task.team_name}` : null);

  return (
    <div className={`pradar-reply pradar-next${rejected ? " rejected" : ""}`}>
      <div className="pradar-reply-head">
        <span className="pradar-reply-title">
          <Sparkles size={14} aria-hidden="true" /> Próximo passo sugerido pela MAVI
        </span>
        {reply.confidence && (
          <span className={`pradar-confidence c-${reply.confidence}`}>{CONFIDENCE_LABEL[reply.confidence]}</span>
        )}
        {version > 1 && <span className="muted">versão {version}</span>}
        {reply.approved_at && (
          <span className="pradar-approved">
            <CheckCircle2 size={13} aria-hidden="true" /> Copiada {whenBr(reply.approved_at)}
          </span>
        )}
        {liked && (
          <span className="pradar-approved">
            <ThumbsUp size={13} aria-hidden="true" /> Boa resposta
          </span>
        )}
        {rejected && <span className="pradar-rejected">Reprovada</span>}
        {ready && !readOnly && (
          <span className="pradar-ready" title="Pela sua regra de autonomia, a MAVI já acerta este tipo de resposta. Por enquanto ela não envia nada sozinha.">
            Pronta para responder sozinha
          </span>
        )}
      </div>
      {reply.stale && !readOnly && (
        <p className="pradar-warn">
          <Info size={14} aria-hidden="true" /> O cliente falou de novo depois desta resposta.{" "}
          <button type="button" className="pradar-link" onClick={() => write({ force: true })} disabled={busy}>
            Atualizar a resposta
          </button>
        </p>
      )}
      <span className="pradar-step-label">Resposta para o grupo</span>
      {readOnly ? (
        <p className="pradar-reply-text">{filled}</p>
      ) : (
        <Textarea
          className="pradar-reply-input"
          aria-label="Resposta para o grupo"
          value={filled}
          rows={Math.min(10, Math.max(3, Math.ceil(filled.length / 90)))}
          maxLength={6000}
          onChange={(e) => {
            // O link criado volta a ser marcador na edição (a próxima troca põe de novo).
            let next = e.target.value;
            for (const [k, url] of Object.entries(links)) next = next.replaceAll(url, `{{${k}}}`);
            setText(next);
          }}
        />
      )}
      {reply.actions.length > 0 && (
        <ul className="pradar-reply-actions">
          {reply.actions.map((a) => (
            <li key={a.key}>
              <span className="pradar-key">{`{{${a.key}}}`}</span>
              <span className="pradar-action-label">{a.label}</span>
              {links[a.key] ? (
                <a href={links[a.key]} target="_blank" rel="noreferrer" className="pradar-link-ok">
                  <CheckCircle2 size={13} aria-hidden="true" /> Link criado
                </a>
              ) : readOnly ? (
                <span className="muted">link sugerido</span>
              ) : (
                <Button className="btn secondary compact" onClick={() => makeLink(a.key)} loading={linking === a.key} disabled={!!linking}>
                  Criar link
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {reply.checks.length > 0 && (
        <ul className="pradar-checks">
          {reply.checks.map((c, n) => (
            <li key={n}>
              <Info size={13} aria-hidden="true" /> {c}
            </li>
          ))}
        </ul>
      )}
      {reply.evidence.length > 0 && (
        <>
          <button type="button" className="pradar-link" onClick={() => setShowEvidence((v) => !v)}>
            {showEvidence ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            Evidências ({reply.evidence.length})
          </button>
          {showEvidence && (
            <ul className="pradar-evidence">
              {reply.evidence.map((e, n) => (
                <li key={n}>
                  <strong>{e.title}</strong>
                  {e.detail && <span>{e.detail}</span>}
                  {e.source && (
                    <a
                      href={sourceUrl(e.source)}
                      onClick={(ev) => {
                        ev.preventDefault();
                        navigate(sourceUrl(e.source!));
                      }}
                    >
                      <ExternalLink size={12} aria-hidden="true" /> {e.source.title}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {task && (
        <div className={`pradar-task${task.outcome ? ` ${task.outcome}` : ""}`}>
          <span className="pradar-step-label">
            <ListTodo size={13} aria-hidden="true" /> Tarefa sugerida
          </span>
          <strong>{task.title}</strong>
          <span className="muted">
            {[who ? `para ${who}` : "", task.product_name, task.due ? `prazo ${task.due.split("-").reverse().join("/")}` : ""]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {task.why && <span className="pradar-task-why">{task.why}</span>}
          {task.outcome === "created" ? (
            item.task ? (
              <a
                className="pradar-link-ok"
                href={appPath(taskUrl(item.task, ""))}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(appPath(taskUrl(item.task!, "")));
                }}
              >
                <CheckCircle2 size={13} aria-hidden="true" /> Tarefa criada: {item.task.title}
              </a>
            ) : (
              <span className="pradar-link-ok">
                <CheckCircle2 size={13} aria-hidden="true" /> Tarefa criada
              </span>
            )
          ) : task.outcome === "dismissed" ? (
            <span className="muted">Você disse que não precisava.</span>
          ) : (
            !readOnly && (
              <div className="pradar-actions">
                <Button className="btn secondary compact" onClick={createTask} disabled={busy || !onNewTask}>
                  <ListTodo size={14} aria-hidden="true" /> Revisar e criar
                </Button>
                <Button
                  className="btn quiet compact"
                  loading={busy && !ask}
                  onClick={() => work(() => taskOutcome(company, item.id, "dismissed"), "Anotado: esta não precisava de tarefa.", !!reply.approved_at)}
                >
                  Não precisa
                </Button>
              </div>
            )
          )}
        </div>
      )}

      {!readOnly && (
        <div className="pradar-actions pradar-next-actions">
          <Button className="btn primary compact" onClick={() => copy()} loading={busy && !ask}>
            <Copy size={14} aria-hidden="true" /> {missing.length ? "Copiar sem os links" : "Copiar"}
          </Button>
          {taskOpen && onNewTask && (
            <Button className="btn secondary compact" onClick={() => copy(true)} disabled={busy}>
              <Copy size={14} aria-hidden="true" /> Copiar e criar tarefa
            </Button>
          )}
          <Button
            className={`btn compact ${liked ? "secondary pradar-liked" : "quiet"}`}
            aria-pressed={liked}
            onClick={() =>
              work(
                () => likeReply(company, item.id, !liked, liked ? [] : tags),
                liked ? "Tirado o \"boa resposta\"." : "Boa resposta! A MAVI vai usar como exemplo.",
              )
            }
            disabled={busy}
          >
            <ThumbsUp size={14} aria-hidden="true" /> Boa
          </Button>
          <ChoiceMenu
            label={
              <>
                <RotateCcw size={14} aria-hidden="true" /> Refazer
              </>
            }
            title="Como refazer?"
            options={REDO}
            disabled={busy}
            onPick={(v) => (v === "__other__" ? setAsk("redo") : write({ force: true, guidance: v }))}
          />
          <ChoiceMenu
            label={
              <>
                <ThumbsDown size={14} aria-hidden="true" /> Reprovar
              </>
            }
            title="O que está errado?"
            options={(Object.keys(REJECT_LABEL) as RejectReason[]).map((r) => ({ value: r, label: REJECT_LABEL[r] }))}
            disabled={busy}
            onPick={(r) => {
              setReason(r);
              if (r === "other") setAsk("reject");
              else
                work(
                  () => replyFeedback(company, item.id, "rejected", "", r),
                  "Resposta reprovada. A MAVI vai levar isso em conta.",
                );
            }}
          />
          <ChoiceMenu
            label={<MoreHorizontal size={15} aria-label="Mais" />}
            title="Mais"
            className="btn quiet compact"
            options={[{ value: "teach", label: "Ensinar uma regra à MAVI" }]}
            disabled={busy}
            onPick={() => setAsk("teach")}
          />
        </div>
      )}
      {liked && !readOnly && (
        <div className="pradar-tags" role="group" aria-label="O que estava bom">
          <span className="muted">O que estava bom?</span>
          {(Object.keys(LIKE_TAG_LABEL) as LikeTag[]).map((t) => (
            <button
              key={t}
              type="button"
              className={`pradar-tag${tags.includes(t) ? " on" : ""}`}
              aria-pressed={tags.includes(t)}
              disabled={busy}
              onClick={() => toggleTag(t)}
            >
              {LIKE_TAG_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      {ask && (
        <InlineAsk
          busy={busy}
          required
          placeholder={
            ask === "redo"
              ? "O que mudar nesta resposta? (ex.: cite o relatório de setembro)"
              : ask === "reject"
                ? "O que está errado?"
                : "O que a MAVI deve fazer sempre? (ex.: chame o cliente pelo primeiro nome)"
          }
          onCancel={() => setAsk(null)}
          onSend={(note) =>
            ask === "redo"
              ? write({ force: true, guidance: note })
              : ask === "reject"
                ? work(() => replyFeedback(company, item.id, "rejected", note, reason), "Resposta reprovada. A MAVI vai levar isso em conta.")
                : work(() => replyFeedback(company, item.id, "training", note), "Anotado. A MAVI segue isso daqui para a frente.")
          }
        />
      )}
      {error && <p className="form-error">{error}</p>}
      {reply.model && <p className="pradar-model muted">Escrita por {reply.model}</p>}
    </div>
  );
}
