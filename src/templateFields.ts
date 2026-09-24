import { dateLabel, fold } from "./domain";
import type {
  CustomFieldType,
  CustomValue,
  Snapshot,
  TaskCustomField,
  TemplateField,
} from "./types";

/** Field types, as offered in the template builder. */
export const fieldTypes: { type: CustomFieldType; label: string }[] = [
  { type: "text", label: "Texto curto" },
  { type: "textarea", label: "Texto longo" },
  { type: "select", label: "Lista (uma opção)" },
  { type: "multiselect", label: "Lista (várias opções)" },
  { type: "number", label: "Número" },
  { type: "date", label: "Data" },
  { type: "url", label: "Link" },
  { type: "checkbox", label: "Sim / não" },
];
export const hasOptions = (type: CustomFieldType) =>
  type === "select" || type === "multiselect";

/** How a value is addressed when creating or editing a task. */
export const customKey = (f: Pick<TaskCustomField, "template_id" | "id">) =>
  `${f.template_id}.${f.id}`;

/**
 * The fields a new task gets for this contract and assignee — mirrors
 * mavi_private.template_fields_for (the database has the final word).
 */
export function templateFieldsFor(
  data: Pick<Snapshot, "taskTemplates" | "contracts" | "teamMembers">,
  contractId: string,
  assigneeId: string,
): TaskCustomField[] {
  const product = data.contracts.find((k) => k.id === contractId)?.product_id;
  const teams = new Set(
    data.teamMembers
      .filter((tm) => tm.user_id === assigneeId)
      .map((tm) => tm.team_id),
  );
  return (data.taskTemplates ?? [])
    .filter(
      (t) =>
        t.active &&
        (!t.product_id || t.product_id === product) &&
        (!t.team_id || teams.has(t.team_id)),
    )
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id),
    )
    .flatMap((t) =>
      t.fields.map((f) => ({
        ...f,
        template_id: t.id,
        template_name: t.name,
      })),
    );
}

/** Fields grouped under their template's name, in order. */
export function byTemplate<
  T extends Pick<TaskCustomField, "template_id" | "template_name">,
>(fields: T[]) {
  const groups: { id: string; name: string; fields: T[] }[] = [];
  for (const f of fields) {
    const last = groups.at(-1);
    if (last?.id === f.template_id) last.fields.push(f);
    else groups.push({ id: f.template_id, name: f.template_name, fields: [f] });
  }
  return groups;
}

export const isEmpty = (v: unknown) =>
  v == null ||
  v === false ||
  (typeof v === "string" && !v.trim()) ||
  (Array.isArray(v) && !v.length);

/**
 * The first problem with the values, in the same words as the database —
 * so the form can say it before sending — or "" when all is fine.
 */
export function customFieldsError(
  fields: TaskCustomField[],
  values: Record<string, unknown>,
) {
  for (const f of fields) {
    const v = values[customKey(f)];
    if (isEmpty(v)) {
      if (f.required) return `Preencha o campo obrigatório "${f.label}"`;
      continue;
    }
    const s = typeof v === "string" ? v.trim() : "";
    if (f.type === "url" && !/^https?:\/\/\S+$/i.test(s))
      return `Informe um link (http:// ou https://) em "${f.label}"`;
    if (f.type === "number" && !/^-?\d+([.,]\d+)?$/.test(String(v)))
      return `Informe um número em "${f.label}"`;
  }
  return "";
}

/** What the task view shows for a value. */
export function formatCustomValue(
  f: TemplateField,
  v: CustomValue | undefined,
) {
  if (isEmpty(v)) return "";
  switch (f.type) {
    case "checkbox":
      return "Sim";
    case "date":
      return dateLabel(String(v));
    case "number":
      return Number(v).toLocaleString("pt-BR");
    case "multiselect":
      return (v as string[]).join(", ");
    default:
      return String(v);
  }
}

/** A task's current values, keyed as the edit form expects. */
export const valuesOf = (fields: TaskCustomField[]) =>
  Object.fromEntries(fields.map((f) => [customKey(f), f.value ?? null]));

/** A new, unique field id derived from its label ("Link do briefing" → "link_do_briefing"). */
export function fieldIdFrom(label: string, taken: string[]) {
  const base =
    fold(label)
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "campo";
  let id = base,
    n = 2;
  while (taken.includes(id)) id = `${base}_${n++}`;
  return id;
}
