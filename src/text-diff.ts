/**
 * Diferença entre dois textos, linha a linha (a maior sequência em comum),
 * para mostrar o que mudou entre duas versões de um prompt. Nas linhas
 * trocadas uma a uma, as palavras que mudaram vêm marcadas.
 */
export type DiffPart = { kind: "same" | "add" | "del"; text: string };
export type DiffLine = DiffPart & {
  /** Linha trocada: os pedaços da linha, com o que entrou ou saiu. */
  words?: DiffPart[];
};

/** Acima disso (linhas × linhas no trecho que mudou), mostra tudo trocado. */
const MAX_CELLS = 4_000_000;

function lcs<T>(a: T[], b: T[], same: (x: T, y: T) => boolean) {
  // Começo e fim iguais saem antes (o caso comum: uma mudança no meio).
  let start = 0;
  while (start < a.length && start < b.length && same(a[start], b[start])) start++;
  let endA = a.length,
    endB = b.length;
  while (endA > start && endB > start && same(a[endA - 1], b[endB - 1])) {
    endA--;
    endB--;
  }
  const out: { kind: DiffPart["kind"]; a?: T; b?: T }[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "same", a: a[i], b: b[i] });
  const midA = a.slice(start, endA),
    midB = b.slice(start, endB);
  const n = midA.length,
    m = midB.length;
  if (n * m > MAX_CELLS) {
    for (const x of midA) out.push({ kind: "del", a: x });
    for (const y of midB) out.push({ kind: "add", b: y });
  } else {
    // Tabela de baixo para cima: dp[i][j] = sequência comum de midA[i..] e midB[j..].
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = same(midA[i], midB[j])
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0,
      j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && same(midA[i], midB[j])) {
        out.push({ kind: "same", a: midA[i++], b: midB[j++] });
      } else if (j < m && (i === n || dp[i][j + 1] > dp[i + 1][j])) {
        out.push({ kind: "add", b: midB[j++] });
      } else {
        out.push({ kind: "del", a: midA[i++] });
      }
    }
  }
  for (let i = endA; i < a.length; i++)
    out.push({ kind: "same", a: a[i], b: b[endB + i - endA] });
  return out;
}

/** As palavras (e os espaços entre elas) de uma linha. */
const tokens = (line: string) => line.match(/\s+|[^\s]+/g) ?? [];

export function diffWords(before: string, after: string): DiffPart[] {
  const parts: DiffPart[] = [];
  for (const p of lcs(tokens(before), tokens(after), (x, y) => x === y)) {
    const text = (p.kind === "add" ? p.b : p.a) ?? "";
    const last = parts[parts.length - 1];
    if (last && last.kind === p.kind) last.text += text;
    else parts.push({ kind: p.kind, text });
  }
  return parts;
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n?/g, "\n").split("\n");
  const b = after.replace(/\r\n?/g, "\n").split("\n");
  const raw = lcs(a, b, (x, y) => x === y).map(
    (p): DiffLine => ({
      kind: p.kind,
      text: (p.kind === "add" ? p.b : p.a) ?? "",
    }),
  );
  // Um bloco de linhas que saíram seguido de outro do mesmo tamanho que
  // entrou: cada par é uma linha trocada (mostra as palavras).
  const out: DiffLine[] = [];
  for (let i = 0; i < raw.length; ) {
    if (raw[i].kind !== "del") {
      out.push(raw[i++]);
      continue;
    }
    let d = i;
    while (d < raw.length && raw[d].kind === "del") d++;
    let e = d;
    while (e < raw.length && raw[e].kind === "add") e++;
    const dels = raw.slice(i, d),
      adds = raw.slice(d, e);
    if (dels.length === adds.length && dels.length <= 50) {
      dels.forEach((del, k) => {
        const words = diffWords(del.text, adds[k].text);
        out.push({ ...del, words }, { ...adds[k], words });
      });
    } else out.push(...dels, ...adds);
    i = e;
  }
  return out;
}

/** Quantas linhas entraram e saíram. */
export function diffStats(lines: DiffLine[]) {
  return {
    added: lines.filter((l) => l.kind === "add").length,
    removed: lines.filter((l) => l.kind === "del").length,
  };
}
