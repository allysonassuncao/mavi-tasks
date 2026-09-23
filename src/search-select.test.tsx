import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Select,
  SelectOption,
  SEARCH_THRESHOLD,
  nodeText,
  searchOptions,
} from "./ui";

const options = [
  { value: "", children: "Todos os clientes" },
  { value: "1", children: "Aurora Studio" },
  { value: "2", children: "Açaí da Praça" },
  {
    value: "3",
    children: createElement("span", null, "Make Ads · ", "Óptica Sol"),
  },
];

describe("searchOptions", () => {
  it("devolve tudo quando nada foi digitado", () => {
    expect(searchOptions(options, "  ")).toHaveLength(4);
  });
  it("ignora acentos e maiúsculas", () => {
    expect(searchOptions(options, "acai").map((o) => o.value)).toEqual(["2"]);
    expect(searchOptions(options, "AURORA").map((o) => o.value)).toEqual(["1"]);
  });
  it("exige todas as palavras, em qualquer ordem", () => {
    expect(searchOptions(options, "sol make").map((o) => o.value)).toEqual([
      "3",
    ]);
    expect(searchOptions(options, "sol aurora")).toEqual([]);
  });
  it("lê o texto de rótulos com elementos", () => {
    expect(nodeText(options[3].children)).toBe("Make Ads ·  Óptica Sol");
  });
});

describe("Select com muitas opções", () => {
  const many = Array.from({ length: SEARCH_THRESHOLD + 1 }, (_, i) => (
    <SelectOption key={i} value={`t${i}`}>
      Tarefa {i}
    </SelectOption>
  ));
  it("vira campo de busca e mantém o valor no formulário", () => {
    const html = renderToStaticMarkup(
      <Select name="task" required defaultValue="t3">
        {many}
      </Select>,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain("Tarefa 3");
    const input = html.match(/<input[^>]*name="task"[^>]*>/)?.[0] ?? "";
    expect(input).toContain('value="t3"');
    expect(input).toContain("required");
  });
  it("mantém o menu simples com poucas opções", () => {
    const html = renderToStaticMarkup(
      <Select name="priority" defaultValue="a">
        <SelectOption value="a">A</SelectOption>
        <SelectOption value="b">B</SelectOption>
      </Select>,
    );
    expect(html).not.toContain("ui-search-select");
  });
});
