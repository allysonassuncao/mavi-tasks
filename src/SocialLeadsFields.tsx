import { useEffect, useRef, useState, type DragEvent } from "react";
import {
  FileAudio,
  FileVideo,
  Paperclip,
  Phone,
  Plus,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { Button, Input } from "./ui";
import {
  currencies,
  currencySymbol,
  formatMoney,
  formatPhoneBR,
  formatUsd,
  moneyFromDigits,
  parseColors,
  parseMoney,
  phoneComplete,
  serializeColors,
  type BrandColor,
  type CurrencyCode,
  type MediaFile,
} from "./social-leads";

/**
 * The briefing's special fields: phone with the Brazilian mobile mask,
 * money with a currency, several brand colours (and the palette the AI read
 * from the site), and files kept in the client's Drive. Each one still
 * stores plain text in the briefing, so the AI and the importer read them as
 * before.
 */

export function PhoneInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const shown = formatPhoneBR(value);
  const wrong = touched && !!shown && !phoneComplete(shown);
  return (
    <>
      <Input
        icon={Phone}
        type="text"
        inputMode="tel"
        autoComplete="tel-national"
        placeholder="(11) 91234-5678"
        value={shown}
        disabled={disabled}
        aria-invalid={wrong || undefined}
        onBlur={() => setTouched(true)}
        onChange={(e) => onChange(formatPhoneBR(e.target.value))}
      />
      {wrong && (
        <em className="sl-field-hint warn">
          Celular com DDD e o 9 na frente: (11) 91234-5678.
        </em>
      )}
    </>
  );
}

export function MoneyInput({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  label: string;
}) {
  const parsed = parseMoney(value);
  // The currency picked before typing an amount is remembered here.
  const [code, setCode] = useState<CurrencyCode>(parsed.code);
  useEffect(() => {
    if (parsed.amount !== null || parsed.legacy) setCode(parsed.code);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const amount = parsed.amount;
  const symbol = currencySymbol(code);
  const digitsShown =
    amount === null ? "" : formatMoney(amount, code).replace(symbol, "").trim();
  return (
    <>
      <span className={`sl-money${disabled ? " disabled" : ""}`}>
        <select
          aria-label={`Moeda de ${label}`}
          value={code}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value as CurrencyCode;
            setCode(next);
            if (amount !== null) onChange(formatMoney(amount, next));
          }}
        >
          {currencies.map((c) => (
            <option key={c.code} value={c.code}>
              {currencySymbol(c.code)} · {c.label}
            </option>
          ))}
        </select>
        <input
          className="ui-input"
          inputMode="numeric"
          aria-label={label}
          placeholder={formatMoney(0, code).replace(symbol, "").trim()}
          value={digitsShown}
          disabled={disabled}
          onChange={(e) => {
            const next = moneyFromDigits(e.target.value, code);
            onChange(next === null ? "" : formatMoney(next, code));
          }}
        />
      </span>
      {parsed.legacy && (
        <em className="sl-field-hint">
          Valor anterior: “{parsed.legacy}”. Digite um valor para trocar.
        </em>
      )}
    </>
  );
}

