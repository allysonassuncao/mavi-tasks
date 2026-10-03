import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Copy,
  ExternalLink,
  Link2,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Unplug,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Input, Textarea } from "./ui";
import { MediaInput } from "./SocialLeadsFields";
import {
  DESTINATIONS,
  destinationLabels,
  formatUsd,
  instagramKind,
  localInput,
  localWhen,
  postTextPlain,
  scheduleStatus,
  scheduleWhen,
  SM_TIME_ZONE,
  type MediaFile,
  type SlPost,
  type SmAccount,
  type SmDestination,
  type SmPage,
  type SmSchedule,
  type SmScheduleDraft,
} from "./social-leads";
import {
  connectUrl,
  type ScheduleSuggestion,
  type SocialLeadsBackend,
} from "./social-leads-api";
import { useUrlState } from "./router";
import "./social-media-schedule.css";

/**
 * Planejamento › Social Media › Agendamento (migration
 * 20270315090000_social_media_schedule): the approved posts with art get a
 * date, a time and where they go. The MAVI suggests the dates; at the time,
 * the team is told to publish (the arts and the caption are here, ready to
 * copy) and marks the post as published. The client link shows the calendar
 * when the team leaves it on.
 *
 * With the client's Page connected (migration 20270316090000_social_media_meta,
 * the Social Media's own Meta app), the post goes out by itself at the time;
 * what fails comes back as "hora de publicar", with the reason.
 */
