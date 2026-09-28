import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound, ShieldAlert } from "lucide-react";

/**
 * Documentação da API pública (/docs/api), aberta sem login: é para quem
 * integra CRM, checkout e automações. O endereço dos exemplos é o do próprio
 * site. O mesmo conteúdo, em texto, está em docs/API.md.
 */

type Lang = "curl" | "js" | "python";
const LANGS: [Lang, string][] = [
  ["curl", "cURL"],
  ["js", "JavaScript"],
  ["python", "Python"],
];
const KEY = "workspace_0123…";
const CLIENT_ID = "0b6d2f1e-8c4a-4f7e-9d3b-2a1c5e6f7a8b";

type Field = { name: string; type: string; required?: boolean; about: ReactNode };
type Endpoint = {
  id: string;
  method: "GET" | "POST";
  path: string;
  title: string;
  about: ReactNode;
  params?: { title: string; fields: Field[] };
  query?: Record<string, string>;
  body?: unknown;
  status: string;
  response: unknown;
  notes?: ReactNode;
};

const clientJson = {
  id: CLIENT_ID,
  name: "Aurora Studio",
  email: "contato@aurora.com.br",
  archived: false,
  created_at: "2026-09-28T13:02:11.482Z",
  teams: [{ id: "77aa…", name: "Performance" }],
  products: [
    {
      contract_id: "c3f2…",
      product_id: "5c1f…",
      product_name: "Gestão de tráfego",
      contract_name: "Gestão de tráfego · Aurora Studio",
      created_at: "2026-09-28T13:02:11.482Z",
    },
    {
      contract_id: "d910…",
      product_id: "9a0e…",
      product_name: "Social media",
      contract_name: "Social media · plano anual",
      created_at: "2026-09-28T13:02:11.482Z",
    },
  ],
};

