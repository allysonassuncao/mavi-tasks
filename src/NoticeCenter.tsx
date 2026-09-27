import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, BellRing, X } from "lucide-react";
import { Button } from "./ui";
import { RichTextContent } from "./RichTextContent";
import { LevelChip, LEVEL_ICONS, NoticeAttachments } from "./NoticeParts";
import {
  bannerNotices,
  nextPopup,
  unseenCount,
  whenLabel,
  type LiveNotice,
  type NoticeAction,
  type NoticeAttachment,
  type NoticesApi,
} from "./notices";

/**
 * Os avisos do Mural sobre qualquer tela: o popup (um de cada vez, o mais
 * urgente primeiro) e as faixas no topo. A lista vem do banco ao abrir o app
 * e a cada aviso ao vivo ("mavi:notices", repassado por App.tsx) — sem
 * consultas periódicas. Quando o aviso é para muita gente, cada app espera
 * um instante aleatório antes de perguntar, para não chegarem todos juntos.
 */
export function NoticeCenter({
  api,
  company,
  user,
  onOpen,
  onCount,
}: {
  api: NoticesApi;
  company: string;
  user: string;
  /** Abre o aviso no Mural. */
  onOpen: (id: string) => void;
  /** Avisos no ar que a pessoa ainda não viu (o contador do menu). */
  onCount: (n: number) => void;
}) {
  const [live, setLive] = useState<LiveNotice[]>([]);
  // O que a pessoa acabou de responder some na hora, antes do banco confirmar.
  const [done, setDone] = useState<Set<string>>(new Set());
  const [attachments, setAttachments] = useState<
    Record<string, NoticeAttachment[]>
  >({});
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const wait = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(() => {
    const n = ++request.current;
    api
      .live(company)
      .then((list) => {
        if (n === request.current) setLive(list);
      })
      .catch(() => {});
  }, [api, company]);
  useEffect(load, [load]);
  useEffect(() => {
    const onNotice = (e: Event) => {
      const users = (e as CustomEvent<{ users?: string[] | null }>).detail
        ?.users;
      if (Array.isArray(users) && !users.includes(user)) return;
      clearTimeout(wait.current);
      // Poucas pessoas: na hora. Todos da agência: espalhados em até 3 s.
      wait.current = setTimeout(
        load,
        Array.isArray(users) ? 150 : 300 + Math.random() * 2700,
      );
    };
    window.addEventListener("mavi:notices", onNotice);
    return () => {
      window.removeEventListener("mavi:notices", onNotice);
      clearTimeout(wait.current);
    };
  }, [load, user]);

  const visible = useMemo(
    () =>
      live.map((n) =>
        done.has(`${n.id}:${n.round}:seen`)
          ? { ...n, seen_at: n.seen_at ?? "now" }
          : n,
      ),
    [live, done],
  );
  useEffect(() => onCount(unseenCount(visible)), [visible, onCount]);
  const popup = nextPopup(
    visible,
    Date.now(),
    new Set(
      [...done].filter((k) => k.endsWith(":popup")).map((k) => k.slice(0, -6)),
    ),
  );
  const banners = bannerNotices(visible).filter(
    (n) => !done.has(`${n.id}:${n.round}:banner`),
  );

  // Anexos do popup, só quando ele tem.
  useEffect(() => {
    if (!popup || !popup.attachments || attachments[popup.id]) return;
    let alive = true;
    api
      .detail(popup.id)
      .then((d) => {
        if (alive && d)
          setAttachments((a) => ({ ...a, [popup.id]: d.attachments }));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api, popup, attachments]);

  const mark = async (n: LiveNotice, action: NoticeAction) => {
    const key = `${n.id}:${n.round}`;
    setDone((s) => {
      const next = new Set(s);
      next.add(`${key}:seen`);
      if (action !== "close_banner") next.add(`${key}:popup`);
      if (action === "close_banner") next.add(`${key}:banner`);
      return next;
    });
    try {
      await api.mark(n.id, action);
    } catch {
      // O aviso volta na próxima vez que a lista for carregada.
    }
  };

  return (
    <>
      {!!banners.length && (
        <div className="notice-banners">
          {banners.map((n) => {
            const Icon = LEVEL_ICONS[n.level];
            return (
              <div
                key={n.id}
                className={`notice-banner ${n.level}`}
                role={n.level === "critical" ? "alert" : "status"}
              >
                <Icon size={17} aria-hidden="true" />
                <button
                  type="button"
                  className="notice-banner-text"
                  onClick={() => {
                    void mark(n, "seen");
                    onOpen(n.id);
                  }}
                >
                  <strong>{n.title}</strong>
                  <span>Ver no Mural</span>
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Fechar o aviso ${n.title}`}
                  onClick={() => void mark(n, "close_banner")}
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {popup && (
        <NoticePopup
          key={`${popup.id}:${popup.round}`}
          api={api}
          notice={popup}
          attachments={attachments[popup.id] ?? []}
          busy={busy}
          onAction={async (action) => {
            setBusy(true);
            await mark(popup, action);
            setBusy(false);
          }}
          onOpen={() => {
            void mark(popup, "seen");
            onOpen(popup.id);
          }}
        />
      )}
    </>
  );
}

function NoticePopup({
  api,
  notice,
  attachments,
  busy,
  onAction,
  onOpen,
}: {
  api: NoticesApi;
  notice: LiveNotice;
  attachments: NoticeAttachment[];
  busy: boolean;
  onAction: (action: NoticeAction) => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  const ack = notice.require_ack;
  return (
    <dialog
      ref={ref}
      className={`modal notice-popup ${notice.level}`}
      aria-label={notice.title}
      onCancel={(e) => {
        e.preventDefault();
        // Esc só fecha o que não pede confirmação.
        if (!ack && !busy) onAction("seen");
      }}
    >
      <div className="notice-popup-head">
        <span className="notice-popup-mark" aria-hidden="true">
          <BellRing size={20} />
        </span>
        <div>
          <LevelChip level={notice.level} />
          <h2>{notice.title}</h2>
          <small>
            {notice.author_name} · {whenLabel(notice.delivered_at)}
          </small>
        </div>
        {!ack && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar"
            onClick={() => onAction("seen")}
            disabled={busy}
          >
            <X size={20} />
          </button>
        )}
      </div>
      <div className="notice-popup-body">
        {notice.body && <RichTextContent value={notice.body} />}
        <NoticeAttachments api={api} items={attachments} />
      </div>
      <div className="form-footer notice-popup-foot">
        <button type="button" className="text-btn" onClick={onOpen}>
          Abrir no Mural <ArrowRight size={14} />
        </button>
        {ack ? (
          <>
            <Button
              className="btn secondary"
              onClick={() => onAction("snooze")}
              disabled={busy}
            >
              Lembrar amanhã
            </Button>
            <Button
              className="btn primary"
              onClick={() => onAction("ack")}
              loading={busy}
            >
              Li e entendi
            </Button>
          </>
        ) : (
          <Button
            className="btn primary"
            onClick={() => onAction("seen")}
            loading={busy}
          >
            Entendi
          </Button>
        )}
      </div>
    </dialog>
  );
}
