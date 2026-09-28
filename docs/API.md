# API pública da MAVI — v1

Serve para sistemas externos (CRM, checkout, n8n, Make, Zapier…) **cadastrarem clientes e vincularem produtos** a eles, sem ninguém abrir a MAVI.

- **Endereço base:** `https://SEU-DOMINIO/api/v1` (aparece pronto para copiar em **Equipe e configurações › Chaves de API**).
- **Formato:** JSON (`Content-Type: application/json`), UTF-8.
- **Escopo:** cada chave pertence a **um espaço** (agência). Tudo o que ela cria ou lê fica nesse espaço; clientes, produtos e equipes de outros espaços não existem para ela.

## Autenticação

1. Um **administrador** abre **Equipe e configurações › Chaves de API**, dá um nome (ex.: `CRM`) e clica em **Criar chave**.
2. A chave (`mavi_` + 64 caracteres) aparece **uma única vez**. Copie e guarde no servidor do sistema que vai usá-la. A MAVI guarda só o hash, então não é possível recuperá-la depois: se perder, crie outra e revogue a antiga.
3. Envie a chave em todas as requisições:

```http
Authorization: Bearer mavi_0123…
```

`X-Api-Key: mavi_0123…` também funciona.

Revogar a chave na mesma tela corta o acesso na hora. A lista mostra quem criou cada chave e quando ela foi usada pela última vez. Crie **uma chave por sistema** para poder revogar só a que precisar.

> A chave dá acesso de escrita ao espaço. Não a coloque em código que roda no navegador nem em aplicativo de celular.

## Conceitos

| MAVI | Na API |
|---|---|
| **Cliente** | `client`: nome, e-mail de contato e as equipes que atendem o cliente. |
| **Produto** | Serviço do catálogo do espaço (ex.: "Gestão de tráfego"). A API **não cria** produtos: eles são cadastrados na MAVI, em Produtos. |
| **Produto contratado** | O vínculo de um produto com um cliente (`contract_id`). É nele que as tarefas, os projetos e as horas ficam. |

Produtos e equipes podem ser informados **pelo id ou pelo nome**. O nome não diferencia maiúsculas de minúsculas, mas precisa ser exato (acentos inclusive). Se dois produtos tiverem o mesmo nome, use o id.

## Endpoints

| Método | Caminho | O que faz |
|---|---|---|
| `GET` | `/products` | Lista os produtos do catálogo |
| `GET` | `/teams` | Lista as equipes |
| `POST` | `/clients` | Cadastra um cliente e já vincula os produtos |
| `POST` | `/clients/{id}/products` | Vincula mais produtos a um cliente existente |
| `GET` | `/clients/{id}` | Consulta um cliente e os produtos dele |
| `GET` | `/clients?email=…` ou `?search=…` | Procura clientes pelo e-mail ou por parte do nome |

---

### `GET /products`

```bash
curl https://SEU-DOMINIO/api/v1/products \
  -H "Authorization: Bearer $MAVI_API_KEY"
```

```json
[
  { "id": "5c1f…", "name": "Gestão de tráfego" },
  { "id": "9a0e…", "name": "Social media" }
]
```

### `GET /teams`

Mesmo formato: `[{ "id": "…", "name": "Performance" }]`.

---

### `POST /clients` — cadastrar cliente com produtos

**Corpo**

| Campo | Tipo | Obrigatório | Descrição |
|---|---|---|---|
| `name` | texto | sim | Nome do cliente, de 2 a 160 caracteres. |
| `email` | texto | não | E-mail de contato. É guardado em minúsculas. |
| `teams` | lista | não | Equipes que atendem o cliente (id ou nome). Quem está nelas passa a ver o cliente, os produtos e as tarefas dele. |
| `products` | lista | não | Produtos a vincular (até 50). Cada item pode ser: o **nome** (`"Social media"`), o **id**, ou um objeto `{ "id" \| "name", "contract_name" }`. |

`contract_name` é o nome do produto contratado. Se não for enviado, a MAVI usa `Produto · Cliente` (ex.: `Social media · Aurora Studio`), como na tela. Produtos repetidos na lista são vinculados uma vez só.

**A operação é tudo ou nada:** se um produto ou uma equipe não existir, nada é criado e a resposta diz qual item falhou.

```bash
curl -X POST https://SEU-DOMINIO/api/v1/clients \
  -H "Authorization: Bearer $MAVI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Aurora Studio",
    "email": "contato@aurora.com.br",
    "teams": ["Performance"],
    "products": [
      "Gestão de tráfego",
      { "name": "Social media", "contract_name": "Social media · plano anual" }
    ]
  }'
```

**Resposta `201 Created`**