const ENDPOINTS: Endpoint[] = [
  {
    id: "listar-produtos",
    method: "GET",
    path: "/products",
    title: "Listar produtos",
    about: (
      <p>
        Os produtos do catálogo do espaço, em ordem alfabética. Guarde os ids na
        configuração da integração: eles não mudam quando alguém renomeia o
        produto.
      </p>
    ),
    status: "200 OK",
    response: [
      { id: "5c1f…", name: "Gestão de tráfego" },
      { id: "9a0e…", name: "Social media" },
    ],
  },
  {
    id: "listar-equipes",
    method: "GET",
    path: "/teams",
    title: "Listar equipes",
    about: (
      <p>
        As equipes do espaço. Ao cadastrar um cliente, as equipes informadas
        passam a atendê-lo: quem está nelas vê o cliente, os produtos e as
        tarefas dele.
      </p>
    ),
    status: "200 OK",
    response: [{ id: "77aa…", name: "Performance" }],
  },
  {
    id: "cadastrar-cliente",
    method: "POST",
    path: "/clients",
    title: "Cadastrar cliente com produtos",
    about: (
      <>
        <p>
          Cria o cliente, define as equipes que o atendem e vincula os produtos,{" "}
          <strong>tudo ou nada</strong>: se um produto ou uma equipe não
          existir, nada é criado e a resposta diz qual item falhou.
        </p>
        <p>
          Produtos e equipes podem ser informados pelo <strong>nome</strong>{" "}
          (sem diferenciar maiúsculas) ou pelo <strong>id</strong>. Itens
          repetidos são vinculados uma vez só.
        </p>
      </>
    ),
    params: {
      title: "Corpo (JSON)",
      fields: [
        {
          name: "name",
          type: "texto",
          required: true,
          about: "Nome do cliente, de 2 a 160 caracteres.",
        },
        {
          name: "email",
          type: "texto",
          about:
            "E-mail de contato, guardado em minúsculas. Evita duplicar o cliente (veja o 409 abaixo).",
        },
        {
          name: "teams",
          type: "lista",
          about: "Equipes que atendem o cliente, por nome ou id.",
        },
        {
          name: "products",
          type: "lista",
          about: (
            <>
              Até 50 produtos. Cada item é o nome (<code>"Social media"</code>),
              o id, ou um objeto <code>{"{ id | name, contract_name }"}</code>.
            </>
          ),
        },
        {
          name: "products[].contract_name",
          type: "texto",
          about: (
            <>
              Nome do produto contratado. Sem ele, o Workspace usa{" "}
              <code>Produto · Cliente</code>, como na tela.
            </>
          ),
        },
      ],
    },
    body: {
      name: "Aurora Studio",
      email: "contato@aurora.com.br",
      teams: ["Performance"],
      products: [
        "Gestão de tráfego",
        { name: "Social media", contract_name: "Social media · plano anual" },
      ],
    },
    status: "201 Created",
    response: {
      client: clientJson,
      linked: [
        {
          contract_id: "c3f2…",
          product_id: "5c1f…",
          product_name: "Gestão de tráfego",
          created: true,
        },
        {
          contract_id: "d910…",
          product_id: "9a0e…",
          product_name: "Social media",
          created: true,
        },
      ],
    },
    notes: (
      <>
        <p>
          <code>client.products</code> lista todos os produtos ativos do
          cliente; <code>linked</code> diz o que aconteceu com cada item
          enviado.
        </p>
        <div className="api-docs-callout">
          <strong>Cliente já cadastrado · 409</strong>
          <p>
            Se já houver um cliente <strong>ativo</strong> com o mesmo e-mail,
            nada é criado e a resposta traz o id dele. Assim, uma nova tentativa
            da integração (por timeout, por exemplo) não duplica o cliente. Use{" "}
            <a href="#vincular-produtos">vincular produtos</a> com esse id.
          </p>
          <pre>
            {JSON.stringify(
              {
                error: "Já existe um cliente ativo com este e-mail",
                existing_client_id: CLIENT_ID,
              },
              null,
              2,
            )}
          </pre>
        </div>
      </>
    ),
  },
  {
    id: "vincular-produtos",
    method: "POST",
    path: `/clients/{id}/products`,
    title: "Vincular produtos a um cliente",
    about: (
      <p>
        Vincula mais produtos a um cliente que já existe. Um produto que o
        cliente já tem (ativo) <strong>não é duplicado</strong>: aparece em{" "}
        <code>linked</code> com <code>"created": false</code> e o{" "}
        <code>contract_id</code> existente. Repetir a chamada é seguro.
      </p>
    ),
    params: {
      title: "Corpo (JSON)",
      fields: [
        {
          name: "products",
          type: "lista",
          required: true,
          about:
            "Ao menos um produto, no mesmo formato do cadastro (nome, id ou objeto com contract_name).",
        },
      ],
    },
    body: { products: ["SEO", "Gestão de tráfego"] },
    status: "200 OK",
    response: {
      client: { id: CLIENT_ID, name: "Aurora Studio", products: ["…"] },
      linked: [
        { contract_id: "e5a1…", product_id: "1d2c…", product_name: "SEO", created: true },
        {
          contract_id: "c3f2…",
          product_id: "5c1f…",
          product_name: "Gestão de tráfego",
          created: false,
        },
      ],
    },
    notes: (
      <p>
        Clientes arquivados não recebem produtos (<code>422</code>): desarquive
        o cliente no Workspace antes.
      </p>
    ),
  },
  {
    id: "consultar-cliente",
    method: "GET",
    path: `/clients/{id}`,
    title: "Consultar um cliente",
    about: (
      <p>
        O cliente, as equipes que o atendem e os produtos ativos dele: o mesmo
        objeto <code>client</code> do cadastro.
      </p>
    ),
    status: "200 OK",
    response: clientJson,
  },
  {
    id: "buscar-clientes",
    method: "GET",
    path: "/clients",
    title: "Buscar clientes",
    about: (
      <p>
        Procura antes de cadastrar. Devolve até 20 clientes, os ativos
        primeiro.
      </p>
    ),
    params: {
      title: "Parâmetros da URL",
      fields: [
        {
          name: "email",
          type: "texto",
          about: "E-mail exato, sem diferenciar maiúsculas.",
        },
        {
          name: "search",
          type: "texto",
          about:
            "Parte do nome, com 2 caracteres ou mais. Pode ser combinado com email; um dos dois é obrigatório.",
        },
      ],
    },
    query: { email: "contato@aurora.com.br" },
    status: "200 OK",
    response: [
      {
        id: CLIENT_ID,
        name: "Aurora Studio",
        email: "contato@aurora.com.br",
        archived: false,
      },
    ],
  },
];

