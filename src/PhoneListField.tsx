import { useId } from "react";
import { Phone, Plus, Trash2 } from "lucide-react";
import { Button, Input } from "./ui";
import { phoneDigits, phoneLabel } from "./temperature";

/** Até quantos números uma pessoa guarda (set_member_phones). */
const MAX_PHONES = 10;

/** Os números do banco como aparecem no campo; sem nenhum, uma linha vazia. */
export function phoneRows(saved: string[]) {
  return saved.length ? saved.map(phoneLabel) : [""];
}

/** Se o que está no campo difere do que o banco guarda. */
export function phonesChanged(rows: string[], saved: string[]) {
  return rows.map(phoneDigits).filter(Boolean).join() !== saved.join();
}

/**
 * Os celulares com WhatsApp de uma pessoa (Meu perfil e Editar usuário): nos
 * grupos dos clientes, as mensagens de qualquer um deles são do time.
 */
export function PhoneListField({
  phones,
  onChange,
  disabled = false,
  hint,
}: {
  phones: string[];
  onChange: (phones: string[]) => void;
  disabled?: boolean;
  hint: string;
}) {
  const title = useId();
  const set = (i: number, v: string) =>
    onChange(phones.map((p, n) => (n === i ? v : p)));
  const remove = (i: number) => {
    const next = phones.filter((_, n) => n !== i);
    onChange(next.length ? next : [""]);
  };
  return (
    <div className="phone-list" role="group" aria-labelledby={title}>
      <span className="phone-list-title" id={title}>
        Celulares com WhatsApp
      </span>
      {phones.map((p, i) => (
        <div className="phone-list-row" key={i}>
          <label>
            <span className="sr-only">Celular {i + 1}</span>
            <Input
              type="tel"
              icon={Phone}
              value={p}
              onChange={(e) => set(i, e.target.value)}
              placeholder="(11) 98765-4321"
              autoComplete={i === 0 ? "tel" : "off"}
              maxLength={24}
              disabled={disabled}
            />
          </label>
          {(phones.length > 1 || p) && (
            <Button
              type="button"
              className="icon-btn"
              aria-label={`Remover o celular ${i + 1}`}
              title="Remover este número"
              disabled={disabled}
              onClick={() => remove(i)}
            >
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      ))}
      {!disabled && phones.length < MAX_PHONES && (
        <button
          type="button"
          className="text-btn"
          onClick={() => onChange([...phones, ""])}
        >
          <Plus size={14} /> Adicionar outro número
        </button>
      )}
      <small>{hint}</small>
    </div>
  );
}
