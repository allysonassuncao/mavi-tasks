import { rpc } from "./api";
import { supabase } from "./supabase";
import { uploadToGcs } from "./gcs";
import { validateAttachment } from "./attachments";
import { dateKey } from "./domain";
import type { Snapshot } from "./types";

/**
 * Financeiro › Mídia: the media account of each contracted product (client
 * + product), like a bank account. Entries are never edited: a reversal
 * fixes a mistake. The Campanhas spend × M comes in as debits by itself.
 * Migration 20270114090000_finance_media.
 */

export type MediaKind = "credit" | "debit";
export type MediaLevel = "ok" | "low" | "negative";
export type MediaCategory = {
  id: string;
  name: string;
  kind: MediaKind | "both";
  archived: boolean;
  /** How many entries use it. */
  entries: number;
};
/** An account as the list shows it (migration 20270119090000). */
export type MediaAccount = {
  contract_id: string;
  client_id: string;
  client_name: string;
  product_name: string;
  product_color: string | null;
  /** The client or the contracted product is archived. */
  archived: boolean;
  balance: number;
  min_balance: number | null;
  level: MediaLevel;
};
export type MediaAccounts = {
  is_admin: boolean;
  is_leader: boolean;
  accounts: MediaAccount[];
};
export type MediaReceipt = {
  id: string;
  name: string;
  path: string;
  size_bytes: number;
  created_at: string;
};
export type MediaEntry = {
  id: string;
  kind: MediaKind;
  amount: number;
  occurred_on: string;
  source: "manual" | "campaign" | "reversal";
  category_id: string | null;
  category_name: string | null;
  reason: string;
  campaign_id: string | null;
  campaign_name: string | null;
  platform: string | null;
  day: string | null;
  spend: number | null;
  multiplier: number | null;
  /** Null: the system (the Campanhas sync). */
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  balance_after: number;
  reversal_of: string | null;
  reversed_by: {
    id: string;
    created_at: string;
    by_name: string | null;
    reason: string;
  } | null;
  receipts: MediaReceipt[];
};
export type StatementFilter = {
  from: string;
  to: string;
  /** "", credit, debit, campaign or reversal. */
  kind: string;
  category: string;
};
export type MediaStatement = {
  balance: number;
  min_balance: number | null;
  level: MediaLevel;
  /** The balance before `from`. */
  opening: number;
  total: number;
  credits: number;
  debits: number;
  entries: MediaEntry[];
};
export type EntryInput = {
  contract: string;
  kind: MediaKind;
  amount: number;
  occurred_on: string;
  category: string;
  reason: string;
};

export interface MediaBackend {
  accounts(all: boolean): Promise<MediaAccounts>;
  statement(
    contract: string,
    filter: StatementFilter,
    limit: number,
    offset: number,
  ): Promise<MediaStatement>;
  categories(): Promise<MediaCategory[]>;
  saveCategory(c: {
    id: string | null;
    name: string;
    kind: MediaCategory["kind"];
    archived: boolean;
  }): Promise<MediaCategory[]>;
  createEntry(input: EntryInput): Promise<string>;
  reverse(entry: string, reason: string): Promise<string>;
  setMinBalance(contract: string, min: number | null): Promise<void>;
  /** Uploads a receipt of the entry (the GCS, as task attachments). */
  attach(entry: string, file: File): Promise<void>;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown) =>
  v === null || v === undefined ? null : Number(v);
function account(a: MediaAccount): MediaAccount {
  return {
    ...a,
    balance: num(a.balance),
    min_balance: numOrNull(a.min_balance),
  };
}
function entry(e: MediaEntry): MediaEntry {
  return {
    ...e,
    amount: num(e.amount),
    spend: numOrNull(e.spend),
    multiplier: numOrNull(e.multiplier),
    balance_after: num(e.balance_after),
    receipts: e.receipts ?? [],
  };
}

