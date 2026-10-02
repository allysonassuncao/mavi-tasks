import { Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Check, Copy, Eye, EyeOff, KeyRound } from "lucide-react";
import { Modal } from "./components";
import { Button, Input } from "./ui";
import { createNoteSecret, openNoteSecret } from "./client-notes";
import "./client-notes.css";

/** A anotação aberta (para registrar em qual delas o valor foi visto). */
export type SecretContext = MutableRefObject<{ note: string | null }>;

/** Quanto tempo o valor fica à vista depois de "Mostrar". */
const REVEAL_MS = 30_000;

/**
 * Um trecho secreto (senha, token): na tela só o nome e ••••••. Mostrar e
 * Copiar pedem o valor ao servidor, que confere o acesso e registra quem abriu.
 */
export function NoteSecretChip({
  secretId,
  label,
  note,
}: {
  secretId: string;
  label: string;
  note: string | null;
}) {
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState<"view" | "copy" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function open(how: "view" | "copy") {
    if (how === "view" && value !== null) {
      setValue(null);
      return;
    }
    setBusy(how);
    setError("");
    try {
      const r = await openNoteSecret(secretId, note, how);
      if (how === "copy") {
        await navigator.clipboard.writeText(r.value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      } else {
        setValue(r.value);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setValue(null), REVEAL_MS);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <span
      className={`note-secret${value !== null ? " revealed" : ""}`}
      title={error || `Secreto: ${label}`}
      data-error={error ? "true" : undefined}
    >
      <KeyRound size={13} aria-hidden="true" />
      <span className="note-secret-label">{label || "Secreto"}</span>
      <span className="note-secret-value" aria-live="polite">
        {value !== null ? value : "••••••"}
      </span>
      <button
        type="button"
        className="note-secret-btn"
        aria-label={value !== null ? `Ocultar ${label}` : `Mostrar ${label}`}
        title={value !== null ? "Ocultar" : "Mostrar (fica registrado)"}
        disabled={!!busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void open("view")}
      >
        {value !== null ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>
      <button
        type="button"
        className="note-secret-btn"
        aria-label={`Copiar ${label}`}
        title={copied ? "Copiado" : "Copiar (fica registrado)"}
        disabled={!!busy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void open("copy")}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      {error && (
        <span className="sr-only" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function SecretNodeView({ node, extension }: NodeViewProps) {
  const ctx = (extension.options as { context: SecretContext }).context;
  return (
    <NodeViewWrapper as="span" className="note-secret-node">
      <NoteSecretChip
        secretId={node.attrs.secretId}
        label={node.attrs.label}
        note={ctx.current.note}
      />
    </NodeViewWrapper>
  );
}

/** O nó do editor: só a referência e o nome (o valor nunca entra no texto). */
export function noteSecretExtension(context: SecretContext) {
  return Node.create<{ context: SecretContext }>({
    name: "noteSecret",
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    addOptions() {
      return { context };
    },
    addAttributes() {
      return { secretId: { default: "" }, label: { default: "" } };
    },
    // Colar HTML nunca cria um secreto: só o botão "Secreto".
    parseHTML() {
      return [];
    },
    renderHTML({ HTMLAttributes }) {
      return ["span", { "data-secret": "" }, `[${HTMLAttributes.label}]`];
    },
    renderText({ node }) {
      return `[secreto: ${node.attrs.label}]`;
    },
    addNodeView() {
      return ReactNodeViewRenderer(SecretNodeView, { as: "span" });
    },
  });
}

/** "Secreto" no editor: nome + valor; o servidor cifra e devolve a referência. */
export function NoteSecretForm({
  company,
  client,
  onClose,
  onCreated,
}: {
  company: string;
  client: string;
  onClose: () => void;
  onCreated: (secret: { id: string; label: string }) => void;
}) {
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try {
      onCreated(await createNoteSecret(company, client, label, value));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Adicionar secreto" onClose={onClose} busy={busy}>
      {/* Sem <form>: o editor pode estar dentro de outro formulário. */}
      <div
        className="entity-form note-secret-form"
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          e.stopPropagation();
          if (!busy && label.trim() && value) void submit();
        }}
      >
        <p className="muted">
          O valor fica criptografado e aparece como ••••••. Quem clicar em
          Mostrar ou Copiar fica registrado. A MAVI sabe que o secreto existe,
          mas nunca vê nem repete o valor.
        </p>
        <label>
          Nome
          <Input
            value={label}
            maxLength={120}
            placeholder="Ex.: Senha do Meta"
            autoFocus
            disabled={busy}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          Valor
          <span className="note-secret-input">
            <Input
              type={show ? "text" : "password"}
              value={value}
              maxLength={4000}
              autoComplete="new-password"
              placeholder="A senha, o token ou a chave"
              disabled={busy}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label={show ? "Ocultar valor" : "Mostrar valor"}
              onClick={() => setShow((s) => !s)}
            >
              {show ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </button>
          <Button
            type="button"
            className="btn primary"
            loading={busy}
            disabled={!label.trim() || !value}
            onClick={() => void submit()}
          >
            <KeyRound size={16} /> Adicionar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
