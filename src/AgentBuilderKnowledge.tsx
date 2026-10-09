import { useCallback, useEffect, useRef, useState } from "react";
import {
  FileText,
  Globe,
  Image as ImageIcon,
  MessageCircleQuestion,
  MessagesSquare,
  Package,
  RefreshCw,
  Search,
  Trash2,
  Type,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "./components";
import { Button, Input, Loading, Textarea } from "./ui";
import {
  agentOp,
  csvToItems,
  errorOf,
  when,
  KIND_LABEL,
  parseCsv,
  uploadKnowledgeFile,
  type KnowledgeItem,
  type KnowledgeKind,
  type KnowledgeTotals,
  type SearchResult,
} from "./agent-builder";

/**
 * A base de conhecimento do agente: perguntas e respostas, produtos,
 * documentos (arquivo ou página), mídias para enviar e exemplos de conversa.
 * O motor divide em trechos, gera os vetores e o agente busca só o que importa
 * a cada mensagem — o prompt fica enxuto.
 */

const KIND_ICON: Record<KnowledgeKind, LucideIcon> = {
  faq: MessageCircleQuestion,
  product: Package,
  document: FileText,
  media: ImageIcon,
  example: MessagesSquare,
  text: Type,
};

type AddKind = "faq" | "product" | "text" | "example" | "url" | "file" | "media" | "csv";
const ADD: { id: AddKind; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "faq", label: "Pergunta e resposta", icon: MessageCircleQuestion, hint: "Dúvidas frequentes" },
  { id: "product", label: "Produto", icon: Package, hint: "Nome, preço, detalhes" },
  { id: "file", label: "Arquivo", icon: Upload, hint: "PDF, DOCX, TXT, CSV" },
  { id: "url", label: "Página", icon: Globe, hint: "Site ou PDF por link" },
  { id: "media", label: "Mídia para enviar", icon: ImageIcon, hint: "Imagem, vídeo, PDF" },
  { id: "text", label: "Texto", icon: Type, hint: "Políticas, informações" },
  { id: "example", label: "Exemplo de conversa", icon: MessagesSquare, hint: "Como responder bem" },
  { id: "csv", label: "Importar planilha", icon: FileText, hint: "FAQ ou produtos em CSV" },
];

const STATUS: Record<KnowledgeItem["status"], [string, string]> = {
  pending: ["Na fila", ""],
  processing: ["Processando", ""],
  ready: ["Pronto", "on"],
  error: ["Erro", "danger"],
};

const itemTitle = (i: KnowledgeItem) =>
  i.kind === "faq"
    ? (i.data.question ?? i.title)
    : i.kind === "product"
      ? (i.data.name ?? i.title)
      : i.title || i.source.filename || i.source.url || KIND_LABEL[i.kind];
const itemPreview = (i: KnowledgeItem) =>
  i.kind === "faq"
    ? (i.data.answer ?? "")
    : i.kind === "product"
      ? [i.data.price, i.data.category, i.data.description].filter(Boolean).join(" · ")
      : i.kind === "media"
        ? (i.data.description ?? "")
        : i.body_preview;