```json
{
  "client": {
    "id": "0b6d…",
    "name": "Aurora Studio",
    "email": "contato@aurora.com.br",
    "archived": false,
    "created_at": "2026-09-28T13:02:11.482Z",
    "teams": [{ "id": "77aa…", "name": "Performance" }],
    "products": [
      {
        "contract_id": "c3f2…",
        "product_id": "5c1f…",
        "product_name": "Gestão de tráfego",
        "contract_name": "Gestão de tráfego · Aurora Studio",
        "created_at": "2026-09-28T13:02:11.482Z"
      },
      {
        "contract_id": "d910…",
        "product_id": "9a0e…",
        "product_name": "Social media",
        "contract_name": "Social media · plano anual",
        "created_at": "2026-09-28T13:02:11.482Z"
      }
    ]
  },
  "linked": [
    { "contract_id": "c3f2…", "product_id": "5c1f…", "product_name": "Gestão de tráfego", "created": true },
    { "contract_id": "d910…", "product_id": "9a0e…", "product_name": "Social media", "created": true }
  ]
}
```

`client.products` lista todos os produtos ativos do cliente; `linked` diz o que aconteceu com cada item enviado.

**Cliente já cadastrado (`409`).** Se já houver um cliente **ativo** com o mesmo e-mail, nada é criado e a resposta traz o id dele. Assim, uma nova tentativa da integração (por timeout, por exemplo) não duplica o cliente:

```json
{ "error": "Já existe um cliente ativo com este e-mail", "existing_client_id": "0b6d…" }
```

Nesse caso, use `POST /clients/{existing_client_id}/products` para vincular os produtos. Clientes sem e-mail não passam por essa verificação.

---

### `POST /clients/{id}/products` — vincular produtos a um cliente existente

```bash
curl -X POST https://SEU-DOMINIO/api/v1/clients/0b6d…/products \
  -H "Authorization: Bearer $MAVI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "products": ["SEO", "Gestão de tráfego"] }'
```

**Resposta `200`:** o mesmo formato de `POST /clients`. Um produto que o cliente **já tem** (ativo) não é duplicado: aparece em `linked` com `"created": false` e o `contract_id` existente. Por isso, repetir a chamada é seguro.

```json
{
  "client": { "id": "0b6d…", "name": "Aurora Studio", "products": [ … ] },
  "linked": [
    { "contract_id": "e5a1…", "product_id": "1d2c…", "product_name": "SEO", "created": true },
    { "contract_id": "c3f2…", "product_id": "5c1f…", "product_name": "Gestão de tráfego", "created": false }
  ]
}
```

Clientes arquivados não recebem produtos (`422`). Desarquive-o na MAVI antes.

---

### `GET /clients/{id}`

Devolve o objeto `client` (o mesmo de `POST /clients`), com equipes e produtos ativos.

### `GET /clients?email=…` / `GET /clients?search=…`

Procura antes de cadastrar. `email` busca o e-mail exato (sem diferenciar maiúsculas); `search` busca parte do nome (2 caracteres ou mais). Os dois podem ser combinados. Devolve até 20 clientes, os ativos primeiro:

```json
[{ "id": "0b6d…", "name": "Aurora Studio", "email": "contato@aurora.com.br", "archived": false }]
```

## Erros

Toda resposta de erro tem o formato `{ "error": "mensagem em português" }`.

| Status | Quando |
|---|---|
| `400` | Corpo que não é JSON, ou sem o campo esperado (ex.: `products` não é uma lista). |
| `401` | Chave ausente, inválida ou revogada. |
| `404` | Rota inexistente, ou cliente que não existe neste espaço. |
| `405` | Método não aceito na rota (o cabeçalho `Allow` mostra os aceitos). |
| `409` | Já existe um cliente ativo com o mesmo e-mail (`existing_client_id` na resposta). |
| `422` | Dados inválidos: nome curto, e-mail mal formado, produto ou equipe inexistente, nome de produto ambíguo, cliente arquivado, mais de 50 produtos. |
| `5xx` | Falha temporária. Pode tentar de novo: com e-mail, o cadastro não duplica, e vincular produtos já é seguro para repetir. |

## Fluxo recomendado para uma integração

1. Na configuração da integração, chame `GET /products` e guarde os ids (ids não mudam quando alguém renomeia o produto na MAVI; nomes, sim).
2. Na venda: `POST /clients` com `email` e `products`.
3. Se vier `409`, chame `POST /clients/{existing_client_id}/products` com os mesmos produtos.
4. Guarde o `client.id` no seu sistema para as próximas vendas desse cliente (`POST /clients/{id}/products`).

## Observações

- Quem estiver com a MAVI aberta vê o cliente novo em até 10 minutos (o catálogo fica em cache) ou na hora, ao recarregar a página.
- A API não altera nem arquiva clientes e não remove produtos. Isso continua sendo feito na MAVI.
- Implementação: rota `/api/v1/*` → `api/_public-api.ts`; as regras ficam no banco, nas funções `api_*` da migração `20261115090000_public_api.sql` (a chave é validada e o espaço isolado ali).
