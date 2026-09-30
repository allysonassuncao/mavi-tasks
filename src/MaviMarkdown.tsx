import type { ReactNode } from "react";
import { ARTIFACT_LINE } from "./mavi-artifacts";

/**
 * A resposta da MAVI em Markdown, no módulo MAVI: títulos, tabelas, listas
 * (com números e com um nível dentro), citações, código, linhas e links. O
 * texto de cada trecho passa por `inline`, que desenha as fontes [S1], os
 * momentos [12:34] e o negrito como no resto do sistema; aqui entram o
 * código `assim`, o itálico e os links (só http e https).
 */

type Inline = (text: string) => ReactNode[];

const INLINE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(?<![*\w])\*(?!\*)([^*\n]+?)\*(?![*\w])/g;

function inlineRich(text: string, inline: Inline, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (let m = INLINE.exec(text); m; m = INLINE.exec(text)) {
    if (m.index > last) out.push(...wrap(inline(text.slice(last, m.index)), `${key}t${n++}`));
    if (m[1] !== undefined) out.push(<code key={`${key}c${n++}`}>{m[1]}</code>);
    else if (m[2] !== undefined)
      out.push(
        <a key={`${key}a${n++}`} href={m[3]} target="_blank" rel="noopener noreferrer">
          {m[2]}
        </a>,
      );
    else out.push(<em key={`${key}e${n++}`}>{wrap(inline(m[4]), `${key}ei`)}</em>);
    last = m.index + m[0].length;
  }
  INLINE.lastIndex = 0;
  if (last < text.length) out.push(...wrap(inline(text.slice(last)), `${key}t${n++}`));
  return out;
}
/** As peças de `inline` com chaves únicas neste trecho. */
function wrap(nodes: ReactNode[], key: string) {
  return nodes.map((node, i) => <span key={`${key}-${i}`}>{node}</span>);
}

const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
const LIST = /^(\s*)([-•*]|\d+[.)])\s+(.*)$/;

export function MaviMarkdown({
  text,
  inline,
  renderArtifact,
}: {
  text: string;
  inline: Inline;
  renderArtifact?: (ref: string) => ReactNode;
}) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const k = () => `b${out.length}`;
  const rich = (t: string, key: string) => inlineRich(t, inline, key);
  while (i < lines.length) {
    const line = lines[i];
    // Anexo da MAVI (gráfico, imagem, ação, documento).
    const artifact = line.match(ARTIFACT_LINE);
    if (artifact) {
      out.push(
        <div key={k()} className="answer-artifact">
          {renderArtifact?.(artifact[1])}
        </div>,
      );
      i++;
      continue;
    }
    // Código.
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(
        <pre key={k()} className="md-code">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    // Tabela: a linha de cabeçalho e a de separação.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) =>
        /^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : "left",
      );
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      const key = k();
      out.push(
        <div key={key} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c} style={{ textAlign: align[c] as "left" }}>
                    {rich(h, `${key}h${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, c) => (
                    <td key={c} style={{ textAlign: align[c] as "left" }}>
                      {rich(r[c] ?? "", `${key}r${ri}c${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      const key = k();
      const content = rich(heading[2], key);
      out.push(
        level <= 2 ? (
          <h3 key={key} className="md-h">{content}</h3>
        ) : (
          <h4 key={key} className="md-h">{content}</h4>
        ),
      );
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(<hr key={k()} className="md-hr" />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      const key = k();
      out.push(
        <blockquote key={key} className="md-quote">
          {body.filter((b) => b.trim()).map((b, bi) => (
            <p key={bi}>{rich(b, `${key}q${bi}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }
    // Listas (um nível dentro, pelo recuo).
    if (LIST.test(line)) {
      const key = k();
      type Item = { text: string; children: { text: string; ordered: boolean }[] };
      const items: Item[] = [];
      const ordered = /^\s*\d/.test(line);
      const base = line.match(LIST)![1].length;
      while (i < lines.length && LIST.test(lines[i])) {
        const [, indent, marker, body] = lines[i].match(LIST)!;
        if (indent.length > base && items.length)
          items[items.length - 1].children.push({ text: body, ordered: /\d/.test(marker) });
        else items.push({ text: body, children: [] });
        i++;
      }
      const List = ordered ? "ol" : "ul";
      out.push(
        <List key={key} className="md-list">
          {items.map((it, ii) => {
            const sub = it.children;
            const Sub = sub[0]?.ordered ? "ol" : "ul";
            return (
              <li key={ii}>
                {rich(it.text, `${key}i${ii}`)}
                {!!sub.length && (
                  <Sub className="md-list">
                    {sub.map((s, si) => (
                      <li key={si}>{rich(s.text, `${key}i${ii}s${si}`)}</li>
                    ))}
                  </Sub>
                )}
              </li>
            );
          })}
        </List>,
      );
      continue;
    }
    if (line.trim()) {
      const key = k();
      // Uma referência no meio da frase não aparece (o anexo tem o seu lugar).
      out.push(<p key={key}>{rich(line.replace(/\s?\[\[[VIADQT]\d{1,2}\]\]/g, ""), key)}</p>);
    }
    i++;
  }
  return <>{out}</>;
}