export function supabaseMedia(company: string): MediaBackend {
  return {
    async accounts(all) {
      const r = (await rpc("media_accounts", {
        p_company: company,
        p_all: all,
      })) as MediaAccounts;
      return { ...r, accounts: r.accounts.map(account) };
    },
    async statement(contract, f, limit, offset) {
      const r = (await rpc("media_statement", {
        p_company: company,
        p_contract: contract,
        p_from: f.from || null,
        p_to: f.to || null,
        p_kind: f.kind,
        p_category: f.category || null,
        p_limit: limit,
        p_offset: offset,
      })) as MediaStatement;
      return {
        ...r,
        balance: num(r.balance),
        min_balance: numOrNull(r.min_balance),
        opening: num(r.opening),
        credits: num(r.credits),
        debits: num(r.debits),
        entries: r.entries.map(entry),
      };
    },
    async categories() {
      return (await rpc("media_categories", {
        p_company: company,
      })) as MediaCategory[];
    },
    async saveCategory(c) {
      return (await rpc("save_media_category", {
        p_company: company,
        p_id: c.id,
        p_name: c.name,
        p_kind: c.kind,
        p_archived: c.archived,
      })) as MediaCategory[];
    },
    async createEntry(i) {
      return (await rpc("create_media_entry", {
        p_company: company,
        p_contract: i.contract,
        p_kind: i.kind,
        p_amount: i.amount,
        p_occurred_on: i.occurred_on,
        p_category: i.category,
        p_reason: i.reason,
      })) as string;
    },
    async reverse(id, reason) {
      return (await rpc("reverse_media_entry", {
        p_company: company,
        p_entry: id,
        p_reason: reason,
      })) as string;
    },
    async setMinBalance(contract, min) {
      await rpc("set_media_account", {
        p_company: company,
        p_contract: contract,
        p_min_balance: min,
      });
    },
    async attach(id, file) {
      const contentType = validateAttachment(file);
      if (!supabase) throw Error("Conecte o Supabase para enviar arquivos.");
      const receipt = (await rpc("prepare_media_receipt", {
        p_company: company,
        p_entry: id,
        p_name: file.name,
        p_size: file.size,
      })) as MediaReceipt;
      try {
        await uploadToGcs({ kind: "media-receipt", id: receipt.id }, file, contentType);
      } catch (error) {
        await rpc("discard_media_receipt", { p_receipt: receipt.id }).catch(
          () => {},
        );
        throw error;
      }
      await rpc("confirm_media_receipt", { p_receipt: receipt.id });
    },
  };
}

/* ------------------------------------------------------------------ */
/* What was already loaded, to show right away                         */

/**
 * The last accounts, categories and statements loaded in this tab (memory
 * only: balances change all day, a copy from another visit would mislead).
 * The page shows them at once and asks the database again behind them;
 * the same question asked twice at the same time (hover, then click) goes
 * once.
 */