export type ColorSearch = {
  state: "idle" | "searching" | "done" | "error";
  found?: { hex: string; name: string }[];
  note?: string;
  error?: string;
  cost?: number;
  /** The colours were filled in by the search (can be undone). */
  applied?: string | null;
};
export function ColorsInput({
  value,
  onChange,
  disabled,
  canSearch,
  search,
  onSearch,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  /** There is a site or Instagram to read. */
  canSearch: boolean;
  search: ColorSearch;
  onSearch: () => void;
}) {
  const list = parseColors(value);
  const set = (next: BrandColor[]) => onChange(serializeColors(next));
  const add = (c: BrandColor) => set([...list, c]);
  const has = (hex: string) => list.some((c) => c.hex === hex);
  return (
    <div className="sl-colors">
      <ul>
        {list.map((c, i) => (
          <li key={i}>
            <label
              className={`sl-swatch${c.hex ? "" : " empty"}`}
              style={c.hex ? { background: c.hex } : undefined}
              title={c.hex ? `Trocar ${c.hex}` : "Escolher a cor"}
            >
              <input
                type="color"
                value={c.hex ?? "#8fbf5a"}
                disabled={disabled}
                aria-label={`Cor ${i + 1}`}
                onChange={(e) =>
                  set(
                    list.map((x, j) =>
                      j === i ? { ...x, hex: e.target.value } : x,
                    ),
                  )
                }
              />
              {!c.hex && "?"}
            </label>
            <input
              className="sl-color-name"
              value={c.name}
              placeholder={c.hex ?? "Nome da cor"}
              disabled={disabled}
              aria-label={`Nome da cor ${i + 1}`}
              onChange={(e) =>
                set(
                  list.map((x, j) =>
                    j === i ? { ...x, name: e.target.value } : x,
                  ),
                )
              }
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remover ${c.name || c.hex || "cor"}`}
              disabled={disabled}
              onClick={() => set(list.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ul>
      <div className="sl-colors-actions">
        <Button
          type="button"
          className="btn secondary"
          disabled={disabled}
          onClick={() => add({ hex: "#8fbf5a", name: "" })}
        >
          <Plus size={15} /> Adicionar cor
        </Button>
        {canSearch && (
          <Button
            type="button"
            className="btn secondary"
            disabled={disabled}
            loading={search.state === "searching"}
            onClick={onSearch}
            title="A IA lê as cores do site e do Instagram informados"
          >
            <Sparkles size={15} /> Buscar no site/Instagram
          </Button>
        )}
      </div>
      {search.state === "searching" && (
        <p className="sl-ai-note" role="status">
          <Sparkles size={14} /> A IA está lendo o site e o Instagram para achar
          as cores…
        </p>
      )}
      {search.state === "error" && (
        <p className="sl-alert warn">{search.error}</p>
      )}
      {search.state === "done" && search.found && (
        <div className="sl-ai-note" role="status">
          <Sparkles size={14} />
          <div>
            {search.applied !== undefined && search.applied !== null ? (
              <span>
                Cores preenchidas pela IA. {search.note}{" "}
                <button
                  type="button"
                  className="sl-link"
                  onClick={() => onChange(search.applied ?? "")}
                >
                  Desfazer
                </button>
              </span>
            ) : (
              <>
                <span>{search.note}</span>
                <span className="sl-found">
                  {search.found.map((c) => (
                    <button
                      key={c.hex}
                      type="button"
                      disabled={disabled || has(c.hex)}
                      onClick={() => add(c)}
                      title={
                        has(c.hex) ? "Já está na lista" : `Adicionar ${c.name}`
                      }
                    >
                      <i style={{ background: c.hex }} />
                      {c.name}
                      {!has(c.hex) && <Plus size={12} />}
                    </button>
                  ))}
                </span>
              </>
            )}
            {!!search.cost && (
              <small>Custo da IA: {formatUsd(search.cost)}</small>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ files
export type Uploading = { key: string; name: string; progress: number };
export function MediaInput({
  files,
  uploading,
  accept,
  what,
  disabled,
  onAdd,
  onRemove,
  urlOf,
}: {
  files: MediaFile[];
  uploading: Uploading[];
  accept: string;
  /** "imagem, vídeo ou áudio". */
  what: string;
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (file: MediaFile) => void;
  urlOf: (file: MediaFile) => Promise<string>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (!disabled && e.dataTransfer.files.length)
      onAdd([...e.dataTransfer.files]);
  };
  return (
    <div
      className={`sl-media${over ? " over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
    >
      {(files.length > 0 || uploading.length > 0) && (
        <ul>
          {files.map((f) => (
            <MediaThumb
              key={f.id}
              file={f}
              disabled={disabled}
              onRemove={onRemove}
              urlOf={urlOf}
            />
          ))}
          {uploading.map((u) => (
            <li key={u.key} className="sl-thumb uploading">
              <span className="sl-thumb-box">
                <Upload size={18} />
                <i style={{ width: `${Math.round(u.progress * 100)}%` }} />
              </span>
              <small title={u.name}>{u.name}</small>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="sl-media-add"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Paperclip size={15} />
        <span>
          Enviar {what}{" "}
          <small>ou arraste para cá · vai para o Drive do cliente</small>
        </span>
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept}
        onChange={(e) => {
          if (e.target.files?.length) onAdd([...e.target.files]);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function MediaThumb({
  file,
  disabled,
  onRemove,
  urlOf,
}: {
  file: MediaFile;
  disabled?: boolean;
  onRemove: (file: MediaFile) => void;
  urlOf: (file: MediaFile) => Promise<string>;
}) {
  const [url, setUrl] = useState("");
  const [confirm, setConfirm] = useState(false);
  const kind = file.type.split("/")[0];
  useEffect(() => {
    let alive = true;
    urlOf(file)
      .then((u) => alive && setUrl(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [file.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <li className="sl-thumb">
      <a
        className="sl-thumb-box"
        href={url || undefined}
        target="_blank"
        rel="noreferrer"
        title={`Abrir ${file.name}`}
      >
        {kind === "image" && url ? (
          <img src={url} alt="" loading="lazy" />
        ) : kind === "video" && url ? (
          <video src={url} muted preload="metadata" />
        ) : kind === "audio" ? (
          <FileAudio size={22} />
        ) : kind === "video" ? (
          <FileVideo size={22} />
        ) : (
          <Paperclip size={20} />
        )}
      </a>
      {kind === "audio" && url && <audio src={url} controls preload="none" />}
      <small title={file.name}>{file.name}</small>
      {!disabled &&
        (confirm ? (
          <span className="sl-thumb-confirm">
            Remover?
            <button type="button" onClick={() => onRemove(file)}>
              Sim
            </button>
            <button type="button" onClick={() => setConfirm(false)}>
              Não
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="sl-thumb-remove"
            aria-label={`Remover ${file.name}`}
            onClick={() => setConfirm(true)}
          >
            <Trash2 size={13} />
          </button>
        ))}
    </li>
  );
}
