import { DateInput } from "./DateInput";
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type ComponentProps,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as Popover from "@radix-ui/react-popover";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import {
  Check,
  Minus,
  ChevronDown,
  ChevronUp,
  Type,
  Mail,
  LockKeyhole,
  CalendarDays,
  Hash,
  Search,
  type LucideIcon,
  ListFilter,
} from "lucide-react";

export function Input({
  className = "",
  icon,
  ...props
}: ComponentProps<"input"> & { icon?: LucideIcon }) {
  if (["date", "month", "datetime-local"].includes(props.type ?? ""))
    return <DateInput {...props} />;
  if (["file", "hidden", "checkbox", "radio"].includes(props.type ?? ""))
    return <input className={`ui-input ${className}`} {...props} />;
  const Icon =
    icon ??
    (props.type === "email"
      ? Mail
      : props.type === "password"
        ? LockKeyhole
        : ["date", "datetime-local", "month", "time"].includes(props.type ?? "")
          ? CalendarDays
          : props.type === "number"
            ? Hash
            : props.type === "search"
              ? Search
              : Type);
  return (
    <span className="input-control">
      <Icon size={17} aria-hidden="true" />
      <input className={`ui-input ${className}`} {...props} />
    </span>
  );
}
export function Textarea({
  className = "",
  ...props
}: ComponentProps<"textarea">) {
  return (
    <textarea className={`ui-input ui-textarea ${className}`} {...props} />
  );
}
export function Checkbox(props: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      {...props}
      className={`ui-checkbox ${props.className ?? ""}`}
    >
      <CheckboxPrimitive.Indicator>
        {props.checked === "indeterminate" ? (
          <Minus size={14} strokeWidth={3} />
        ) : (
          <Check size={14} strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

type OptionProps = { value: string; children: ReactNode; disabled?: boolean };
export function SelectOption(_props: OptionProps) {
  return null;
}
function optionsFrom(children: ReactNode): OptionProps[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child)) return [];
    return typeof child.props.value === "string"
      ? [child.props]
      : optionsFrom(child.props.children);
  });
}
type SelectProps = Omit<
  ComponentProps<"select">,
  "onChange" | "value" | "defaultValue" | "multiple" | "size"
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};
export function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  name,
  required,
  disabled,
  id,
  className = "",
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
}: SelectProps) {
  const options = optionsFrom(children);
  const [internal, setInternal] = useState(
    defaultValue ?? options[0]?.value ?? "",
  );
  const selected = value ?? internal;
  const placeholder =
    options.find((o) => !o.value)?.children ?? "Selecione uma opção";
  // Long lists (clients, projects, people…) get a search field instead of a
  // menu to scroll through.
  if (options.filter((o) => o.value).length > SEARCH_THRESHOLD)
    return (
      <SearchSelect
        options={options}
        selected={selected}
        placeholder={placeholder}
        onPick={(next) => {
          setInternal(next);
          onValueChange?.(next);
        }}
        name={name}
        required={required}
        disabled={disabled}
        id={id}
        className={className}
        ariaLabel={ariaLabel}
        labelledBy={labelledBy}
      />
    );
  return (
    <SelectPrimitive.Root
      name={name}
      required={required}
      disabled={disabled}
      value={selected}
      onValueChange={(next) => {
        const actual = next === "__mavi_empty__" ? "" : next;
        // Radix's hidden native select only knows options rendered while the
        // menu was open, so a value set from outside can bounce back as "".
        if (actual === "" && !options.some((o) => !o.value)) return;
        setInternal(actual);
        onValueChange?.(actual);
      }}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        className={`ui-select ${className}`}
      >
        <ListFilter
          size={16}
          className="select-leading-icon"
          aria-hidden="true"
        />
        <SelectPrimitive.Value placeholder={placeholder}>
          {options.find((option) => option.value === selected)?.children}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon>
          <ChevronDown size={16} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Content
        position="popper"
        sideOffset={6}
        className="ui-select-menu"
      >
        <SelectPrimitive.ScrollUpButton className="ui-select-scroll">
          <ChevronUp size={16} />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport>
          {options.map((option) => (
            <SelectPrimitive.Item
              key={option.value || "__mavi_empty__"}
              value={option.value || "__mavi_empty__"}
              disabled={option.disabled}
              className="ui-select-option"
            >
              <SelectPrimitive.ItemText>
                {option.children}
              </SelectPrimitive.ItemText>
              <SelectPrimitive.ItemIndicator>
                <Check size={16} />
              </SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>
          ))}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="ui-select-scroll">
          <ChevronDown size={16} />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Root>
  );
}

/** Above this many options, a Select searches as you type. */
export const SEARCH_THRESHOLD = 10;
/** Most options drawn at once; typing narrows the rest. */
const SEARCH_RENDER_CAP = 100;
const foldText = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
/** The visible text of an option label, for matching. */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node))
    return nodeText(node.props.children);
  return "";
}
/**
 * Options matching every word typed (in any order, ignoring accents and
 * case); the empty "all" option stays first while nothing is typed.
 */
