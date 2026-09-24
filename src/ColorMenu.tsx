import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Ban, Check, ChevronDown, type LucideIcon } from "lucide-react";

export type Swatch = { name: string; color: string };

/** Text colors: readable on the white editor and on the task's background. */
export const TEXT_COLORS: Swatch[] = [
  { name: "Cinza", color: "#6b7280" },
  { name: "Vermelho", color: "#c0392b" },
  { name: "Laranja", color: "#c2410c" },
  { name: "Amarelo escuro", color: "#a16207" },
  { name: "Verde", color: "#2f7d32" },
  { name: "Azul-petróleo", color: "#0f766e" },
  { name: "Azul", color: "#1d4ed8" },
  { name: "Roxo", color: "#6d28d9" },
  { name: "Rosa", color: "#be185d" },
];
/** Highlight colors: light, so any text color stays legible on them. */
export const HIGHLIGHT_COLORS: Swatch[] = [
  { name: "Amarelo", color: "#fef08a" },
  { name: "Verde", color: "#bbf7d0" },
  { name: "Azul", color: "#bfdbfe" },
  { name: "Roxo", color: "#e9d5ff" },
  { name: "Rosa", color: "#fbcfe8" },
  { name: "Laranja", color: "#fed7aa" },
  { name: "Vermelho", color: "#fecaca" },
  { name: "Cinza", color: "#e5e7eb" },
];

/** Product colors: mid tones, visible as a dot and as a label on white. */
export const PRODUCT_COLORS: Swatch[] = [
  { name: "Azul", color: "#719edc" },
  { name: "Azul-petróleo", color: "#4f9e98" },
  { name: "Verde", color: "#6fae6a" },
  { name: "Oliva", color: "#9eb975" },
  { name: "Amarelo", color: "#d9b44a" },
  { name: "Laranja", color: "#d09b61" },
  { name: "Coral", color: "#e07b62" },
  { name: "Vermelho", color: "#cf5f6a" },
  { name: "Rosa", color: "#d27aa8" },
  { name: "Roxo", color: "#aa87d2" },
  { name: "Lilás", color: "#8576cf" },
  { name: "Cinza", color: "#8e979b" },
];

/** A color chosen in a form: a palette plus any other color. */
export function ColorField({
  legend,
  swatches,
  value,
  onChange,
}: {
  legend: string;
  swatches: Swatch[];
  value: string;
  onChange: (color: string) => void;
}) {
  const current = value.toLowerCase();
  return (
    <fieldset className="color-field">
      <legend>{legend}</legend>
      <div className="color-field-grid" role="group" aria-label={legend}>
        {swatches.map((s) => (
          <button
            key={s.color}
            type="button"
            className="color-swatch"
            style={{ background: s.color }}
            aria-label={s.name}
            title={s.name}
            aria-pressed={current === s.color}
            onClick={() => onChange(s.color)}
          >
            {current === s.color && <Check size={13} aria-hidden="true" />}
          </button>
        ))}
        <label className="color-custom" title="Escolher outra cor">
          <input
            type="color"
            aria-label={`${legend}: outra cor`}
            value={current}
            onChange={(e) => onChange(e.target.value.toLowerCase())}
          />
          Outra cor
        </label>
      </div>
    </fieldset>
  );
}

/**
 * A toolbar button that opens a color palette (plus a custom color and
 * "remove"). The bar under the icon shows the color at the cursor.
 */
export function ColorMenu({
  label,
  icon: Icon,
  swatches,
  current,
  disabled,
  onPick,
  onClear,
  clearLabel,
}: {
  label: string;
  icon: LucideIcon;
  swatches: Swatch[];
  /** The color where the cursor is, if any. */
  current?: string | null;
  disabled?: boolean;
  onPick: (color: string) => void;
  onClear: () => void;
  clearLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (color: string) => {
    onPick(color);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="icon-btn color-menu-trigger"
          aria-label={label}
          title={label}
          disabled={disabled}
          // Keep the text selection: the menu acts on it.
          onMouseDown={(e) => e.preventDefault()}
        >
          <span className="color-menu-icon">
            <Icon size={16} />
            <i style={{ background: current ?? "transparent" }} />
          </span>
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      {/* Not portaled: it must work inside the task and form dialogs. */}
      <Popover.Content
        className="color-menu"
        sideOffset={6}
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <span className="color-menu-title">{label}</span>
        <div className="color-menu-grid" role="group" aria-label={label}>
          {swatches.map((s) => (
            <button
              key={s.color}
              type="button"
              className="color-swatch"
              style={{ background: s.color }}
              aria-label={s.name}
              title={s.name}
              aria-pressed={current === s.color}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s.color)}
            >
              {current === s.color && <Check size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
        <div className="color-menu-actions">
          <label className="color-custom" title="Escolher outra cor">
            <input
              type="color"
              aria-label={`${label}: outra cor`}
              value={current ?? swatches[0].color}
              onChange={(e) => onPick(e.target.value)}
            />
            Outra cor
          </label>
          <button
            type="button"
            className="color-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          >
            <Ban size={13} aria-hidden="true" /> {clearLabel}
          </button>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
