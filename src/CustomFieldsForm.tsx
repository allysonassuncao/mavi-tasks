import { useState } from "react";
import { ExternalLink, ListChecks, Pencil } from "lucide-react";
import { Button, Checkbox, Input, Select, SelectOption, Textarea } from "./ui";
import {
  byTemplate,
  customFieldsError,
  customKey,
  formatCustomValue,
  isEmpty,
  valuesOf,
} from "./templateFields";
import type { TaskCustomField } from "./types";

type Values = Record<string, unknown>;

/**
 * The template fields to fill in, grouped under each template's name.
 * Required ones are marked; the database checks them again on save.
 */
export function CustomFieldsForm({
  fields,
  values,
  onChange,
  disabled = false,
}: {
  fields: TaskCustomField[];
  values: Values;
  onChange: (next: Values) => void;
  disabled?: boolean;
}) {
  if (!fields.length) return null;
  const set = (f: TaskCustomField, value: unknown) =>
    onChange({ ...values, [customKey(f)]: value });
  return (
    <div className="custom-fields">
      {byTemplate(fields).map((group) => (
        <fieldset className="custom-group" key={group.id} disabled={disabled}>
          <legend>
            <ListChecks size={15} aria-hidden="true" /> {group.name}
          </legend>
          {group.fields.map((f) => {
            const key = customKey(f);
            const value = values[key];
            const label = (
              <span className="custom-label">
                {f.label}
                {f.required && (
                  <span className="custom-required" aria-label="obrigatório">
                    *
                  </span>
                )}
              </span>
            );
            const help = f.help ? (
              <small className="custom-help">{f.help}</small>
            ) : null;
            if (f.type === "checkbox")
              return (
                <label className="custom-check" key={key}>
                  <Checkbox
                    checked={value === true}
                    onCheckedChange={(v) => set(f, v === true)}
                  />
                  <span>
                    {label}
                    {help}
                  </span>
                </label>
              );
            if (f.type === "multiselect") {
              const chosen = Array.isArray(value) ? (value as string[]) : [];
              return (
                <div
                  className="custom-multi"
                  key={key}
                  role="group"
                  aria-label={f.label}
                >
                  {label}
                  <div className="custom-options">
                    {(f.options ?? []).map((o) => (
                      <label key={o} className="custom-option">
                        <Checkbox
                          checked={chosen.includes(o)}
                          onCheckedChange={(v) =>
                            set(
                              f,
                              v === true
                                ? [...chosen, o]
                                : chosen.filter((x) => x !== o),
                            )
                          }
                        />
                        {o}
                      </label>
                    ))}
                  </div>
                  {help}
                </div>
              );
            }
            return (
              <label key={key}>
                {label}
                {f.type === "textarea" ? (
                  <Textarea
                    rows={3}
                    value={String(value ?? "")}
                    maxLength={5000}
                    required={f.required}
                    onChange={(e) => set(f, e.target.value)}
                  />
                ) : f.type === "select" ? (
                  <Select
                    value={String(value ?? "")}
                    onValueChange={(v) => set(f, v || null)}
                  >
                    <SelectOption value="">Selecione</SelectOption>
                    {(f.options ?? []).map((o) => (
                      <SelectOption key={o} value={o}>
                        {o}
                      </SelectOption>
                    ))}
                  </Select>
                ) : (
                  <Input
                    type={
                      f.type === "number"
                        ? "number"
                        : f.type === "date"
                          ? "date"
                          : f.type === "url"
                            ? "url"
                            : "text"
                    }
                    inputMode={f.type === "number" ? "decimal" : undefined}
                    step={f.type === "number" ? "any" : undefined}
                    placeholder={f.type === "url" ? "https://" : undefined}
                    maxLength={
                      f.type === "url"
                        ? 2000
                        : f.type === "text"
                          ? 500
                          : undefined
                    }
                    required={f.required}
                    value={String(value ?? "")}
                    onChange={(e) => set(f, e.target.value)}
                  />
                )}
                {help}
              </label>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}

/** The fields as the task carries them, filled in or "—". */
export function CustomFieldsView({ fields }: { fields: TaskCustomField[] }) {
  if (!fields.length) return null;
  return (
    <div className="custom-view">
      {byTemplate(fields).map((group) => (
        <section key={group.id} aria-label={group.name}>
          <h3>
            <ListChecks size={15} aria-hidden="true" /> {group.name}
          </h3>
          <dl>
            {group.fields.map((f) => {
              const shown = formatCustomValue(f, f.value);
              return (
                <div key={customKey(f)}>
                  <dt>{f.label}</dt>
                  <dd className={isEmpty(f.value) ? "custom-empty" : ""}>
                    {!shown ? (
                      "—"
                    ) : f.type === "url" ? (
                      <a href={shown} target="_blank" rel="noopener noreferrer">
                        {shown} <ExternalLink size={12} aria-hidden="true" />
                      </a>
                    ) : (
                      shown
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * The task's template fields: shown to everyone who sees the task, edited
 * by whoever may edit it (the database enforces both, and the required
 * fields again). Editing them leaves status and approvals as they are.
 */
export function TaskCustomFieldsPanel({
  task,
  canEdit,
  busy,
  onSave,
}: {
  task: { version: number; custom_fields?: TaskCustomField[] };
  canEdit: boolean;
  busy: boolean;
  onSave: (values: Values, version: number) => Promise<unknown>;
}) {
  const fields = task.custom_fields ?? [];
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  if (!fields.length) return null;
  async function save() {
    const problem = customFieldsError(fields, values);
    if (problem) return setError(problem);
    setSaving(true);
    setError("");
    try {
      await onSave(values, task.version);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="task-custom" aria-label="Informações do template">
      {editing ? (
        <>
          <CustomFieldsForm
            fields={fields}
            values={values}
            onChange={setValues}
            disabled={saving}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-footer">
            <Button
              className="btn secondary"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setError("");
              }}
            >
              Cancelar
            </Button>
            <Button
              className="btn primary"
              loading={saving}
              disabled={busy}
              onClick={() => void save()}
            >
              Salvar campos
            </Button>
          </div>
        </>
      ) : (
        <>
          <CustomFieldsView fields={fields} />
          {canEdit && (
            <Button
              className="text-btn task-custom-edit"
              onClick={() => {
                setValues(valuesOf(fields));
                setEditing(true);
              }}
            >
              <Pencil size={13} /> Editar campos
            </Button>
          )}
        </>
      )}
    </section>
  );
}
