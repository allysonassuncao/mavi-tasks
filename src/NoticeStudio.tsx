import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CloudUpload,
  Film,
  Loader2,
  Pencil,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Checkbox, Select, SelectOption, Textarea } from "./ui";
import { NoticeAnimation, useAnimationImages } from "./NoticeAnimation";
import { catalogEntry } from "./ai-providers";
import {
  estimateCost,
  LAYOUT_LABELS,
  MAX_REFERENCES,
  sanitizeSpec,
  specImages,
  totalSeconds,
  type AnimationSpec,
  type Scene,
} from "./notice-animation";
import type {
  AnimationOptions,
  AnimationVersion,
  NoticeAttachment,
  NoticesApi,
} from "./notices";

const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const DEFAULT = "default";
const money = (v: number) =>
  v < 0.01
    ? "menos de US$ 0,01"
    : `US$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * O estúdio da animação de um aviso (já salvo). Quem cria pede em texto o
 * que a animação deve mostrar, escolhe os prints (imagens anexadas ao aviso,
 * ou envia na hora), o modelo liberado e se a MAVI consulta a base de
 * conhecimento, com o custo estimado antes de gerar. A geração roda em
 * segundo plano: dá para fechar e voltar pelo aviso na caixa de entrada.
 * Cada geração, ajuste ou edição de texto das cenas vira uma versão; num
 * aviso no ar, quem recebe continua vendo a versão escolhida até "Usar".
 */
export function NoticeStudio({
  api,
  company,
  notice,
  live,
  attachments,
  demo,
  notify,
  onClose,
  onAttachments,
}: {
  api: NoticesApi;
  company: string;
  notice: string;
  live: boolean;
  attachments: NoticeAttachment[];
  demo: boolean;
  notify: (message: string) => void;
  onClose: () => void;
  /** Prints enviados daqui (entram nos anexos do aviso). */
  onAttachments: (list: NoticeAttachment[]) => void;
}) {
  const [options, setOptions] = useState<AnimationOptions | null>(null);
  const [versions, setVersions] = useState<AnimationVersion[] | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [request, setRequest] = useState("");
  const [model, setModel] = useState(DEFAULT);
  const [knowledge, setKnowledge] = useState(false);
  const [refs, setRefs] = useState<string[] | null>(null);
  const [files, setFiles] = useState<NoticeAttachment[]>(attachments);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AnimationSpec | null>(null);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const images = files.filter((a) => IMAGE.test(a.content_type));

  const load = useCallback(() => {
    api
      .animations(notice)
      .then((list) => {
        setVersions(list);
        setSelected((s) =>
          s && list.some((v) => v.id === s)
            ? s
            : ((list.find((v) => v.current) ?? list[0])?.id ?? ""),
        );
      })
      .catch((e) => setError((e as Error).message));
  }, [api, notice]);
  useEffect(load, [load]);
  useEffect(() => {
    api
      .animationOptions(company)
      .then((o) => {
        setOptions(o);
        if (o.models[0])
          setModel(`${o.models[0].provider_id}|${o.models[0].model}`);
      })
      .catch((e) => setError((e as Error).message));
  }, [api, company]);
  // A geração termina em segundo plano: o aviso ao vivo traz a versão nova.
  useEffect(() => {
    const t: { id?: ReturnType<typeof setTimeout> } = {};
    const onNotice = (e: Event) => {
      const d = (e as CustomEvent<{ notice?: string }>).detail;
      if (d?.notice && d.notice !== notice) return;
      clearTimeout(t.id);
      t.id = setTimeout(load, 300);
    };
    window.addEventListener("mavi:notices", onNotice);
    return () => {
      window.removeEventListener("mavi:notices", onNotice);
      clearTimeout(t.id);
    };
  }, [load, notice]);

  const version = versions?.find((v) => v.id === selected) ?? null;
  const generating = versions?.find((v) => v.status === "generating");
  const ready = version?.status === "ready" ? version : null;
  // Os prints da versão escolhida (ou todos, numa animação nova).
  const pickedRefs =
    refs ??
    (ready?.refs.length ? ready.refs : images.map((a) => a.id)).slice(
      0,
      MAX_REFERENCES,
    );
  const chosen = useMemo(() => {
    if (!options) return null;
    if (model === DEFAULT) return options.default;
    return (
      options.models.find((m) => `${m.provider_id}|${m.model}` === model) ??
      null
    );
  }, [options, model]);
  const price =
    chosen?.price ??
    catalogEntry("anthropic")?.models.find(
      (m) => m.id === (chosen?.model ?? "claude-opus-5-5"),
    ) ??
    null;
  const cost = estimateCost(price, {
    images: pickedRefs.length,
    knowledge: knowledge && !!options?.knowledge,
    adjusting: !!ready,
  });
  const shown = editing ?? ready?.spec ?? null;
  const urls = useAnimationImages(specImages(shown), (ids) =>
    api.attachmentUrls(ids, true),
  );

  async function generate(adjust: boolean) {
    setError("");
    if (request.trim().length < 3)
      return setError(
        adjust
          ? "Diga o que ajustar nesta versão."
          : "Conte o que a animação deve mostrar.",
      );
    setBusy(true);
    try {
      const [provider, m] = model === DEFAULT ? [null, null] : model.split("|");
      await api.animate(company, notice, {
        request: request.trim(),
        provider,
        model: m,
        refs: pickedRefs,
        knowledge: knowledge && !!options?.knowledge,
        base: adjust && ready ? ready.id : null,
      });
      setRequest("");
      notify(
        "A MAVI começou a criar a animação. Pode fechar: você recebe um aviso quando ficar pronta.",
      );
      load();
    } catch (e) {
      setError((e as Error).message || "Não foi possível começar a animação.");
    } finally {
      setBusy(false);
    }
  }

  async function upload(list: File[]) {
    setUploading(true);
    setError("");
    try {
      const added: NoticeAttachment[] = [];
      for (const file of list.filter((f) => IMAGE.test(f.type))) {
        const id = await api.upload(notice, file, () => {});
        added.push({
          id,
          name: file.name,
          content_type: file.type,
          size_bytes: file.size,
          source: "upload",
        });
      }
      if (added.length) {
        setFiles((f) => [...f, ...added]);
        setRefs((r) =>
          [...(r ?? pickedRefs), ...added.map((a) => a.id)].slice(
            0,
            MAX_REFERENCES,
          ),
        );
        onAttachments(added);
      }
    } catch (e) {
      setError((e as Error).message || "Não foi possível enviar o print.");
    } finally {
      setUploading(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setBusy(true);
    setError("");
    try {
      const clean = sanitizeSpec(editing, new Set(files.map((f) => f.id)));
      const id = await api.saveAnimation(notice, clean, ready?.id ?? null);
      setEditing(null);
      setSelected(id);
      notify(
        live
          ? "Versão salva. Use “Usar no aviso” para quem recebe ver."
          : "Versão salva.",
      );
      load();
    } catch (e) {
      setError((e as Error).message || "Não foi possível salvar.");
    } finally {
      setBusy(false);
    }
  }

  async function use(id: string | null) {
    setBusy(true);
    try {
      await api.useAnimation(notice, id);
      notify(
        id
          ? "Esta é a animação do aviso agora."
          : "O aviso ficou sem animação.",
      );
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Animação do aviso"
      onClose={onClose}
      busy={busy}
      className="notice-studio-modal"
    >
      <div className="notice-studio">
        <section className="notice-studio-preview" aria-label="Prévia">
          {generating && (
            <p className="notice-studio-working" role="status">
              <Loader2 size={16} className="spin" /> A MAVI está criando a
              versão {generating.version}. Pode fechar: o aviso chega na sua
              caixa de entrada.
            </p>
          )}
          {shown ? (
            <NoticeAnimation
              key={`${selected}-${editing ? "edit" : "v"}`}
              spec={shown}
              images={urls}
            />
          ) : (
            <div className="notice-studio-empty">
              <Film size={26} aria-hidden="true" />
              <strong>Uma animação curta para o aviso</strong>
              <span>
                Até 30 segundos, só visual: o passo a passo de uma
                funcionalidade, um comunicado importante. Ela aparece no popup e
                no aviso aberto.
              </span>
            </div>
          )}
          {version?.status === "failed" && (
            <p className="form-error">
              <AlertTriangle size={14} /> A versão {version.version} falhou:{" "}
              {version.error}
            </p>
          )}
          {shown && !editing && ready && (
            <div className="notice-studio-meta">
              <span>
                Versão {ready.version} · {totalSeconds(ready.spec!)} s ·{" "}
                {ready.spec!.scenes.length} cenas
                {ready.cost_usd ? ` · ${money(ready.cost_usd)}` : ""}
              </span>
              {ready.current ? (
                <span className="notice-status live">
                  <Check size={12} /> No aviso
                </span>
              ) : (
                <Button
                  className="btn secondary"
                  onClick={() => void use(ready.id)}
                  disabled={busy}
                >
                  Usar no aviso
                </Button>
              )}
              <Button
                className="btn secondary"
                onClick={() => setEditing(structuredClone(ready.spec!))}
                disabled={busy}
              >
                <Pencil size={15} /> Editar textos
              </Button>
            </div>
          )}
          {editing && (
            <SceneEditor
              spec={editing}
              onChange={setEditing}
              onCancel={() => setEditing(null)}
              onSave={() => void saveEdit()}
              busy={busy}
            />
          )}
        </section>

        <section className="notice-studio-side" aria-label="Pedir à MAVI">
          <label>
            {ready
              ? "O que ajustar nesta versão"
              : "O que a animação deve mostrar"}
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              rows={4}
              maxLength={4000}
              placeholder={
                ready
                  ? "Ex.: deixe mais curta e destaque o botão Publicar"
                  : "Ex.: mostre como abrir o Mural, criar um aviso e escolher quem recebe, em 3 passos"
              }
              disabled={demo}
            />
          </label>

          <fieldset className="notice-studio-refs">
            <legend>Prints de referência</legend>
            {images.length ? (
              <div className="notice-studio-thumbs">
                {images.map((a) => {
                  const on = pickedRefs.includes(a.id);
                  return (
                    <label key={a.id} className={on ? "on" : ""} title={a.name}>
                      <Checkbox
                        checked={on}
                        onCheckedChange={(v) =>
                          setRefs(
                            (v === true
                              ? [...pickedRefs, a.id]
                              : pickedRefs.filter((x) => x !== a.id)
                            ).slice(0, MAX_REFERENCES),
                          )
                        }
                        disabled={!on && pickedRefs.length >= MAX_REFERENCES}
                      />
                      <Thumb api={api} id={a.id} name={a.name} />
                    </label>
                  );
                })}
              </div>
            ) : (
              <small>
                Sem prints: a MAVI recria as telas com os componentes do
                sistema.
              </small>
            )}
            <button
              type="button"
              className="text-btn"
              onClick={() => fileInput.current?.click()}
              disabled={uploading || demo}
            >
              <CloudUpload size={14} />{" "}
              {uploading ? "Enviando…" : "Enviar prints"}
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void upload(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </fieldset>

          <label>
            Modelo
            <Select
              value={model}
              onValueChange={setModel}
              aria-label="Modelo da animação"
              disabled={demo}
            >
              {(options?.models ?? []).map((m) => (
                <SelectOption
                  key={`${m.provider_id}|${m.model}`}
                  value={`${m.provider_id}|${m.model}`}
                >
                  {m.provider} · {m.model}
                </SelectOption>
              ))}
              <SelectOption value={DEFAULT}>
                {options?.default
                  ? `Padrão do Painel da MAVI · ${options.default.model}`
                  : "Padrão do servidor (Claude)"}
              </SelectOption>
            </Select>
          </label>
          {options?.knowledge ? (
            <label className="checkbox-label">
              <Checkbox
                checked={knowledge}
                onCheckedChange={(v) => setKnowledge(v === true)}
                disabled={demo}
              />
              Consultar a base de conhecimento da agência
            </label>
          ) : (
            <small className="notice-studio-note">
              A base de conhecimento está desligada para as animações pelo
              administrador.
            </small>
          )}
          <p className="notice-studio-cost">
            <Sparkles size={14} aria-hidden="true" />
            {cost === null
              ? "Custo pelo preço do modelo escolhido."
              : `Custo estimado: ${money(cost)} por geração.`}
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="notice-studio-actions">
            {ready && (
              <Button
                className="btn primary"
                loading={busy}
                disabled={!!generating || demo}
                onClick={() => void generate(true)}
              >
                <Wand2 size={16} /> Ajustar esta versão
              </Button>
            )}
            <Button
              className={ready ? "btn secondary" : "btn primary"}
              loading={busy && !ready}
              disabled={!!generating || demo || busy}
              onClick={() => void generate(false)}
            >
              <Sparkles size={16} />{" "}
              {ready ? "Criar outra do zero" : "Criar com a MAVI"}
            </Button>
          </div>
          {demo && (
            <small className="notice-studio-note">
              Na demonstração a MAVI não cria animações; dá para ver o exemplo e
              editar os textos das cenas.
            </small>
          )}

          {!!versions?.length && (
            <div className="notice-studio-versions">
              <strong>Versões</strong>
              <ul>
                {versions.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      className={v.id === selected ? "selected" : ""}
                      onClick={() => {
                        setSelected(v.id);
                        setEditing(null);
                        setRefs(null);
                      }}
                    >
                      <span>
                        v{v.version}{" "}
                        {v.status === "generating"
                          ? "· criando…"
                          : v.status === "failed"
                            ? "· falhou"
                            : v.source === "manual"
                              ? "· texto editado"
                              : "· MAVI"}
                      </span>
                      <small>
                        {v.request
                          ? `“${v.request.slice(0, 60)}${v.request.length > 60 ? "…" : ""}” · `
                          : ""}
                        {v.author_name}
                      </small>
                      {v.current && <Check size={14} aria-label="No aviso" />}
                    </button>
                  </li>
                ))}
              </ul>
              {versions.some((v) => v.current) && (
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => void use(null)}
                  disabled={busy}
                >
                  Tirar a animação do aviso
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function Thumb({
  api,
  id,
  name,
}: {
  api: NoticesApi;
  id: string;
  name: string;
}) {
  const urls = useAnimationImages([id], (ids) => api.attachmentUrls(ids, true));
  return urls[id] ? (
    <img src={urls[id]} alt={name} />
  ) : (
    <span className="notice-studio-thumb-wait" />
  );
}

/** O texto de cada cena, à mão (vira uma versão nova, sem gastar a MAVI). */
function SceneEditor({
  spec,
  onChange,
  onCancel,
  onSave,
  busy,
}: {
  spec: AnimationSpec;
  onChange: (spec: AnimationSpec) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const set = (i: number, patch: Partial<Scene>) =>
    onChange({
      ...spec,
      scenes: spec.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)),
    });
  return (
    <div className="notice-scenes">
      <ol>
        {spec.scenes.map((s, i) => (
          <li key={i}>
            <header>
              <strong>
                Cena {i + 1} · {LAYOUT_LABELS[s.layout]}
              </strong>
              <label className="notice-scene-seconds">
                <input
                  type="number"
                  min={1.5}
                  max={8}
                  step={0.5}
                  value={s.duration}
                  onChange={(e) =>
                    set(i, { duration: Number(e.target.value) || s.duration })
                  }
                  aria-label={`Duração da cena ${i + 1} (segundos)`}
                />
                s
              </label>
            </header>
            <input
              className="ui-input"
              value={s.heading ?? ""}
              maxLength={90}
              placeholder="Título da cena"
              aria-label={`Título da cena ${i + 1}`}
              onChange={(e) => set(i, { heading: e.target.value })}
            />
            {(s.text !== undefined ||
              s.layout === "text" ||
              s.layout === "title" ||
              s.layout === "closing") && (
              <textarea
                className="ui-input ui-textarea"
                rows={2}
                value={s.text ?? ""}
                maxLength={240}
                placeholder="Texto"
                aria-label={`Texto da cena ${i + 1}`}
                onChange={(e) => set(i, { text: e.target.value })}
              />
            )}
            {(s.bullets || s.layout === "steps") && (
              <textarea
                className="ui-input ui-textarea"
                rows={3}
                value={(s.bullets ?? []).join("\n")}
                placeholder="Um passo por linha"
                aria-label={`Passos da cena ${i + 1}`}
                onChange={(e) =>
                  set(i, { bullets: e.target.value.split("\n").slice(0, 5) })
                }
              />
            )}
            {s.stat && (
              <div className="notice-scene-row">
                <input
                  className="ui-input"
                  value={s.stat.value}
                  maxLength={16}
                  aria-label={`Número da cena ${i + 1}`}
                  onChange={(e) =>
                    set(i, { stat: { ...s.stat!, value: e.target.value } })
                  }
                />
                <input
                  className="ui-input"
                  value={s.stat.label}
                  maxLength={60}
                  aria-label={`Legenda do número da cena ${i + 1}`}
                  onChange={(e) =>
                    set(i, { stat: { ...s.stat!, label: e.target.value } })
                  }
                />
              </div>
            )}
            {(s.layout === "screen" || s.layout === "mockup") && (
              <input
                className="ui-input"
                value={s.callout ?? ""}
                maxLength={80}
                placeholder="Legenda perto do cursor"
                aria-label={`Legenda da cena ${i + 1}`}
                onChange={(e) => set(i, { callout: e.target.value })}
              />
            )}
            {s.ui?.map((u, k) => (
              <input
                key={k}
                className="ui-input"
                value={u.label}
                maxLength={60}
                aria-label={`Componente ${k + 1} da cena ${i + 1}`}
                onChange={(e) =>
                  set(i, {
                    ui: s.ui!.map((x, j) =>
                      j === k ? { ...x, label: e.target.value } : x,
                    ),
                  })
                }
              />
            ))}
          </li>
        ))}
      </ol>
      <div className="form-footer">
        <Button className="btn secondary" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
        <Button className="btn primary" onClick={onSave} loading={busy}>
          Salvar como nova versão
        </Button>
      </div>
    </div>
  );
}
