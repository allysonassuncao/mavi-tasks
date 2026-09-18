import {
  Children,
  isValidElement,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Type,
  Mail,
  LockKeyhole,
  CalendarDays,
  Hash,
  Search,
  type LucideIcon,
} from "lucide-react";

export function Input({
  className = "",
  icon,
  ...props
}: ComponentProps<"input"> & { icon?: LucideIcon }) {
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
        <Check size={14} strokeWidth={3} />
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
    return child.type === SelectOption
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
  return (
    <SelectPrimitive.Root
      name={name}
      required={required}
      disabled={disabled}
      value={selected}
      onValueChange={(next) => {
        const actual = next === "__mavi_empty__" ? "" : next;
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
        <SelectPrimitive.Value placeholder={placeholder} />
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