export function KnowledgePanel({
  company,
  agentId,
  canEdit,
  notify,
}: {
  company: string;
  agentId: string;
  canEdit: boolean;
  notify: (m: string) => void;
}) {
  const [data, setData] = useState<{ items: KnowledgeItem[]; totals: KnowledgeTotals } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<KnowledgeKind | "">("");
  const [adding, setAdding] = useState<AddKind | null>(null);
  const [open, setOpen] = useState<KnowledgeItem | null>(null);
  const timers = useRef<number[]>([]);

  const load = useCallback(() => {
    agentOp<{ items: KnowledgeItem[]; totals: KnowledgeTotals }>(company, agentId, "knowledge-list", { limit: 1000 })
      .then((r) => {
        setData(r);
        setError("");
      })
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId]);
  useEffect(load, [load]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  /** Depois de adicionar: confere duas vezes (o motor processa em segundo plano), sem ficar perguntando. */
  const recheck = () => {
    load();
    timers.current.push(window.setTimeout(load, 6000), window.setTimeout(load, 25000));
  };

  const items = (data?.items ?? []).filter((i) => !filter || i.kind === filter);
  const counts = (data?.items ?? []).reduce<Record<string, number>>((m, i) => ({ ...m, [i.kind]: (m[i.kind] ?? 0) + 1 }), {});

  return (
    <div className="ab-stack">
      <p className="muted ab-section-intro">
        O agente consulta esta base a cada mensagem e usa só os trechos que combinam com o assunto. Coloque aqui preços,
        produtos, políticas e dúvidas frequentes — tudo que muda ou é detalhado demais para as instruções.
      </p>
      {canEdit && (
        <div className="ab-add-grid">
          {ADD.map((a) => (
            <button key={a.id} type="button" className="ab-add" onClick={() => setAdding(a.id)}>
              <a.icon size={18} aria-hidden="true" />
              <strong>{a.label}</strong>
              <span className="muted">{a.hint}</span>
            </button>
          ))}
        </div>
      )}
      <SearchBox company={company} agentId={agentId} />
      <div className="ab-toolbar">
        <div className="ab-chips" role="group" aria-label="Filtrar por tipo">
          <button type="button" className={!filter ? "selected" : ""} onClick={() => setFilter("")}>
            Tudo {data ? `(${data.items.length})` : ""}
          </button>
          {(Object.keys(KIND_LABEL) as KnowledgeKind[])
            .filter((k) => counts[k])
            .map((k) => (
              <button key={k} type="button" className={filter === k ? "selected" : ""} onClick={() => setFilter(k)}>
                {KIND_LABEL[k]} ({counts[k]})
              </button>
            ))}
        </div>
        <span className="ab-toolbar-right">
          {data && (
            <span className="muted">
              {data.totals.chunks} trechos
              {data.totals.processing ? ` · ${data.totals.processing} processando` : ""}
              {data.totals.errors ? ` · ${data.totals.errors} com erro` : ""}
            </span>
          )}
          <button type="button" className="agent-link-btn" onClick={load}>
            <RefreshCw size={14} aria-hidden="true" /> Atualizar
          </button>
        </span>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!data && !error && <Loading variant="list" />}
      {data && !items.length && <p className="muted">Nada na base ainda.</p>}
      <ul className="ab-list">
        {items.map((i) => {
          const Icon = KIND_ICON[i.kind];
          const [label, tone] = STATUS[i.status];
          return (
            <li key={i.id} className="ab-row">
              <button type="button" className="ab-row-main ab-row-button" onClick={() => setOpen(i)}>
                <span className="ab-row-title">
                  <Icon size={15} aria-hidden="true" />
                  <strong>{itemTitle(i)}</strong>
                </span>
                <span className="muted ab-clamp">{i.status === "error" ? i.error : itemPreview(i)}</span>
              </button>
              <span className="ab-row-actions">
                <span className={`ab-badge ${tone}`}>{label}</span>
                {canEdit && i.status === "error" && (
                  <button
                    type="button"
                    className="agent-link-btn"
                    onClick={() =>
                      agentOp(company, agentId, "knowledge-reprocess", { item: i.id })
                        .then(recheck)
                        .catch((e) => notify(errorOf(e)))
                    }
                  >
                    <RefreshCw size={14} aria-hidden="true" /> Tentar de novo
                  </button>
                )}
                {canEdit && (
                  <button
                    type="button"
                    className="agent-link-btn danger"
                    aria-label={`Excluir ${itemTitle(i)}`}
                    onClick={() => {
                      if (!window.confirm(`Excluir "${itemTitle(i)}" da base de conhecimento?`)) return;
                      agentOp(company, agentId, "knowledge-delete", { item: i.id })
                        .then(() => {
                          notify("Item excluído.");
                          load();
                        })
                        .catch((e) => notify(errorOf(e)));
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {adding && (
        <AddModal
          kind={adding}
          company={company}
          agentId={agentId}
          onClose={() => setAdding(null)}
          onDone={(msg) => {
            setAdding(null);
            notify(msg);
            recheck();
          }}
        />
      )}
      {open && <ItemModal company={company} agentId={agentId} item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function SearchBox({ company, agentId }: { company: string; agentId: string }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="ab-search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!query.trim()) return;
        setBusy(true);
        setError("");
        agentOp<{ results: SearchResult[] }>(company, agentId, "knowledge-search", { query, k: 6 })
          .then((r) => setResults(r.results))
          .catch((err) => setError(errorOf(err)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="ab-search-row">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Testar a busca como o agente faria (ex.: "aceita cartão?")'
          aria-label="Testar a busca"
        />
        <Button type="submit" className="btn secondary" loading={busy}>
          <Search size={15} aria-hidden="true" /> Buscar
        </Button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {results && (
        <ol className="ab-results">
          {!results.length && <li className="muted">Nada encontrado: falta essa informação na base.</li>}
          {results.map((r) => (
            <li key={r.chunk_id}>
              <span className="muted">
                {KIND_LABEL[r.kind]}
                {r.vector_rank && r.keyword_rank ? " · sentido e palavras" : r.vector_rank ? " · pelo sentido" : " · pelas palavras"}
              </span>
              <strong>{r.title}</strong>
              <span>{r.content.length > 320 ? `${r.content.slice(0, 320)}…` : r.content}</span>
            </li>
          ))}
        </ol>
      )}
    </form>
  );
}

function AddModal({
  kind,
  company,
  agentId,
  onClose,
  onDone,
}: {
  kind: AddKind;
  company: string;
  agentId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [f, setF] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [attrs, setAttrs] = useState("");
  const [csvKind, setCsvKind] = useState<"faq" | "product">("faq");
  const [preview, setPreview] = useState<{ count: number; items: unknown[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const title = ADD.find((a) => a.id === kind)!.label;

  const submit = async () => {
    const add = (item: Record<string, unknown>) => agentOp(company, agentId, "knowledge-add", { item });
    switch (kind) {
      case "faq":
        await add({ kind: "faq", data: { question: f.question, answer: f.answer } });
        return "Pergunta adicionada.";
      case "product": {
        const attributes = Object.fromEntries(
          attrs
            .split("\n")
            .map((l) => l.split(/:(.*)/s).map((x) => x.trim()))
            .filter(([k, v]) => k && v),
        );
        await add({
          kind: "product",
          data: { name: f.name, price: f.price ?? "", category: f.category ?? "", description: f.description ?? "", ...(Object.keys(attributes).length ? { attributes } : {}) },
        });
        return "Produto adicionado.";
      }
      case "text":
      case "example":
        await add({ kind, title: f.title ?? "", body: f.body });
        return "Texto adicionado.";
      case "url":
        await add({ kind: "document", title: f.title ?? "", url: f.url });
        return "Página adicionada: o motor vai ler e dividir em trechos.";
      case "file":
        if (!file) throw new Error("Escolha o arquivo.");
        await uploadKnowledgeFile(company, agentId, file, { kind: "document", title: f.title });
        return "Arquivo enviado: o motor vai ler e dividir em trechos.";
      case "media":
        if (!file) throw new Error("Escolha a mídia.");
        await uploadKnowledgeFile(company, agentId, file, { kind: "media", title: f.title, description: f.description });
        return "Mídia adicionada.";
      case "csv": {
        if (!preview?.count) throw new Error("Nenhuma linha válida na planilha.");
        const r = await agentOp<{ created: number; errors: unknown[] }>(company, agentId, "knowledge-bulk", { items: preview.items });
        return `${r.created} ${csvKind === "faq" ? "perguntas" : "produtos"} importados${r.errors.length ? ` (${r.errors.length} com erro)` : ""}.`;
      }
    }
  };

  return (
    <Modal title={title} onClose={onClose} busy={busy}>
      <form
        className="ab-form"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          submit()
            .then((m) => onDone(m ?? "Adicionado."))
            .catch((err) => setError(errorOf(err)))
            .finally(() => setBusy(false));
        }}
      >
        {kind === "faq" && (
          <>
            <label>
              <span>Pergunta</span>
              <Input value={f.question ?? ""} onChange={set("question")} required maxLength={1000} placeholder="Vocês aceitam cartão?" />
            </label>
            <label>
              <span>Resposta</span>
              <Textarea value={f.answer ?? ""} onChange={set("answer")} required rows={4} maxLength={10000} />
            </label>
          </>
        )}
        {kind === "product" && (
          <>
            <label>
              <span>Nome</span>
              <Input value={f.name ?? ""} onChange={set("name")} required maxLength={300} />
            </label>
            <div className="ab-two">
              <label>
                <span>Preço</span>
                <Input value={f.price ?? ""} onChange={set("price")} placeholder="R$ 99,90" maxLength={100} />
              </label>
              <label>
                <span>Categoria</span>
                <Input value={f.category ?? ""} onChange={set("category")} maxLength={120} />
              </label>
            </div>
            <label>
              <span>Descrição</span>
              <Textarea value={f.description ?? ""} onChange={set("description")} rows={3} maxLength={4000} />
            </label>
            <label>
              <span>Outros detalhes (um por linha, no formato "nome: valor")</span>
              <Textarea value={attrs} onChange={(e) => setAttrs(e.target.value)} rows={3} placeholder={"tamanhos: P ao GG\nentrega: 3 dias úteis"} />
            </label>
          </>
        )}
        {(kind === "text" || kind === "example") && (
          <>
            <label>
              <span>Título</span>
              <Input value={f.title ?? ""} onChange={set("title")} maxLength={300} placeholder={kind === "example" ? "Lead perguntando de desconto" : "Política de troca"} />
            </label>
            <label>
              <span>{kind === "example" ? "A conversa (como o agente deve responder)" : "Texto"}</span>
              <Textarea
                value={f.body ?? ""}
                onChange={set("body")}
                required
                rows={10}
                maxLength={200000}
                placeholder={kind === "example" ? "Lead: tem desconto?\nAgente: ..." : ""}
              />
            </label>
          </>
        )}
        {kind === "url" && (
          <>
            <label>
              <span>Endereço</span>
              <Input type="url" value={f.url ?? ""} onChange={set("url")} required placeholder="https://www.cliente.com.br/sobre" />
            </label>
            <label>
              <span>Título (opcional)</span>
              <Input value={f.title ?? ""} onChange={set("title")} maxLength={300} />
            </label>
            <small className="muted">A página é lida uma vez. Se ela mudar, use "Tentar de novo" para ler outra vez.</small>
          </>
        )}
        {(kind === "file" || kind === "media") && (
          <>
            <label>
              <span>{kind === "file" ? "Arquivo (PDF, DOCX, TXT, MD, CSV, HTML — até 50 MB)" : "Mídia (imagem, vídeo, áudio ou PDF — até 50 MB)"}</span>
              <input
                type="file"
                className="ui-input"
                required
                accept={kind === "file" ? ".pdf,.docx,.txt,.md,.csv,.html,.htm" : "image/*,video/*,audio/*,application/pdf"}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label>
              <span>Título (opcional)</span>
              <Input value={f.title ?? ""} onChange={set("title")} maxLength={300} />
            </label>
            {kind === "media" && (
              <label>
                <span>Quando enviar esta mídia</span>
                <Textarea
                  value={f.description ?? ""}
                  onChange={set("description")}
                  required
                  rows={3}
                  maxLength={4000}
                  placeholder="Ex.: Foto do cardápio. Enviar quando o lead pedir o cardápio ou os preços dos pratos."
                />
                <small className="muted">É por esta descrição que o agente encontra a mídia certa.</small>
              </label>
            )}
          </>
        )}
        {kind === "csv" && (
          <>
            <div className="ab-chips" role="group" aria-label="O que a planilha tem">
              <button type="button" className={csvKind === "faq" ? "selected" : ""} onClick={() => (setCsvKind("faq"), setPreview(null))}>
                Perguntas e respostas
              </button>
              <button type="button" className={csvKind === "product" ? "selected" : ""} onClick={() => (setCsvKind("product"), setPreview(null))}>
                Produtos
              </button>
            </div>
            <small className="muted">
              {csvKind === "faq"
                ? 'Colunas: "pergunta" e "resposta".'
                : 'Colunas: "nome", "preço", "categoria", "descrição"; as outras viram detalhes do produto.'}{" "}
              Exporte do Excel/Google Planilhas como CSV.
            </small>
            <input
              type="file"
              className="ui-input"
              accept=".csv,text/csv"
              required
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const items = csvToItems(parseCsv(await file.text()), csvKind);
                setPreview({ count: items.length, items });
              }}
            />
            {preview && <p className="muted">{preview.count} linhas válidas encontradas (até 500 por vez).</p>}
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="agent-editor-foot">
          <Button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button type="submit" className="btn primary" loading={busy}>
            Adicionar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ItemModal({ company, agentId, item, onClose }: { company: string; agentId: string; item: KnowledgeItem; onClose: () => void }) {
  const [chunks, setChunks] = useState<{ id: string; ord: number; content: string; context: string }[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    agentOp<{ chunks: { id: string; ord: number; content: string; context: string }[] }>(company, agentId, "knowledge-get", { item: item.id })
      .then((r) => setChunks(r.chunks))
      .catch((e) => setError(errorOf(e)));
  }, [company, agentId, item.id]);
  return (
    <Modal title={itemTitle(item)} onClose={onClose} wide>
      <div className="ab-stack">
        <p className="muted">
          {KIND_LABEL[item.kind]} · adicionado em {when(item.created_at)}
          {item.created_by ? ` por ${item.created_by}` : ""}
          {item.source.url ? ` · ${item.source.url}` : ""}
          {item.source.filename ? ` · ${item.source.filename}` : ""}
        </p>
        {item.status === "error" && <p className="form-error">{item.error}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {!chunks && !error && <Loading variant="list" />}
        {chunks && (
          <>
            <strong>{chunks.length === 1 ? "1 trecho" : `${chunks.length} trechos`} na busca</strong>
            <ol className="ab-chunks">
              {chunks.map((c) => (
                <li key={c.id}>
                  {c.context && <span className="muted ab-chunk-context">{c.context}</span>}
                  <span>{c.content}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
    </Modal>
  );
}