const memory = new Map<string, unknown>();
const inFlight = new Map<string, Promise<unknown>>();
const MEMORY_LIMIT = 80;
export function remembered<T>(key: string): T | undefined {
  return memory.get(key) as T | undefined;
}
export function remember<T>(key: string, value: T) {
  memory.delete(key);
  memory.set(key, value);
  // The oldest go first.
  while (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value!);
}
/** Asks once for everyone waiting on the same key; remembers the answer. */
export function fetchOnce<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const pending = inFlight.get(key) as Promise<T> | undefined;
  if (pending) return pending;
  const p = fetcher()
    .then((value) => {
      remember(key, value);
      return value;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}
export const statementKey = (
  scope: string,
  contract: string,
  f: StatementFilter,
  limit: number,
) => `${scope}:extrato:${contract}:${f.from}|${f.to}|${f.kind}|${f.category}:${limit}`;
/** Drops what was remembered of an account (it just changed). */
export function forgetStatements(scope: string, contract: string | null) {
  const prefix = contract ? `${scope}:extrato:${contract}:` : `${scope}:extrato:`;
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
}

/**
 * Calls `run` once after a burst of calls has settled (`wait` ms without a
 * new one), but no later than `max` ms after the first: the Campanhas sync
 * sends one notice per day it records.
 */
export function coalesce(run: () => void, wait = 400, max = 2000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  const call = () => {
    const now = Date.now();
    if (!timer) first = now;
    clearTimeout(timer);
    const delay = Math.max(0, Math.min(wait, first + max - now));
    timer = setTimeout(() => {
      timer = undefined;
      run();
    }, delay);
  };
  call.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return call;
}

/* ------------------------------------------------------------------ */
/* Rules shared by the screen and the demonstration                    */

export const KIND_LABEL: Record<MediaKind, string> = {
  credit: "Entrada",
  debit: "Saída",
};
export const CATEGORY_KIND_LABEL: Record<MediaCategory["kind"], string> = {
  credit: "Entradas",
  debit: "Saídas",
  both: "Entradas e saídas",
};
export const LEVEL_LABEL: Record<MediaLevel, string> = {
  ok: "Saldo ok",
  low: "Abaixo do mínimo",
  negative: "Negativo",
};
export function levelOf(balance: number, min: number | null): MediaLevel {
  if (balance < 0) return "negative";
  if (min !== null && balance < min) return "low";
  return "ok";
}
/** The categories a new entry of this kind may use. */
export function categoriesFor(list: MediaCategory[], kind: MediaKind) {
  return list.filter(
    (c) => !c.archived && (c.kind === "both" || c.kind === kind),
  );
}
/** R$ 1.234,56 — also for amounts typed with a dot or a comma. */
export function parseMoney(text: string) {
  const t = text.trim().replace(/\s|R\$/g, "");
  if (!t) return Number.NaN;
  // "1.234,56" / "1234,56" / "1234.56" / "1.234"
  let normalized = t;
  if (t.includes(",")) normalized = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) normalized = t.replace(/\./g, "");
  return /^\d+(\.\d+)?$/.test(normalized) ? Number(normalized) : Number.NaN;
}
/** Checks a draft the way the database will, with friendlier messages. */
export function entryInput(
  draft: {
    contract: string;
    kind: MediaKind;
    amount: string;
    occurred_on: string;
    category: string;
    reason: string;
  },
  today: string,
): { input: EntryInput } | { error: string } {
  if (!draft.contract) return { error: "Escolha a conta (cliente e produto)." };
  const amount = parseMoney(draft.amount);
  if (Number.isNaN(amount) || amount <= 0)
    return { error: "Informe um valor maior que zero." };
  if (Math.round(amount * 100) / 100 !== amount)
    return { error: "O valor tem no máximo dois decimais (centavos)." };
  if (amount >= 1e12) return { error: "Valor alto demais." };
  if (!draft.occurred_on) return { error: "Informe a data do lançamento." };
  if (draft.occurred_on > today)
    return { error: "A data do lançamento não pode ser futura." };
  if (!draft.category) return { error: "Escolha uma categoria." };
  const reason = draft.reason.trim();
  if (reason.length < 3)
    return { error: "Escreva o motivo do lançamento (ao menos 3 caracteres)." };
  if (reason.length > 1000)
    return { error: "O motivo tem no máximo 1000 caracteres." };
  return {
    input: {
      contract: draft.contract,
      kind: draft.kind,
      amount,
      occurred_on: draft.occurred_on,
      category: draft.category,
      reason,
    },
  };
}
/** Signed amount, as it moves the balance. */
export const signed = (e: Pick<MediaEntry, "kind" | "amount">) =>
  e.kind === "credit" ? e.amount : -e.amount;
export function platformName(p: string | null) {
  return (
    {
      meta: "Meta",
      google: "Google",
      linkedin: "LinkedIn",
      tiktok: "TikTok",
      kwai: "Kwai",
    }[p ?? ""] ??
    p ??
    ""
  );
}
export type ClientStatus = "active" | "archived";
export const CLIENT_STATUS_LABEL: Record<ClientStatus, string> = {
  active: "Ativos",
  archived: "Arquivados",
};
/**
 * Whether the account's client is active or archived (Clientes). An account
 * whose client isn't in the list the screen has follows its own flag.
 */
export function clientStatus(
  a: Pick<MediaAccount, "client_id" | "archived">,
  clients: { id: string; archived: boolean }[] | ReadonlyMap<string, boolean>,
): ClientStatus {
  const archived =
    clients instanceof Map
      ? clients.get(a.client_id)
      : (clients as { id: string; archived: boolean }[]).find((c) => c.id === a.client_id)?.archived;
  return (archived ?? a.archived) ? "archived" : "active";
}
/** Clients' archived flag by id, to look each account up at once. */
export const archivedById = (clients: { id: string; archived: boolean }[]) =>
  new Map(clients.map((c) => [c.id, c.archived]));
/**
 * Toggles one status of the filter; the last one on stays on (the list
 * would be empty otherwise).
 */
export function toggleStatus(on: ClientStatus[], status: ClientStatus): ClientStatus[] {
  if (!on.includes(status)) return [...on, status];
  return on.length > 1 ? on.filter((s) => s !== status) : on;
}
/** The totals of the accounts on screen. */
export function summary(accounts: MediaAccount[]) {
  return {
    balance: accounts.reduce((s, a) => s + a.balance, 0),
    negative: accounts.filter((a) => a.level === "negative").length,
    low: accounts.filter((a) => a.level === "low").length,
    count: accounts.length,
  };
}

/* ------------------------------------------------------------------ */
/* Demonstration (in memory; reloading discards it)                    */

type DemoEntry = Omit<
  MediaEntry,
  "balance_after" | "reversed_by" | "category_name" | "created_by_name"
> & { contract: string };