export function searchOptions<T extends { value: string; children: ReactNode }>(
  options: T[],
  query: string,
) {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const text = foldText(nodeText(o.children));
    return words.every((w) => text.includes(w));
  });
}

function SearchSelect({
  options,
  selected,
  placeholder,
  onPick,
  name,
  required,
  disabled,
  id,
  className,
  ariaLabel,
  labelledBy,
}: {
  options: OptionProps[];
  selected: string;
  placeholder: ReactNode;
  onPick: (value: string) => void;
  name?: string;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  className: string;
  ariaLabel?: string;
  labelledBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const matches = useMemo(
    () => searchOptions(options, query),
    [options, query],
  );
  const shown = useMemo(() => {
    const first = matches.slice(0, SEARCH_RENDER_CAP);
    // A choice beyond the first page of options still shows (on top), so
    // opening the menu always reveals what is selected.
    const chosen = matches.find((o) => o.value === selected);
    return chosen && !first.includes(chosen)
      ? [chosen, ...first.slice(0, -1)]
      : first;
  }, [matches, selected]);
  const current = options.find((o) => o.value === selected);
  // Opening starts on the chosen option; typing starts on the first match.
  useEffect(() => {
    if (!open) return;
    const i = query ? 0 : shown.findIndex((o) => o.value === selected);
    setActive(Math.max(0, i));
  }, [open, query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  function pick(option: OptionProps | undefined) {
    if (!option || option.disabled) return;
    onPick(option.value);
    setOpen(false);
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    const step = (from: number, dir: 1 | -1) => {
      for (let i = from + dir; i >= 0 && i < shown.length; i += dir)
        if (!shown[i].disabled) return i;
      return from;
    };
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => step(i, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => step(i, -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? step(-1, 1) : step(shown.length, -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Tab") setOpen(false);
  }
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-label={ariaLabel}
          aria-labelledby={labelledBy}
          disabled={disabled}
          className={`ui-select ui-search-select ${className}`}
          data-placeholder={current?.value ? undefined : ""}
        >
          <ListFilter
            size={16}
            className="select-leading-icon"
            aria-hidden="true"
          />
          <span className="ui-search-select-value">
            {current ? current.children : placeholder}
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      {/* Keeps form submission and "required" working like a native select. */}
      {name !== undefined && (
        <input
          className="ui-search-select-native"
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          value={selected}
          required={required}
          disabled={disabled}
          onChange={() => {}}
          onFocus={() => trigger.current?.focus()}
        />
      )}
      <Popover.Content
        className="ui-select-menu ui-search-menu"
        sideOffset={6}
        align="start"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement)
            .querySelector<HTMLInputElement>("input")
            ?.focus();
        }}
      >
        <span className="ui-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            role="searchbox"
            aria-label="Buscar opção"
            aria-controls={listId}
            aria-activedescendant={
              shown[active] ? `${listId}-${active}` : undefined
            }
            placeholder="Digite para buscar…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
          />
        </span>
        <div
          ref={list}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="ui-search-options"
        >
          {shown.map((o, i) => (
            <div
              key={o.value || "__mavi_empty__"}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === selected}
              aria-disabled={o.disabled || undefined}
              data-highlighted={i === active ? "" : undefined}
              data-state={o.value === selected ? "checked" : undefined}
              data-disabled={o.disabled ? "" : undefined}
              className="ui-select-option"
              onMouseMove={() => i !== active && setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              <span>{o.children}</span>
              {o.value === selected && <Check size={16} />}
            </div>
          ))}
          {!matches.length && (
            <p className="ui-search-empty">Nada encontrado para “{query}”.</p>
          )}
        </div>
        {matches.length > shown.length && (
          <p className="ui-search-more">
            Mostrando {SEARCH_RENDER_CAP} de{" "}
            {matches.length.toLocaleString("pt-BR")}. Digite para refinar.
          </p>
        )}
      </Popover.Content>
    </Popover.Root>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton ${className}`} />;
}
export function Loading({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`skeleton-layout ${compact ? "compact" : ""}`}
      role="status"
      aria-label="Carregando conteúdo"
      aria-busy="true"
    >
      <span className="sr-only">Carregando conteúdo…</span>
      {!compact && (
        <>
          <Skeleton className="skeleton-heading" />
          <div className="skeleton-cards">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="skeleton-card" />
            ))}
          </div>
        </>
      )}
      <div className="skeleton-rows">
        {Array.from({ length: compact ? 3 : 5 }, (_, i) => (
          <div className="skeleton-row" key={i}>
            <Skeleton className="skeleton-avatar" />
            <div>
              <Skeleton className="skeleton-title" />
              <Skeleton className="skeleton-description" />
            </div>
            <Skeleton className="skeleton-badge" />
          </div>
        ))}
      </div>
    </div>
  );
}
export function Button({
  loading = false,
  children,
  className = "",
  disabled,
  ...props
}: ComponentProps<"button"> & { loading?: boolean }) {
  return (
    <button
      {...props}
      className={`${className} ${loading ? "ui-button-loading" : ""}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <>
          <span className="ui-button-placeholder" aria-hidden="true">
            {children}
          </span>
          <Skeleton className="skeleton-button" />
          <span className="sr-only">Processando…</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}