export function ScheduleView({
  company,
  contract,
  planId,
  posts,
  schedules,
  linkCalendar,
  account,
  canWrite,
  isLeader,
  backend,
  tz,
  focus,
  clearFocus,
  who,
  notify,
  onChanged,
}: {
  company: string;
  contract: string;
  planId: string;
  posts: SlPost[];
  schedules: SmSchedule[];
  linkCalendar: boolean;
  /** The client's Meta connection (null: none yet). */
  account: SmAccount | null;
  canWrite: boolean;
  /** Administrators and managers connect through the agency. */
  isLeader: boolean;
  backend: SocialLeadsBackend;
  /** The company's time zone (dates are typed and shown in it). */
  tz: string;
  /** A post to open (the notice's link). */
  focus: number;
  clearFocus: () => void;
  who: (id: string | null) => string | undefined;
  notify: (m: string) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [busy, setBusy] = useState(false);
  const scheduleOf = (n: number) => schedules.find((s) => s.number === n);
  const approved = posts.filter((p) => p.decision === "approved");
  const ready = approved.filter((p) => p.arts?.length);
  const toSchedule = ready.filter((p) => !scheduleOf(p.number));
  const waitingArt = approved.filter((p) => !p.arts?.length);
  const published = schedules.filter((s) => s.status === "published").length;
  // Redraw when the next post's time comes (no request: the database's
  // notice arrives too, a minute later at most).
  const [now, setNow] = useState(() => Date.now());
  const next = schedules
    .filter((s) => s.status === "scheduled")
    .map((s) => new Date(s.scheduled_at).getTime())
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (!next) return;
    const wait = Math.min(next - Date.now() + 500, 86_400_000);
    const t = window.setTimeout(() => setNow(Date.now()), Math.max(wait, 0));
    return () => window.clearTimeout(t);
  }, [next]);
  const due = schedules.filter(
    (s) => scheduleStatus(s, now).tone === "warn" || s.status === "failed",
  );

  useEffect(() => {
    if (!focus) return;
    if (posts.some((p) => p.number === focus)) setOpen(focus);
    clearFocus();
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = open !== null ? posts.find((p) => p.number === open) : null;

  return (
    <div className="sm-schedule">
      <div className="sm-schedule-bar">
        <p>
          <strong>
            {schedules.length} de {approved.length}
          </strong>{" "}
          {approved.length === 1
            ? "post aprovado agendado"
            : "posts aprovados agendados"}
          {published > 0 &&
            ` · ${published} ${published === 1 ? "publicado" : "publicados"}`}
          {waitingArt.length > 0 &&
            ` · ${waitingArt.length} ${waitingArt.length === 1 ? "esperando a arte" : "esperando as artes"}`}
        </p>
        <div className="sm-schedule-actions">
          {canWrite && (
            <label className="sm-check">
              <Checkbox
                checked={linkCalendar}
                disabled={busy}
                onCheckedChange={(v) => {
                  setBusy(true);
                  backend
                    .setLinkCalendar(contract, v === true)
                    .then(() => {
                      notify(
                        v === true
                          ? "O link do cliente mostra o calendário."
                          : "O calendário saiu do link do cliente.",
                      );
                      onChanged();
                    })
                    .catch((e) => notify((e as Error).message))
                    .finally(() => setBusy(false));
                }}
              />
              Calendário no link do cliente
            </label>
          )}
          {canWrite && (
            <Button
              className={`btn ${toSchedule.length ? "primary" : "secondary"}`}
              disabled={!toSchedule.length}
              title={
                toSchedule.length
                  ? "A MAVI distribui os posts sem data no mês"
                  : "Todos os posts com arte já têm data"
              }
              onClick={() => setSuggesting(true)}
            >
              <Sparkles size={15} /> Sugerir datas com a MAVI
            </Button>
          )}
        </div>
      </div>

      <MetaConnection
        contract={contract}
        account={account}
        canWrite={canWrite}
        isLeader={isLeader}
        backend={backend}
        who={who}
        notify={notify}
        onChanged={onChanged}
      />

      {due.length > 0 && (
        <section className="sm-due" aria-label="Hora de publicar">
          {due.map((s) => {
            const p = posts.find((x) => x.number === s.number);
            return (
              <button
                key={s.number}
                type="button"
                className={`sm-due-item ${s.status === "failed" ? "bad" : ""}`}
                onClick={() => setOpen(s.number)}
              >
                {s.status === "failed" ? (
                  <CircleAlert size={16} />
                ) : (
                  <TriangleAlert size={16} />
                )}
                <span>
                  <strong>
                    Post {s.number} ·{" "}
                    {s.status === "failed"
                      ? "não pode ser publicado"
                      : "hora de publicar"}
                  </strong>
                  <small>
                    {s.status === "failed"
                      ? s.error
                      : s.error
                        ? `O Meta não publicou: ${s.error}`
                        : `${scheduleWhen(s.scheduled_at, tz)} · ${p?.hook ?? ""}`}
                  </small>
                </span>
                <span className="sm-due-go">
                  {s.status === "failed" ? "Ajustar" : "Publicar"}
                </span>
              </button>
            );
          })}
        </section>
      )}

      <Calendar
        posts={posts}
        schedules={schedules}
        tz={tz}
        onOpen={(n) => setOpen(n)}
      />

      {(toSchedule.length > 0 || waitingArt.length > 0) && (
        <section className="sm-pending">
          {toSchedule.length > 0 && (
            <>
              <h4>Para agendar</h4>
              <ul>
                {toSchedule.map((p) => (
                  <li key={p.number}>
                    <span className="sl-num">
                      {String(p.number).padStart(2, "0")}
                    </span>
                    <span className="sm-pending-text">
                      <strong>{p.hook}</strong>
                      <small>
                        {p.format} · no Instagram como {instagramKind(p.arts)}
                        {p.is_ad ? " · vira anúncio" : ""}
                      </small>
                    </span>
                    {canWrite && (
                      <Button
                        className="btn secondary"
                        onClick={() => setOpen(p.number)}
                      >
                        <CalendarDays size={14} /> Agendar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {waitingArt.length > 0 && (
            <p className="sl-muted">
              Esperando a arte:{" "}
              {waitingArt.map((p) => `post ${p.number}`).join(", ")}. Eles
              entram aqui quando a arte for enviada.
            </p>
          )}
        </section>
      )}

      {post && (
        <ScheduleModal
          post={post}
          schedule={scheduleOf(post.number) ?? null}
          canWrite={canWrite}
          backend={backend}
          planId={planId}
          tz={tz}
          who={who}
          notify={notify}
          onClose={() => setOpen(null)}
          onChanged={onChanged}
        />
      )}
      {suggesting && (
        <SuggestModal
          company={company}
          contract={contract}
          planId={planId}
          posts={posts}
          backend={backend}
          notify={notify}
          onClose={() => setSuggesting(false)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------ calendar
const WEEK = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const monthKey = (local: string) => local.slice(0, 7);
function Calendar({
  posts,
  schedules,
  tz,
  onOpen,
}: {
  posts: SlPost[];
  schedules: SmSchedule[];
  tz: string;
  onOpen: (n: number) => void;
}) {
  const today = localInput(new Date().toISOString(), tz).slice(0, 10);
  // The month of the next post to go out (or of the last one, or today's).
  const initial = useMemo(() => {
    const next = schedules
      .filter((s) => s.status !== "published")
      .map((s) => localInput(s.scheduled_at, tz))
      .sort()[0];
    return monthKey(
      next ??
        schedules
          .map((s) => localInput(s.scheduled_at, tz))
          .sort()
          .at(-1) ??
        today,
    );
  }, [schedules.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [month, setMonth] = useState(initial);
  useEffect(() => setMonth(initial), [initial]);
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: first.getUTCDay() }, () => null),
    ...Array.from(
      { length: days },
      (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`,
    ),
  ];
  while (cells.length % 7) cells.push(null);
  const byDay = new Map<string, SmSchedule[]>();
  for (const s of schedules) {
    const d = localInput(s.scheduled_at, tz).slice(0, 10);
    byDay.set(d, [...(byDay.get(d) ?? []), s]);
  }
  const shift = (n: number) => {
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    setMonth(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  };
  const long = first.toLocaleDateString("pt-BR", {
    month: "long",
    timeZone: "UTC",
  });
  const title = `${long.charAt(0).toUpperCase()}${long.slice(1)} de ${y}`;
  return (
    <section className="sm-calendar" aria-label="Calendário de publicações">
      <header>
        <button
          type="button"
          aria-label="Mês anterior"
          onClick={() => shift(-1)}
        >
          <ChevronLeft size={16} />
        </button>
        <h4>{title}</h4>
        <button type="button" aria-label="Próximo mês" onClick={() => shift(1)}>
          <ChevronRight size={16} />
        </button>
      </header>
      <div className="sm-grid" role="grid">
        {WEEK.map((d) => (
          <span key={d} className="sm-weekday" role="columnheader">
            {d}
          </span>
        ))}
        {cells.map((d, i) =>
          d ? (
            <div
              key={d}
              role="gridcell"
              className={`sm-day ${d === today ? "today" : ""} ${d < today ? "past" : ""}`}
            >
              <span className="sm-day-n">{Number(d.slice(8))}</span>
              {(byDay.get(d) ?? [])
                .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at))
                .map((s) => {
                  const st = scheduleStatus(s);
                  const p = posts.find((x) => x.number === s.number);
                  return (
                    <button
                      key={s.number}
                      type="button"
                      className={`sm-chip ${st.tone}`}
                      title={`Post ${s.number} · ${st.label} · ${p?.hook ?? ""}`}
                      onClick={() => onOpen(s.number)}
                    >
                      <b>{localInput(s.scheduled_at, tz).slice(11)}</b> Post{" "}
                      {s.number}
                      {s.status === "published" && <Check size={11} />}
                    </button>
                  );
                })}
            </div>
          ) : (
            <span key={`x${i}`} className="sm-day empty" aria-hidden="true" />
          ),
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ one post
const tomorrow = (tz: string) =>
  localInput(new Date(Date.now() + 86_400_000).toISOString(), tz).slice(0, 10);
const hashtags = (text: string) =>
  (text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;

function ScheduleModal({
  post,
  schedule,
  canWrite,
  backend,
  planId,
  tz,
  who,
  notify,
  onClose,
  onChanged,
}: {
  post: SlPost;
  schedule: SmSchedule | null;
  canWrite: boolean;
  backend: SocialLeadsBackend;
  planId: string;
  tz: string;
  who: (id: string | null) => string | undefined;
  notify: (m: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const planCaption = postTextPlain(post.caption);
  const arts = post.arts ?? [];
  const video = arts.some((a) => a.type.startsWith("video/"));
  const images = arts.filter((a) => a.type.startsWith("image/"));
  const at = schedule ? localInput(schedule.scheduled_at, tz) : "";
  const [day, setDay] = useState(at.slice(0, 10) || tomorrow(tz));
  const [time, setTime] = useState(at.slice(11) || (video ? "19:00" : "12:00"));
  const [dest, setDest] = useState<SmDestination[]>(
    schedule?.destinations ??
      (post.is_ad
        ? ["instagram", "facebook", "story"]
        : ["instagram", "facebook"]),
  );
  const [caption, setCaption] = useState<string | null>(
    schedule?.caption ?? null,
  );
  const [comment, setComment] = useState(schedule?.first_comment ?? "");
  const [cover, setCover] = useState<SmSchedule["cover"]>(
    schedule?.cover ?? null,
  );
  const [url, setUrl] = useState(schedule?.published_url ?? "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const published = schedule?.status === "published";
  const st = schedule ? scheduleStatus(schedule) : null;
  // The time came (the database flips it within a minute): time to publish.
  const publishing = schedule?.status === "publishing";
  const due =
    !!schedule &&
    (schedule.status === "due" ||
      schedule.status === "failed" ||
      (schedule.status === "scheduled" && st?.tone === "warn"));
  const shownCaption = caption ?? planCaption;
  const locked = !canWrite || published || publishing;

  const run = (key: string, work: () => Promise<void>, done: string) => {
    setBusy(key);
    setError("");
    work()
      .then(() => {
        notify(done);
        onChanged();
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(""));
  };
  const save = () => {
    const draft: SmScheduleDraft = {
      number: post.number,
      at: `${day}T${time}`,
      destinations: dest,
      caption: caption !== null && caption !== planCaption ? caption : null,
      first_comment: comment,
      cover: video && dest.includes("instagram") ? cover : null,
    };
    run(
      "save",
      async () => {
        await backend.saveSchedule(planId, [draft]);
        onClose();
      },
      `Post ${post.number} agendado para ${localWhen(draft.at)}.`,
    );
  };
  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => notify(`${what} copiad${what === "Legenda" ? "a" : "o"}.`))
      .catch(() => notify("Não foi possível copiar."));

  return (
    <Modal
      title={`Post ${post.number} · ${schedule ? "agendamento" : "agendar"}`}
      onClose={onClose}
      busy={!!busy}
    >
      <div className="entity-form sm-modal">
        <p className="sm-modal-hook">
          <strong>{post.hook}</strong>
          <small>
            {post.format}
            {post.is_ad ? " · vira anúncio (também segue para a Campanha)" : ""}
          </small>
        </p>
        {st && (
          <p className={`sm-status ${st.tone}`}>
            {st.label}
            {schedule?.status === "published" && schedule.published_at
              ? ` em ${scheduleWhen(schedule.published_at, tz)}${schedule.published_by ? ` · ${who(schedule.published_by) ?? ""}` : ""}`
              : schedule
                ? ` · ${scheduleWhen(schedule.scheduled_at, tz)}`
                : ""}
          </p>
        )}
        {publishing && (
          <p className="sl-alert info-soft">
            <PlugZap size={15} /> O Meta está publicando este post agora. Vídeos
            podem levar alguns minutos para processar.
          </p>
        )}
        {schedule?.status === "due" && schedule.error && (
          <p className="sl-alert warn">
            <TriangleAlert size={15} /> O Meta não publicou: {schedule.error}
          </p>
        )}
        {schedule?.status === "failed" && schedule.error && (
          <p className="sl-alert bad">
            <CircleAlert size={15} /> {schedule.error} Ajuste e escolha uma nova
            hora.
          </p>
        )}

        <MediaInput
          files={arts as MediaFile[]}
          uploading={[]}
          accept=""
          what="as artes"
          disabled
          onAdd={() => {}}
          onRemove={() => {}}
          urlOf={(f) => backend.mediaUrl(f)}
        />

        <div className="form-columns">
          <label>
            Data
            <Input
              type="date"
              value={day}
              disabled={locked}
              required
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
          <label>
            Hora
            <Input
              type="time"
              value={time}
              disabled={locked}
              required
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
        <small className="sl-muted">
          Fuso da empresa: {tz === SM_TIME_ZONE ? "horário de Brasília" : tz}.
        </small>

        <fieldset className="sm-dest" disabled={locked}>
          <legend>Onde publicar</legend>
          {DESTINATIONS.map((d) => (
            <label key={d} className="sm-check">
              <Checkbox
                checked={dest.includes(d)}
                disabled={locked}
                onCheckedChange={(v) =>
                  setDest((list) =>
                    v === true ? [...list, d] : list.filter((x) => x !== d),
                  )
                }
              />
              {d === "instagram"
                ? `Instagram (${instagramKind(arts)})`
                : d === "facebook"
                  ? "Página do Facebook"
                  : destinationLabels[d]}
            </label>
          ))}
          {dest.includes("story") && arts.length > 1 && (
            <small className="sl-muted">
              Nos Stories, cada arte vira um story, na ordem.
            </small>
          )}
        </fieldset>

        <label>
          <span className="sm-label-row">
            Legenda
            <small>
              {caption === null || caption === planCaption
                ? "a do plano"
                : "só neste agendamento"}{" "}
              · {shownCaption.length}/2.200
              {hashtags(shownCaption) > 30 && " · mais de 30 hashtags"}
            </small>
          </span>
          <Textarea
            rows={6}
            value={shownCaption}
            maxLength={2200}
            disabled={locked}
            onChange={(e) => setCaption(e.target.value)}
          />
        </label>
        <div className="sm-row-actions">
          {caption !== null && caption !== planCaption && !locked && (
            <button
              type="button"
              className="sl-link"
              onClick={() => setCaption(null)}
            >
              <RotateCcw size={12} /> Voltar à legenda do plano
            </button>
          )}
          <button
            type="button"
            className="sl-link"
            onClick={() => copy(shownCaption, "Legenda")}
          >
            <Copy size={12} /> Copiar legenda
          </button>
        </div>

        <label>
          <span className="sm-label-row">
            Primeiro comentário
            <small>opcional · hashtags ou um complemento</small>
          </span>
          <Textarea
            rows={2}
            value={comment}
            maxLength={2200}
            disabled={locked}
            onChange={(e) => setComment(e.target.value)}
          />
        </label>
        {comment.trim() && (
          <div className="sm-row-actions">
            <button
              type="button"
              className="sl-link"
              onClick={() => copy(comment, "Comentário")}
            >
              <Copy size={12} /> Copiar comentário
            </button>
          </div>
        )}

        {video && dest.includes("instagram") && (
          <fieldset className="sm-cover" disabled={locked}>
            <legend>Capa do Reels</legend>
            <label className="sm-check">
              <input
                type="radio"
                name="cover"
                checked={!cover}
                onChange={() => setCover(null)}
              />
              Primeiro quadro do vídeo
            </label>
            <label className="sm-check">
              <input
                type="radio"
                name="cover"
                checked={!!cover && "seconds" in cover}
                onChange={() => setCover({ seconds: 1 })}
              />
              Quadro no segundo
              <Input
                type="number"
                min={0}
                max={900}
                step={0.5}
                className="sm-seconds"
                value={cover && "seconds" in cover ? cover.seconds : 1}
                onChange={(e) =>
                  setCover({
                    seconds: Math.max(0, Number(e.target.value) || 0),
                  })
                }
              />
            </label>
            {images.map((a) => (
              <label key={a.id} className="sm-check">
                <input
                  type="radio"
                  name="cover"
                  checked={!!cover && "art" in cover && cover.art === a.id}
                  onChange={() => setCover({ art: a.id })}
                />
                Imagem: {a.name}
              </label>
            ))}
          </fieldset>
        )}

        {due && canWrite && (
          <section className="sm-publish">
            <h4>{published ? "Publicado" : "Publicar"}</h4>
            {published ? (
              schedule.published_url ? (
                <a
                  href={schedule.published_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={13} /> Abrir o post publicado
                </a>
              ) : (
                <p className="sl-muted">Marcado como publicado, sem link.</p>
              )
            ) : (
              <>
                <p className="sl-muted">
                  Publique as artes com a legenda acima
                  {comment.trim() ? " e o primeiro comentário" : ""} em{" "}
                  {dest.map((d) => destinationLabels[d]).join(", ")}. Depois,
                  cole o link do post (opcional) e marque como publicado.
                </p>
                <Input
                  type="url"
                  icon={Link2}
                  placeholder="https://www.instagram.com/p/…"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </>
            )}
          </section>
        )}

        {error && <p className="sl-alert bad">{error}</p>}
        <div className="form-footer">
          {schedule && !published && !publishing && canWrite && (
            <Button
              className="btn secondary danger-text"
              loading={busy === "cancel"}
              onClick={() =>
                run(
                  "cancel",
                  async () => {
                    await backend.cancelSchedule(planId, post.number);
                    onClose();
                  },
                  `Post ${post.number} saiu do agendamento.`,
                )
              }
            >
              <X size={14} /> Tirar do agendamento
            </Button>
          )}
          <span className="sm-spacer" />
          {published && canWrite && schedule?.published_via !== "meta" && (
            <Button
              className="btn secondary"
              loading={busy === "undo"}
              onClick={() =>
                run(
                  "undo",
                  () => backend.setPublished(planId, post.number, false),
                  `Post ${post.number} voltou para “hora de publicar”.`,
                )
              }
            >
              <RotateCcw size={14} /> Desfazer publicado
            </Button>
          )}
          {due && !published && canWrite && (
            <Button
              className="btn primary"
              loading={busy === "publish"}
              onClick={() =>
                run(
                  "publish",
                  async () => {
                    await backend.setPublished(planId, post.number, true, url);
                    onClose();
                  },
                  `Post ${post.number} marcado como publicado.`,
                )
              }
            >
              <Check size={14} /> Marcar como publicado
            </Button>
          )}
          {!locked && (
            <Button
              className={`btn ${due ? "secondary" : "primary"}`}
              loading={busy === "save"}
              disabled={!day || !time || !dest.length}
              onClick={save}
            >
              <CalendarDays size={14} />{" "}
              {schedule ? "Salvar agendamento" : "Agendar"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ MAVI
function SuggestModal({
  company,
  contract,
  planId,
  posts,
  backend,
  notify,
  onClose,
  onChanged,
}: {
  company: string;
  contract: string;
  planId: string;
  posts: SlPost[];
  backend: SocialLeadsBackend;
  notify: (m: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [result, setResult] = useState<ScheduleSuggestion | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const ask = () => {
    setBusy("ask");
    setError("");
    backend
      .suggestSchedule(company, contract, planId, instruction.trim())
      .then((r) => {
        setResult(r);
        setPicked(r.posts.map((p) => p.numero));
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(""));
  };
  const apply = () => {
    if (!result) return;
    setBusy("apply");
    setError("");
    const items: SmScheduleDraft[] = result.posts
      .filter((p) => picked.includes(p.numero))
      .map((p) => ({
        number: p.numero,
        at: p.at,
        destinations: p.destinations,
        caption: null,
        first_comment: "",
        cover: null,
      }));
    backend
      .saveSchedule(planId, items)
      .then(() => {
        notify(
          `${items.length} ${items.length === 1 ? "post agendado" : "posts agendados"}. Dá para mudar cada um no calendário.`,
        );
        onChanged();
        onClose();
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(""));
  };
  return (
    <Modal title="Sugerir datas com a MAVI" onClose={onClose} busy={!!busy}>
      <div className="entity-form sm-suggest">
        {!result ? (
          <>
            <p>
              A MAVI distribui os posts com arte que ainda não têm data nas
              próximas semanas, alternando os pilares, nos dias e horários em
              que o público do cliente costuma estar ativo. Você revisa antes de
              agendar.
            </p>
            <label>
              Alguma preferência? (opcional)
              <Textarea
                rows={2}
                maxLength={1000}
                placeholder="Ex.: só dias úteis; Reels às 19h; nada no fim de semana do feriado."
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            {result.summary && (
              <p className="sm-suggest-summary">
                <Sparkles size={14} /> {result.summary}
                {result.cost_usd > 0 && (
                  <small> · MAVI {formatUsd(result.cost_usd)}</small>
                )}
              </p>
            )}
            <ul className="sm-suggest-list">
              {result.posts.map((s) => {
                const p = posts.find((x) => x.number === s.numero);
                return (
                  <li key={s.numero}>
                    <label className="sm-check">
                      <Checkbox
                        checked={picked.includes(s.numero)}
                        onCheckedChange={(v) =>
                          setPicked((list) =>
                            v === true
                              ? [...list, s.numero]
                              : list.filter((x) => x !== s.numero),
                          )
                        }
                      />
                      <span>
                        <strong>
                          {localWhen(s.at)} · Post {s.numero}
                        </strong>
                        <small>
                          {p?.hook} ·{" "}
                          {s.destinations
                            .map((d) => destinationLabels[d])
                            .join(", ")}
                        </small>
                        {s.reason && <em>{s.reason}</em>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {error && <p className="sl-alert bad">{error}</p>}
        <div className="form-footer">
          <Button className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          {result ? (
            <>
              <Button
                className="btn secondary"
                loading={busy === "ask"}
                onClick={ask}
              >
                <RotateCcw size={14} /> Sugerir de novo
              </Button>
              <Button
                className="btn primary"
                loading={busy === "apply"}
                disabled={!picked.length}
                onClick={apply}
              >
                <CalendarDays size={14} /> Agendar {picked.length}
              </Button>
            </>
          ) : (
            <Button
              className="btn primary"
              loading={busy === "ask"}
              onClick={ask}
            >
              <Sparkles size={14} /> Sugerir
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ Meta
const CONNECT_RESULTS: Record<string, string> = {
  cancelado: "A conexão com o Facebook foi cancelada.",
  "sem-paginas":
    "Esse Facebook não administra nenhuma Página. Entre com quem administra a Página do cliente.",
  erro: "Não foi possível conectar com o Meta. Tente de novo.",
};

/**
 * The client's Page and Instagram for the automatic publishing: connected
 * by the agency (administrators and managers) or by the client through a
 * link. Uses the Social Media's own Meta app: connecting here never touches
 * Campanhas' connection.
 */
function MetaConnection({
  contract,
  account,
  canWrite,
  isLeader,
  backend,
  who,
  notify,
  onChanged,
}: {
  contract: string;
  account: SmAccount | null;
  canWrite: boolean;
  isLeader: boolean;
  backend: SocialLeadsBackend;
  who: (id: string | null) => string | undefined;
  notify: (m: string) => void;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<{
    configured: boolean;
    missing: string[];
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [link, setLink] = useState("");
  const [pending, setPending] = useUrlState<string>("sm_pendente", "");
  const [result, setResult] = useUrlState<string>("sm_conexao", "");
  useEffect(() => {
    backend
      .metaStatus()
      .then(setConfig)
      .catch(() => setConfig({ configured: false, missing: [] }));
  }, [backend]);
  useEffect(() => {
    if (!result) return;
    notify(CONNECT_RESULTS[result] ?? CONNECT_RESULTS.erro);
    setResult("");
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  const connected = !!account?.page_id;
  const run = (key: string, work: () => Promise<void>) => {
    setBusy(key);
    work()
      .catch((e) => notify((e as Error).message))
      .finally(() => setBusy(""));
  };
  const copyLink = (renew = false) =>
    run(renew ? "renew" : "link", async () => {
      const token = await backend.connectLink(contract, renew);
      const url = connectUrl(token);
      setLink(url);
      await navigator.clipboard.writeText(url).catch(() => {});
      notify(
        renew
          ? "Link novo copiado. O anterior parou de funcionar."
          : "Link copiado. Mande para o cliente conectar a Página dele.",
      );
    });

  return (
    <section
      className={`sm-meta ${connected ? (account?.connection_error ? "bad" : "on") : ""}`}
      aria-label="Publicação automática pelo Meta"
    >
      <div className="sm-meta-head">
        <PlugZap size={16} />
        <div>
          {connected ? (
            <>
              <strong>
                Publicação automática ligada: {account!.page_name}
                {account!.ig_username ? ` · @${account!.ig_username}` : ""}
              </strong>
              <small>
                {account!.connected_via === "client"
                  ? `Conectado pelo cliente${account!.connected_name ? ` (${account!.connected_name})` : ""}`
                  : `Conectado pela agência${account!.connected_by ? ` · ${who(account!.connected_by) ?? account!.connected_name ?? ""}` : ""}`}
                {account!.connected_at &&
                  ` em ${new Date(account!.connected_at).toLocaleDateString("pt-BR")}`}
                . Na hora marcada o post sai sozinho; se algo falhar, a equipe é
                avisada para publicar à mão.
                {!account!.ig_user_id &&
                  " Esta Página não tem Instagram profissional ligado: só o Facebook sai sozinho."}
              </small>
            </>
          ) : (
            <>
              <strong>Publicação manual (lembrete)</strong>
              <small>
                Na hora marcada, o MAVI avisa quem agendou, quem fez a arte e a
                criação do cliente, com a arte e a legenda prontas para
                publicar. Conecte a Página e o Instagram do cliente para os
                posts saírem sozinhos.
              </small>
            </>
          )}
        </div>
      </div>
      {account?.connection_error && (
        <p className="sl-alert bad">
          <CircleAlert size={15} /> A conexão caiu: {account.connection_error}{" "}
          Reconecte; até lá, os posts voltam para o lembrete.
        </p>
      )}
      {config &&
        !config.configured &&
        config.missing.length > 0 &&
        isLeader && (
          <p className="sl-alert warn">
            <TriangleAlert size={15} /> Falta na Vercel:{" "}
            {config.missing.join(", ")}. Depois de salvar, faça um Redeploy.
          </p>
        )}
      {canWrite && config?.configured && (
        <div className="sm-meta-actions">
          {isLeader && (
            <Button
              className={`btn ${connected && !account?.connection_error ? "secondary" : "primary"}`}
              loading={busy === "connect"}
              onClick={() =>
                run("connect", async () => {
                  window.location.assign(await backend.connectMeta(contract));
                })
              }
            >
              <PlugZap size={14} />
              {connected ? "Reconectar pela agência" : "Conectar pela agência"}
            </Button>
          )}
          <Button
            className="btn secondary"
            loading={busy === "link"}
            onClick={() => copyLink()}
          >
            <Link2 size={14} /> Copiar link para o cliente conectar
          </Button>
          {link && (
            <button
              type="button"
              className="sl-link"
              disabled={busy === "renew"}
              onClick={() => copyLink(true)}
            >
              <RefreshCw size={12} /> Trocar o link
            </button>
          )}
          {connected && (
            <button
              type="button"
              className="sl-link danger"
              disabled={busy === "off"}
              onClick={() =>
                run("off", async () => {
                  await backend.disconnectMeta(contract);
                  notify(
                    "Desconectado. Os próximos posts voltam para o lembrete.",
                  );
                  onChanged();
                })
              }
            >
              <Unplug size={12} /> Desconectar
            </button>
          )}
        </div>
      )}
      {link && <p className="sm-meta-link">{link}</p>}
      {pending && (
        <PickPage
          pending={pending}
          backend={backend}
          notify={notify}
          onClose={() => setPending("")}
          onDone={() => {
            setPending("");
            onChanged();
          }}
        />
      )}
    </section>
  );
}

/** After the agency's Facebook login: which Page is this client's. */
function PickPage({
  pending,
  backend,
  notify,
  onClose,
  onDone,
}: {
  pending: string;
  backend: SocialLeadsBackend;
  notify: (m: string) => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const [data, setData] = useState<{
    fb_user_name: string;
    client: string;
    pages: SmPage[];
  } | null>(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    backend
      .pendingPages(pending)
      .then((d) => {
        setData(d);
        if (d.pages.length === 1) setPage(d.pages[0].id);
      })
      .catch((e) => setError((e as Error).message));
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Modal title="Qual é a Página do cliente?" onClose={onClose} busy={busy}>
      <div className="entity-form">
        {error ? (
          <p className="sl-alert bad">{error}</p>
        ) : !data ? (
          <p className="sl-muted">Carregando as Páginas…</p>
        ) : (
          <>
            <p>
              Páginas que {data.fb_user_name || "este Facebook"} administra.
              Escolha a de <strong>{data.client}</strong>: os posts saem nela e
              no Instagram ligado a ela.
            </p>
            <PageList pages={data.pages} value={page} onChange={setPage} />
          </>
        )}
        <div className="form-footer">
          <Button className="btn secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            className="btn primary"
            loading={busy}
            disabled={!page}
            onClick={() => {
              setBusy(true);
              backend
                .choosePage(pending, page)
                .then(() => {
                  notify(
                    "Conectado. Os posts agendados saem sozinhos na hora.",
                  );
                  onDone();
                })
                .catch((e) => setError((e as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            <PlugZap size={14} /> Conectar esta Página
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** The Pages to pick from, with each one's Instagram (shared with the client link). */
export function PageList({
  pages,
  value,
  onChange,
}: {
  pages: SmPage[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <ul className="sm-pages">
      {pages.map((p) => (
        <li key={p.id}>
          <label className={`sm-page ${value === p.id ? "on" : ""}`}>
            <input
              type="radio"
              name="sm-page"
              checked={value === p.id}
              onChange={() => onChange(p.id)}
            />
            <span>
              <strong>{p.name}</strong>
              <small>
                {p.ig_username
                  ? `Instagram @${p.ig_username}`
                  : "Sem Instagram profissional ligado (só o Facebook)"}
              </small>
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}