const ERRORS: [string, string][] = [
  ["400", "Corpo que não é JSON, ou sem o campo esperado (ex.: products não é uma lista)."],
  ["401", "Chave ausente, inválida ou revogada."],
  ["404", "Rota inexistente, ou cliente que não existe neste espaço."],
  ["405", "Método não aceito na rota. O cabeçalho Allow mostra os aceitos."],
  ["409", "Já existe um cliente ativo com o mesmo e-mail (existing_client_id na resposta)."],
  [
    "422",
    "Dados inválidos: nome curto, e-mail mal formado, produto ou equipe inexistente, nome de produto repetido no catálogo (use o id), cliente arquivado, mais de 50 produtos.",
  ],
  [
    "5xx",
    "Falha temporária. Pode tentar de novo: com e-mail, o cadastro não duplica, e vincular produtos já é seguro para repetir.",
  ],
];

function examplePath(e: Endpoint) {
  const path = e.path.replace("{id}", CLIENT_ID);
  return e.query ? `${path}?${new URLSearchParams(e.query)}` : path;
}

export function snippet(lang: Lang, base: string, e: Endpoint) {
  const url = `${base}${examplePath(e)}`;
  const json = e.body === undefined ? "" : JSON.stringify(e.body, null, 2);
  if (lang === "curl")
    return [
      `curl${e.method === "POST" ? " -X POST" : ""} "${url}" \\`,
      `  -H "Authorization: Bearer $WORKSPACE_API_KEY"${json ? " \\" : ""}`,
      ...(json
        ? [
            `  -H "Content-Type: application/json" \\`,
            `  -d '${json.replace(/'/g, "'\\''").replace(/\n/g, "\n  ")}'`,
          ]
        : []),
    ].join("\n");
  if (lang === "js")
    return [
      `const res = await fetch("${url}", {`,
      ...(e.method === "POST" ? [`  method: "POST",`] : []),
      `  headers: {`,
      `    Authorization: \`Bearer \${process.env.WORKSPACE_API_KEY}\`,`,
      ...(json ? [`    "Content-Type": "application/json",`] : []),
      `  },`,
      ...(json
        ? [`  body: JSON.stringify(${json.replace(/\n/g, "\n  ")}),`]
        : []),
      `});`,
      `const data = await res.json();`,
      `if (!res.ok) throw new Error(data.error);`,
    ].join("\n");
  const py = json
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\n/g, "\n    ");
  return [
    `import os, requests`,
    ``,
    `res = requests.${e.method.toLowerCase()}(`,
    `    "${url}",`,
    `    headers={"Authorization": f"Bearer {os.environ['WORKSPACE_API_KEY']}"},`,
    ...(json ? [`    json=${py},`] : []),
    `)`,
    `data = res.json()`,
    `if not res.ok:`,
    `    raise Exception(data["error"])`,
  ].join("\n");
}

function CopyButton({ text, label = "Copiar" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="api-docs-copy"
      aria-label={`${label}`}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1600);
          })
          .catch(() => {});
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {done ? "Copiado" : "Copiar"}
    </button>
  );
}