export function demoMedia(data: () => Snapshot, user: string): MediaBackend {
  const snap = data();
  const today = dateKey(new Date());
  const addDays = (d: string, n: number) => {
    const x = new Date(`${d}T12:00:00`);
    x.setDate(x.getDate() + n);
    return dateKey(x);
  };
  let seq = 0;
  const id = () => `demo-media-${++seq}`;
  const categories: MediaCategory[] = [
    ["Saldo inicial", "credit"],
    ["Depósito do cliente", "credit"],
    ["Bônus ou cortesia", "credit"],
    ["Devolução ao cliente", "debit"],
    ["Taxa ou imposto", "debit"],
    ["Gasto em outra plataforma", "debit"],
    ["Transferência entre contas", "both"],
    ["Ajuste", "both"],
  ].map(([name, kind]) => ({
    id: id(),
    name,
    kind: kind as MediaCategory["kind"],
    archived: false,
    entries: 0,
  }));
  const mins = new Map<string, number | null>();
  const entries: DemoEntry[] = [];
  // Four active accounts and one of a former client (the "Arquivados" filter).
  const contracts = [
    ...snap.contracts.filter((k) => !k.archived).slice(0, 4),
    ...snap.contracts.filter((k) => k.archived).slice(0, 1),
  ];
  const at = (d: string) => `${d}T10:00:00.000Z`;
  contracts.forEach((k, i) => {
    const start = addDays(today, -20);
    entries.push({
      id: id(),
      contract: k.id,
      kind: "credit",
      amount: 5000 - i * 1500,
      occurred_on: start,
      source: "manual",
      category_id: categories[1].id,
      reason: "Pix do cliente para a verba do mês",
      campaign_id: null,
      campaign_name: null,
      platform: null,
      day: null,
      spend: null,
      multiplier: null,
      created_by: user,
      created_at: at(start),
      reversal_of: null,
      receipts: [],
    });
    for (let d = 1; d <= 18; d++) {
      const day = addDays(start, d);
      const spend = Math.round((90 + ((d * 37 + i * 11) % 60)) * 100) / 100;
      entries.push({
        id: id(),
        contract: k.id,
        kind: "debit",
        amount: Math.round(spend * 1.3 * 100) / 100,
        occurred_on: day,
        source: "campaign",
        category_id: null,
        reason: `Gasto Meta de ${day.split("-").reverse().join("/")} na campanha Leads - Meta: ${spend.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} × M 1,3`,
        campaign_id: "demo-campaign",
        campaign_name: "Leads - Meta",
        platform: "meta",
        day,
        spend,
        multiplier: 1.3,
        created_by: null,
        created_at: at(day),
        reversal_of: null,
        receipts: [],
      });
    }
    mins.set(k.id, i === 1 ? 1000 : null);
  });
  const name = (u: string | null) =>
    u ? (snap.members.find((m) => m.user_id === u)?.name ?? "Você") : null;
  const ordered = (contract: string) => {
    let running = 0;
    return entries
      .filter((e) => e.contract === contract)
      .sort((a, b) =>
        a.occurred_on === b.occurred_on
          ? a.created_at.localeCompare(b.created_at)
          : a.occurred_on.localeCompare(b.occurred_on),
      )
      .map((e) => {
        running += signed(e);
        return { e, balance_after: Math.round(running * 100) / 100 };
      });
  };
  const balanceOf = (contract: string) =>
    Math.round(
      entries
        .filter((e) => e.contract === contract)
        .reduce((s, e) => s + signed(e), 0) * 100,
    ) / 100;
  const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));
  const list = () =>
    categories.map((c) => ({
      ...c,
      entries: entries.filter((e) => e.category_id === c.id).length,
    }));
  return {
    async accounts(all) {
      const accounts = snap.contracts
        .filter(
          (k) =>
            entries.some((e) => e.contract === k.id) ||
            mins.has(k.id) ||
            (all && !k.archived),
        )
        .map((k) => {
          const client = snap.clients.find((c) => c.id === k.client_id);
          const product = snap.products.find((p) => p.id === k.product_id);
          const balance = balanceOf(k.id);
          const min = mins.get(k.id) ?? null;
          return {
            contract_id: k.id,
            client_id: k.client_id,
            client_name: client?.name ?? "Cliente",
            product_name: product?.name ?? "Produto",
            product_color: product?.color ?? null,
            archived: k.archived || !!client?.archived,
            balance,
            min_balance: min,
            level: levelOf(balance, min),
          };
        })
        .sort((a, b) =>
          (a.client_name + a.product_name).localeCompare(
            b.client_name + b.product_name,
            "pt-BR",
          ),
        );
      return later({ is_admin: true, is_leader: true, accounts });
    },
    async statement(contract, f, limit, offset) {
      const all = ordered(contract);
      const opening = f.from
        ? all
            .filter(({ e }) => e.occurred_on < f.from)
            .reduce((s, { e }) => s + signed(e), 0)
        : 0;
      const filtered = all.filter(
        ({ e }) =>
          (!f.from || e.occurred_on >= f.from) &&
          (!f.to || e.occurred_on <= f.to) &&
          (!f.kind ||
            e.kind === f.kind ||
            (f.kind === "campaign" && e.source === "campaign") ||
            (f.kind === "reversal" && e.source === "reversal")) &&
          (!f.category || e.category_id === f.category),
      );
      const page = [...filtered].reverse().slice(offset, offset + limit);
      const balance = balanceOf(contract);
      const min = mins.get(contract) ?? null;
      return later({
        balance,
        min_balance: min,
        level: levelOf(balance, min),
        opening,
        total: filtered.length,
        credits: filtered
          .filter(({ e }) => e.kind === "credit")
          .reduce((s, { e }) => s + e.amount, 0),
        debits: filtered
          .filter(({ e }) => e.kind === "debit")
          .reduce((s, { e }) => s + e.amount, 0),
        entries: page.map(({ e, balance_after }) => {
          const rev = entries.find((r) => r.reversal_of === e.id);
          return {
            ...e,
            balance_after,
            category_name:
              categories.find((c) => c.id === e.category_id)?.name ?? null,
            created_by_name: name(e.created_by),
            reversed_by: rev
              ? {
                  id: rev.id,
                  created_at: rev.created_at,
                  by_name: name(rev.created_by),
                  reason: rev.reason,
                }
              : null,
          };
        }),
      });
    },
    async categories() {
      return later(list());
    },
    async saveCategory(c) {
      const clash = categories.find(
        (x) =>
          x.name.trim().toLowerCase() === c.name.trim().toLowerCase() &&
          x.id !== c.id,
      );
      if (clash) throw Error("Já existe uma categoria com esse nome.");
      if (c.name.trim().length < 2)
        throw Error("O nome da categoria precisa ter de 2 a 60 caracteres.");
      if (c.id) {
        const x = categories.find((y) => y.id === c.id);
        if (x) Object.assign(x, { ...c, name: c.name.trim() });
      } else
        categories.push({
          id: id(),
          name: c.name.trim(),
          kind: c.kind,
          archived: c.archived,
          entries: 0,
        });
      return later(list());
    },
    async createEntry(i) {
      const e: DemoEntry = {
        id: id(),
        contract: i.contract,
        kind: i.kind,
        amount: i.amount,
        occurred_on: i.occurred_on,
        source: "manual",
        category_id: i.category,
        reason: i.reason,
        campaign_id: null,
        campaign_name: null,
        platform: null,
        day: null,
        spend: null,
        multiplier: null,
        created_by: user,
        created_at: new Date().toISOString(),
        reversal_of: null,
        receipts: [],
      };
      entries.push(e);
      return later(e.id);
    },
    async reverse(entryId, reason) {
      const e = entries.find((x) => x.id === entryId);
      if (!e) throw Error("Lançamento não encontrado");
      if (e.source === "reversal")
        throw Error("Um estorno não pode ser estornado: faça um novo lançamento.");
      if (entries.some((x) => x.reversal_of === e.id))
        throw Error("Este lançamento já foi estornado.");
      const r: DemoEntry = {
        ...e,
        id: id(),
        kind: e.kind === "credit" ? "debit" : "credit",
        occurred_on: today > e.occurred_on ? today : e.occurred_on,
        source: "reversal",
        category_id: null,
        reason,
        campaign_id: null,
        campaign_name: null,
        platform: null,
        day: null,
        spend: null,
        multiplier: null,
        created_by: user,
        created_at: new Date().toISOString(),
        reversal_of: e.id,
        receipts: [],
      };
      entries.push(r);
      return later(r.id);
    },
    async setMinBalance(contract, min) {
      mins.set(contract, min);
      await later(null);
    },
    async attach(entryId, file) {
      validateAttachment(file);
      const e = entries.find((x) => x.id === entryId);
      if (!e) throw Error("Lançamento não encontrado");
      e.receipts.push({
        id: id(),
        name: file.name,
        path: "",
        size_bytes: file.size,
        created_at: new Date().toISOString(),
      });
      await later(null);
    },
  };
}
