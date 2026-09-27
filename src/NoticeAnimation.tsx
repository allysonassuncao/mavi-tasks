import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertTriangle,
  BarChart3,
  BellRing,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock3,
  FileText,
  Gift,
  Heart,
  Lightbulb,
  Megaphone,
  MousePointerClick,
  Pause,
  Play,
  RotateCcw,
  Rocket,
  ShieldCheck,
  Sparkles,
  Star,
  Users,
  type LucideIcon,
} from "lucide-react";
import type {
  AnimIcon,
  AnimationSpec,
  Scene,
  UiItem,
} from "./notice-animation";

const ICON: Record<Exclude<AnimIcon, "none">, LucideIcon> = {
  bell: BellRing,
  calendar: CalendarDays,
  check: CheckCircle2,
  sparkles: Sparkles,
  megaphone: Megaphone,
  users: Users,
  file: FileText,
  clock: Clock3,
  alert: AlertTriangle,
  rocket: Rocket,
  star: Star,
  gift: Gift,
  lightbulb: Lightbulb,
  shield: ShieldCheck,
  chart: BarChart3,
  heart: Heart,
  mouse: MousePointerClick,
};

/**
 * O player das animações do Mural: toca o roteiro de cenas com CSS (as
 * medidas são do próprio quadro, 16:9, então fica igual no popup e no
 * celular) e os componentes do app. Nenhum código da MAVI roda aqui: só os
 * campos conhecidos, e texto como texto.
 *
 * O tempo de cada cena corre num relógio que pausa (botão, aba escondida)
 * e continua de onde parou; as animações da cena pausam junto. Com
 * "reduzir movimento" no sistema, as cenas aparecem sem movimento.
 */