function Code({ children, title }: { children: string; title?: ReactNode }) {
  return (
    <div className="api-docs-code">
      <div className="api-docs-code-bar">
        <span>{title}</span>
        <CopyButton text={children} label="Copiar código" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function Method({ method }: { method: Endpoint["method"] }) {
  return <span className={`api-docs-method ${method.toLowerCase()}`}>{method}</span>;
}

function EndpointSection({
  e,
  base,
  lang,
  setLang,
}: {
  e: Endpoint;
  base: string;
  lang: Lang;
  setLang: (l: Lang) => void;
}) {
  return (
    <section className="api-docs-section api-docs-endpoint" id={e.id}>
      <h3>{e.title}</h3>
      <div className="api-docs-route">
        <Method method={e.method} />
        <code>/api/v1{e.path}</code>
      </div>
      {e.about}
      {e.params && (
        <>
          <h4>{e.params.title}</h4>
          <div className="api-docs-table">
            <table>
              <thead>
                <tr>
                  <th>Campo</th>
                  <th>Tipo</th>
                  <th>Descrição</th>
                </tr>
              </thead>
              <tbody>
                {e.params.fields.map((f) => (
                  <tr key={f.name}>
                    <td>
                      <code>{f.name}</code>
                      {f.required && <span className="api-docs-required">obrigatório</span>}
                    </td>
                    <td>{f.type}</td>
                    <td>{f.about}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <h4>Exemplo</h4>
      <div className="api-docs-langs" role="tablist" aria-label="Linguagem do exemplo">
        {LANGS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={lang === id}
            className={lang === id ? "active" : ""}
            onClick={() => setLang(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <Code title="Requisição">{snippet(lang, base, e)}</Code>
      <Code title={`Resposta · ${e.status}`}>{JSON.stringify(e.response, null, 2)}</Code>
      {e.notes}
    </section>
  );
}

const TOC: [string, string][] = [
  ["introducao", "Introdução"],
  ["autenticacao", "Autenticação"],
  ["conceitos", "Conceitos"],
  ...ENDPOINTS.map((e) => [e.id, e.title] as [string, string]),
  ["erros", "Erros"],
  ["fluxo", "Fluxo recomendado"],
];

export function ApiDocs() {
  const base = `${window.location.origin}/api/v1`;
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem("api-docs-lang");
      return LANGS.some(([id]) => id === saved) ? (saved as Lang) : "curl";
    } catch {
      return "curl";
    }
  });
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem("api-docs-lang", l);
    } catch {
      /* só conveniência */
    }
  };
  const [active, setActive] = useState("introducao");
  useEffect(() => {
    document.title = "API · Workspace";
    if (window.location.hash)
      document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
    const sections = TOC.map(([id]) => document.getElementById(id)).filter(
      (el): el is HTMLElement => !!el,
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((x) => x.isIntersecting);
        if (visible.length) setActive(visible[0].target.id);
      },
      { rootMargin: "-80px 0px -70% 0px" },
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="api-docs">
      <header className="api-docs-bar">
        <a href="/" className="api-docs-brand">
          <span className="brand-mark">W</span>
          <span>
            workspace<span className="brand-period">.</span>
          </span>
        </a>
        <span className="api-docs-bar-title">API pública · v1</span>
      </header>
      <div className="api-docs-layout">
        <nav className="api-docs-toc" aria-label="Seções da documentação">
          {TOC.map(([id, label], i) => {
            const e = ENDPOINTS.find((x) => x.id === id);
            return (
              <a
                key={id}
                href={`#${id}`}
                className={`${active === id ? "active" : ""} ${e ? "endpoint" : ""} ${
                  i === 3 ? "first-endpoint" : ""
                }`}
              >
                {e && <Method method={e.method} />}
                {label}
              </a>
            );
          })}
        </nav>
        <main className="api-docs-content">
          <section className="api-docs-section" id="introducao">
            <span className="api-docs-kicker">Documentação para desenvolvedores</span>
            <h1>API de clientes e produtos</h1>
            <p className="api-docs-lead">
              Cadastre clientes e vincule produtos a eles a partir de outros
              sistemas (CRM, checkout, n8n, Make, Zapier), sem ninguém precisar
              abrir o Workspace.
            </p>
            <dl className="api-docs-facts">
              <div>
                <dt>Endereço base</dt>
                <dd>
                  <code>{base}</code>
                  <CopyButton text={base} label="Copiar endereço base" />
                </dd>
              </div>
              <div>
                <dt>Formato</dt>
                <dd>JSON (UTF-8)</dd>
              </div>
              <div>
                <dt>Escopo</dt>
                <dd>Um espaço (agência) por chave</dd>
              </div>
            </dl>
          </section>

          <section className="api-docs-section" id="autenticacao">
            <h2>Autenticação</h2>
            <ol className="api-docs-steps">
              <li>
                Um <strong>administrador</strong> abre{" "}
                <strong>Equipe e configurações › Chaves de API</strong>, dá um
                nome (ex.: CRM) e clica em <strong>Criar chave</strong>.
              </li>
              <li>
                A chave (<code>workspace_</code> + 64 caracteres) aparece{" "}
                <strong>uma única vez</strong>. Guarde-a no servidor do sistema
                que vai usá-la: o Workspace guarda só o hash e não consegue
                mostrá-la de novo. Se perder, crie outra e revogue a antiga.
              </li>
              <li>Envie a chave em todas as requisições:</li>
            </ol>
            <Code title="Cabeçalho">{`Authorization: Bearer ${KEY}`}</Code>
            <p>
              <code>X-Api-Key: {KEY}</code> também funciona. Revogar a chave na
              mesma tela corta o acesso na hora. Crie{" "}
              <strong>uma chave por sistema</strong> para poder revogar só a que
              precisar.
            </p>
            <div className="api-docs-warning">
              <ShieldAlert size={18} />
              <p>
                A chave dá acesso de escrita ao espaço. Não a coloque em código
                que roda no navegador nem em aplicativo de celular.
              </p>
            </div>
          </section>

          <section className="api-docs-section" id="conceitos">
            <h2>Conceitos</h2>
            <div className="api-docs-concepts">
              <div>
                <strong>Cliente</strong>
                <p>Nome, e-mail de contato e as equipes que o atendem.</p>
              </div>
              <div>
                <strong>Produto</strong>
                <p>
                  Serviço do catálogo do espaço (ex.: Gestão de tráfego). A API
                  não cria produtos: eles são cadastrados no Workspace.
                </p>
              </div>
              <div>
                <strong>Produto contratado</strong>
                <p>
                  O vínculo de um produto com um cliente (
                  <code>contract_id</code>). É nele que ficam tarefas, projetos
                  e horas.
                </p>
              </div>
            </div>
          </section>

          <h2 className="api-docs-group">
            <KeyRound size={20} /> Rotas
          </h2>
          {ENDPOINTS.map((e) => (
            <EndpointSection key={e.id} e={e} base={base} lang={lang} setLang={setLang} />
          ))}

          <section className="api-docs-section" id="erros">
            <h2>Erros</h2>
            <p>
              Toda resposta de erro tem o formato{" "}
              <code>{'{ "error": "mensagem em português" }'}</code>.
            </p>
            <div className="api-docs-table">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Quando</th>
                  </tr>
                </thead>
                <tbody>
                  {ERRORS.map(([code, when]) => (
                    <tr key={code}>
                      <td>
                        <span className={`api-docs-status s${code[0]}`}>{code}</span>
                      </td>
                      <td>{when}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="api-docs-section" id="fluxo">
            <h2>Fluxo recomendado</h2>
            <ol className="api-docs-steps">
              <li>
                Na configuração da integração, chame{" "}
                <a href="#listar-produtos">GET /products</a> e guarde os ids.
              </li>
              <li>
                Na venda, chame <a href="#cadastrar-cliente">POST /clients</a>{" "}
                com <code>email</code> e <code>products</code>.
              </li>
              <li>
                Se vier <code>409</code>, chame{" "}
                <a href="#vincular-produtos">
                  POST /clients/{"{existing_client_id}"}/products
                </a>{" "}
                com os mesmos produtos.
              </li>
              <li>
                Guarde o <code>client.id</code> no seu sistema para as próximas
                vendas desse cliente.
              </li>
            </ol>
            <p className="api-docs-muted">
              Quem estiver com o Workspace aberto vê o cliente novo em até 10
              minutos, ou na hora ao recarregar a página. A API não altera nem
              arquiva clientes e não remove produtos: isso continua sendo feito
              no Workspace.
            </p>
          </section>
        </main>
      </div>
    </div>
  );
}