export function NoticeAnimation({
  spec,
  images,
  autoplay = true,
  label = "Animação do aviso",
}: {
  spec: AnimationSpec;
  /** Links dos prints, pelo id do anexo. */
  images: Record<string, string>;
  autoplay?: boolean;
  label?: string;
}) {
  const scenes = spec.scenes;
  const [index, setIndex] = useState(0);
  const [run, setRun] = useState(0);
  const [playing, setPlaying] = useState(autoplay);
  const [ended, setEnded] = useState(false);
  // O relógio: quanto da cena atual já tocou. Cada troca de cena é uma
  // rodada nova (id), para a pausa da rodada anterior não contar nela.
  const clock = useRef({ id: 0, played: 0 });
  const scene = scenes[Math.min(index, scenes.length - 1)];

  const go = useCallback(
    (to: number, play = true) => {
      const k = Math.max(0, Math.min(scenes.length - 1, to));
      clock.current = { id: clock.current.id + 1, played: 0 };
      setIndex(k);
      setRun(clock.current.id);
      setEnded(false);
      setPlaying(play);
    },
    [scenes],
  );

  useEffect(() => {
    if (!playing || ended || !scene) return;
    const id = clock.current.id;
    const start = performance.now();
    const timer = setTimeout(
      () => {
        if (index < scenes.length - 1) go(index + 1);
        else {
          setEnded(true);
          setPlaying(false);
        }
      },
      Math.max(0, scene.duration - clock.current.played) * 1000,
    );
    return () => {
      clearTimeout(timer);
      if (clock.current.id === id)
        clock.current.played += (performance.now() - start) / 1000;
    };
  }, [playing, ended, index, run, scene, scenes, go]);

  // Aba escondida: pausa (e não volta sozinha no meio de outra coisa).
  useEffect(() => {
    const onHide = () => document.hidden && setPlaying(false);
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  if (!scene) return null;
  return (
    <figure
      className={`nanim ${spec.theme} ${playing ? "" : "paused"}`}
      aria-label={label}
      aria-roledescription="animação"
    >
      <div className="nanim-stage">
        <SceneView key={`${index}-${run}`} scene={scene} images={images} />
        <span className="nanim-tag" aria-hidden="true">
          <Sparkles /> Mural
        </span>
      </div>
      <figcaption className="nanim-bar">
        <button
          type="button"
          className="nanim-btn"
          aria-label={ended ? "Ver de novo" : playing ? "Pausar" : "Continuar"}
          onClick={() => (ended ? go(0) : setPlaying((p) => !p))}
        >
          {ended ? <RotateCcw /> : playing ? <Pause /> : <Play />}
        </button>
        <button
          type="button"
          className="nanim-btn"
          aria-label="Cena anterior"
          disabled={index === 0}
          onClick={() => go(index - 1)}
        >
          <ChevronLeft />
        </button>
        <div className="nanim-progress" role="group" aria-label="Cenas">
          {scenes.map((s, i) => (
            <button
              type="button"
              key={i}
              aria-label={`Cena ${i + 1} de ${scenes.length}`}
              aria-current={i === index || undefined}
              className={
                i < index || (ended && i === index)
                  ? "done"
                  : i === index
                    ? "now"
                    : ""
              }
              style={{ "--d": `${s.duration}s` } as CSSProperties}
              onClick={() => go(i)}
            >
              <i key={i === index ? run : undefined} />
            </button>
          ))}
        </div>
        <button
          type="button"
          className="nanim-btn"
          aria-label="Próxima cena"
          disabled={index === scenes.length - 1}
          onClick={() => go(index + 1)}
        >
          <ChevronRight />
        </button>
      </figcaption>
    </figure>
  );
}

function SceneIcon({ icon }: { icon?: AnimIcon }) {
  if (!icon || icon === "none") return null;
  const Icon = ICON[icon];
  return (
    <span className="nanim-icon" aria-hidden="true">
      <Icon />
    </span>
  );
}

function SceneView({
  scene,
  images,
}: {
  scene: Scene;
  images: Record<string, string>;
}) {
  const style = { "--d": `${scene.duration}s` } as CSSProperties;
  const cls = `nanim-scene ${scene.layout} t-${scene.transition}`;
  if (scene.layout === "screen")
    return (
      <div className={cls} style={style}>
        <ScreenScene
          scene={scene}
          url={scene.image ? images[scene.image] : undefined}
        />
      </div>
    );
  if (scene.layout === "mockup")
    return (
      <div className={cls} style={style}>
        <MockupScene scene={scene} />
      </div>
    );
  return (
    <div className={cls} style={style}>
      <span className="nanim-shape a" aria-hidden="true" />
      <span className="nanim-shape b" aria-hidden="true" />
      <div className="nanim-copy">
        <SceneIcon
          icon={
            scene.icon ?? (scene.layout === "title" ? "sparkles" : undefined)
          }
        />
        {scene.layout === "stat" && scene.stat && (
          <p className="nanim-stat">
            <strong>{scene.stat.value}</strong>
            {scene.stat.label && <span>{scene.stat.label}</span>}
          </p>
        )}
        {scene.heading && <h3 className="nanim-heading">{scene.heading}</h3>}
        {scene.text && <p className="nanim-text">{scene.text}</p>}
        {scene.bullets && (
          <ol
            className={`nanim-bullets ${scene.layout === "steps" ? "steps" : ""}`}
          >
            {scene.bullets.map((b, i) => (
              <li key={i} style={{ "--i": i } as CSSProperties}>
                {scene.layout === "steps" && <b>{i + 1}</b>}
                <span>{b}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/** A legenda perto do cursor, sem sair da tela (acima dele quando está embaixo). */
function Callout({ x, y, text }: { x: number; y: number; text: string }) {
  return (
    <span
      className={`nanim-callout ${y > 68 ? "up" : ""}`}
      style={
        {
          "--x": `${Math.min(80, Math.max(20, x))}%`,
          "--y": `${y}%`,
        } as CSSProperties
      }
    >
      {text}
    </span>
  );
}

function Cursor({ x, y, click }: { x: number; y: number; click: boolean }) {
  return (
    <span
      className={`nanim-cursor ${click ? "click" : ""}`}
      style={{ "--x": `${x}%`, "--y": `${y}%` } as CSSProperties}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24">
        <path d="M5 3l14 8-6 1.6L10.4 19z" />
      </svg>
      <i />
    </span>
  );
}

/** O print numa janela do navegador, com o destaque, o cursor e a legenda. */
function ScreenScene({ scene, url }: { scene: Scene; url?: string }) {
  const [ratio, setRatio] = useState(16 / 10);
  const f = scene.focus;
  const target =
    scene.cursor ??
    (f ? { x: f.x + f.w / 2, y: f.y + f.h / 2, click: true } : null);
  return (
    <div className="nanim-screen">
      {scene.heading && (
        <h3 className="nanim-heading small">{scene.heading}</h3>
      )}
      <div className="nanim-window" style={{ "--ar": ratio } as CSSProperties}>
        <div className="nanim-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="nanim-shot">
          {url ? (
            <img
              src={url}
              alt=""
              onLoad={(e) => {
                const img = e.currentTarget;
                if (img.naturalWidth && img.naturalHeight)
                  setRatio(img.naturalWidth / img.naturalHeight);
              }}
            />
          ) : (
            <span className="nanim-shot-wait" />
          )}
          {f && (
            <span
              className="nanim-focus"
              style={
                {
                  left: `${f.x}%`,
                  top: `${f.y}%`,
                  width: `${f.w}%`,
                  height: `${f.h}%`,
                } as CSSProperties
              }
            />
          )}
          {target && <Cursor x={target.x} y={target.y} click={target.click} />}
          {scene.callout && (
            <Callout
              x={target?.x ?? 50}
              y={target?.y ?? 50}
              text={scene.callout}
            />
          )}
        </div>
      </div>
      {scene.text && <p className="nanim-text small">{scene.text}</p>}
    </div>
  );
}

/** A interface recriada com os componentes do app; o cursor vai ao alvo. */
function MockupScene({ scene }: { scene: Scene }) {
  const ui = scene.ui ?? [];
  const menu = ui.find((u) => u.kind === "menu");
  const rest = ui.filter((u) => u !== menu);
  const box = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const target = scene.target !== undefined ? ui[scene.target] : undefined;
  // Onde está o alvo, em % da janela. Pela posição do layout (offset*), que
  // não muda com as animações de entrada (deslize, zoom) ainda em curso.
  useLayoutEffect(() => {
    const b = box.current;
    let el = targetRef.current;
    if (!b || !el || !b.offsetWidth) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = 0;
    let y = 0;
    while (el && el !== b) {
      x += el.offsetLeft;
      y += el.offsetTop;
      el = el.offsetParent as HTMLElement | null;
    }
    if (el !== b) return;
    setPoint({
      x: ((x + w / 2) / b.offsetWidth) * 100,
      y: ((y + h / 2) / b.offsetHeight) * 100,
    });
  }, []);
  const ref = (u: UiItem) =>
    u === target
      ? (el: HTMLElement | null) => void (targetRef.current = el)
      : undefined;
  const cursor =
    scene.cursor || target
      ? (point ??
        (scene.cursor ? { x: scene.cursor.x, y: scene.cursor.y } : null))
      : null;
  return (
    <div className="nanim-screen">
      {scene.heading && (
        <h3 className="nanim-heading small">{scene.heading}</h3>
      )}
      <div className="nanim-window app" ref={box}>
        <div className="nanim-chrome" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="nanim-app">
          {menu && (
            <nav className="nanim-menu" ref={ref(menu)}>
              <span className="nanim-logo">
                <b>W</b>
              </span>
              {(menu.items ?? [menu.label]).map((item, i) => (
                <span
                  key={i}
                  className={i === menu.active ? "active" : ""}
                  style={{ "--i": i } as CSSProperties}
                >
                  {item}
                </span>
              ))}
            </nav>
          )}
          <div className="nanim-main">
            {rest.map((u, i) => (
              <UiView
                key={i}
                item={u}
                index={i}
                hit={u === target}
                refFn={ref(u)}
              />
            ))}
          </div>
        </div>
        {cursor && (
          <Cursor
            x={cursor.x}
            y={cursor.y}
            click={scene.cursor?.click ?? !!target}
          />
        )}
        {scene.callout && cursor && (
          <Callout x={cursor.x} y={cursor.y} text={scene.callout} />
        )}
      </div>
      {scene.text && <p className="nanim-text small">{scene.text}</p>}
    </div>
  );
}

function UiView({
  item,
  index,
  hit,
  refFn,
}: {
  item: UiItem;
  index: number;
  hit: boolean;
  refFn?: (el: HTMLElement | null) => void;
}) {
  const style = { "--i": index } as CSSProperties;
  const cls = `nanim-ui ${hit ? "hit" : ""}`;
  switch (item.kind) {
    case "button":
      return (
        <span
          ref={refFn}
          className={`${cls} nanim-button ${item.primary ? "primary" : ""}`}
          style={style}
        >
          {item.label}
        </span>
      );
    case "toggle":
      return (
        <span ref={refFn} className={`${cls} nanim-toggle`} style={style}>
          <i className={item.on ? "on" : ""} />
          {item.label}
        </span>
      );
    case "input":
      return (
        <span ref={refFn} className={`${cls} nanim-input`} style={style}>
          <small>{item.label}</small>
          <span>{item.text || " "}</span>
        </span>
      );
    case "badge":
      return (
        <span
          ref={refFn}
          className={`${cls} nanim-badge ${item.tone ?? "green"}`}
          style={style}
        >
          {item.label}
        </span>
      );
    case "list":
      return (
        <span ref={refFn} className={`${cls} nanim-list`} style={style}>
          {item.label && <strong>{item.label}</strong>}
          {(item.items ?? []).map((x, i) => (
            <span key={i}>{x}</span>
          ))}
        </span>
      );
    case "menu":
      return (
        <span ref={refFn} className={`${cls} nanim-tabs`} style={style}>
          {(item.items ?? [item.label]).map((x, i) => (
            <span key={i} className={i === item.active ? "active" : ""}>
              {x}
            </span>
          ))}
        </span>
      );
    default:
      return (
        <span ref={refFn} className={`${cls} nanim-card`} style={style}>
          <strong>{item.label}</strong>
          {item.text && <span>{item.text}</span>}
        </span>
      );
  }
}

/** Links dos prints de uma animação, pedidos uma vez. */
export function useAnimationImages(
  ids: string[],
  load: (ids: string[]) => Promise<Record<string, string>>,
) {
  const key = ids.join();
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!key) return;
    let alive = true;
    load(key.split(","))
      .then((u) => alive && setUrls(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => urls, [urls]);
}
