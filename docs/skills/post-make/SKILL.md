---
name: post-make
title: Post Make
description: Faz o post da Make Vendas (e dos produtos Make ADS, MakeCRM, Kit de Autoridade Digital e MAVI) de ponta a ponta — copy, legenda, direção de arte e as artes prontas no padrão visual Make (feed 1080×1350, story, quadrado). Use quando pedirem post, carrossel, arte promocional, card, capa, criativo, anúncio ou vaga da Make ou de um produto Make, ou disserem "faz um post sobre X", "arte de Black Friday", "transforma essa notícia em post".
---

# POST MAKE (versão MAVI)

Tudo que a Make publica, da ideia à arte pronta na conversa. Três partes, em ordem:
**1. Copy** (o que dizer) → **2. Visual** (como fica) → **3. Entrega**. Vaga: Parte 4.
Se mandarem só o tema, faça as três. Se mandarem o roteiro pronto, pule para a Parte 2.
Arte avulsa (promoção, oferta, evento): pule a Parte 1 e siga a seção "Arte única".

---

# PARTE 1 · COPY

## Regra fundadora
A Make nunca fala sobre um assunto: usa um assunto para provar um ponto. Um fato quente e
concreto levanta um princípio de negócio, o princípio vira espelho para o empresário e a Make
aparece como quem já opera aquilo. Se o post pode ser de qualquer agência trocando a logo, falhou.

## Processo
1. Fato central em uma frase.
2. Dados reais na internet (obrigatório): 2 a 4 buscas, 4 a 6 números verificáveis, com as fontes. Nunca invente número.
3. Ângulo não óbvio: número lateral, o antes, o perdedor ou a mecânica.
4. UM eixo: atenção é ativo · presença ≠ relevância · consistência vence pico · percepção vence o fato · estratégia tem plano B · dado vence achismo · velocidade é moeda.
5. Fluxo em 6 fases (1 a 3 cards cada): retenção (capa com gancho e lacuna) → contexto (fato + números) → explicação (virada para o princípio) → 2º pico (contraponto) → conexão (provocação em 2ª pessoa + ponte Make) → CTA ("Fala com a Make." + aforismo).
6. 7 a 10 cards; cada um legível em menos de 6 segundos; head grande + apoio curto; nunca dois cards pesados seguidos.
7. Ponte com a Make: UM produto, como consequência do argumento — Make ADS (tráfego com IA própria), MakeCRM (CRM com WhatsApp nativo, lead que não se perde), Kit de Autoridade Digital (site + SEO + social), MAVI (agente comercial de IA 24/7).

## Voz
Amigo esperto que descobriu um segredo, falando com uma pessoa só. Frases curtas, antítese binária ("Patrocínio compra visibilidade. Marca compra memória."), micro-comandos ("repara nisso"), confiança leve, nunca guru.
**Banidos:** "você já parou para pensar", "no mundo de hoje", "cada vez mais", "revolucionar", "game changer", "disruptivo", "não é só X, é Y", "nesse cenário", "vale ressaltar", lista de serviços, promessa de número, superlativo sem dado. **Travessão proibido** na copy e na legenda. Emoji: no máximo 1 na capa, 2 na legenda, nunca no miolo.

## Legenda
(1) dado mais forte + 1 emoji; (2) reconta o fato; (3) aprofunda o princípio; (4) contraponto; (5) pergunta ao leitor; (6) Make em 2 linhas + 1 emoji; (7) hashtags. Não copia os cards.

## Pessoas e marcas reais
Nunca gere rosto de pessoa real nem logo de outra marca. Pessoas reais só com a foto oficial que a pessoa mandar (crédito @handle pequeno, longe do CTA). Marcas citadas entram por cores e objetos, sem logo.

---

# PARTE 2 · VISUAL

## Antes de desenhar
1. Leia a marca com **brand_kit** (cliente Make Vendas, ou o do produto, ex.: MakeCRM).
2. Se faltar logo ou a fonte Tomato Grotesk, siga com o padrão abaixo e diga no fim o que faltou (subir em Drive › cliente › Marca). Nunca desenhe o logo com texto: sem o arquivo, deixe o logo de fora.

## Padrão visual Make (quando a marca não disser outra coisa)
- Cores: Navy **#001119** (fundo) · Laranja **#FF8900** (destaque, heat, botão) · Off-white **#E9F7F6** (texto) · luz teal **#00C2D9** suave (gradiente radial, nunca neon).
- Tipografia: **Tomato Grotesk** em tudo (da marca; a palavra gigante em ExtraBold, off-white chapada, sem degradê) · **Playfair Display Bold Italic** em UMA palavra laranja por título (`@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,700&display=swap')`) · **Roc Grotesk Wide** só na pílula "ARRASTE PARA O LADO". Sem a Tomato na marca, use Inter (Google Fonts) e avise.
- Visual escuro premium: fundo navy com uma luz teal suave num canto e um brilho laranja discreto no outro; granulado leve é bem-vindo; nada de roxo, neon, cubos 3D ou "tecnologia genérica".

## Grade e hierarquia (em todo card)
- Margem lateral de **84px**; área segura ≈150px no topo e 190px na base.
- **HEAT** (tarja laranja, texto 34px caixa alta, navy, letter-spacing 3px) → **TÍTULO** 88–98px caixa alta (Light + Bold), entrelinha 1.02–1.1 → **APOIO** 41–44px → **1 ELEMENTO** visual (chips, comparativo, barras, mini tela de CRM).
- Espaços: heat→título 24 · título→apoio 28 · apoio→elemento 40 · entre caixas 12–16.
- Sem viúvas: quebre as linhas à mão (`<br>`); frases-chave não se quebram. Card nenhum vazio.
- Seta "→" no canto inferior direito dos cards 2 ao penúltimo. Sem elementos atravessando de um card para o outro.
- Monte com flex/grid dentro de uma coluna de 912px (1080 − 2×84); nada em posição solta que possa encostar em outro texto.

## Imagens
- Fundos e objetos são **cenas reais**, sem cara de IA: gere com generate_image (ou a conexão de imagens, ex.: Magnific Nano Banana Pro), prompt em inglês terminando com "real editorial photograph, 35mm film grain, natural imperfect lighting, muted realistic colors, no text, no logos". Proporção 3:4 para cards, 9:16 para story. Avise o custo antes de gerar muitas.
- Nunca peça texto dentro da imagem gerada: o texto é sempre do HTML.
- No HTML, use a imagem como `img:I2` (ex.: `background-image:url('img:I2')` com um gradiente navy por cima para o texto ficar legível).

## Capa (o card mais importante)
Objeto do tema em escala exagerada + palavra gigante + curiosidade. Nunca capa só tipográfica nem produto parado solto. A imagem ocupa o card.

## Render e revisão
- Um **render_art** por card (format "feed"; story: "story"), com o client da marca e um name ("Capa", "Card 2"…).
- Olhe a imagem que volta e o relatório: texto estourando ou sobre outro, fonte que não carregou, viúvas, fundo sumido, card vazio, contraste. Corrija com revises até ficar limpo (no máximo 3 versões por card).

## Arte única (promoção, oferta, Black Friday, evento)
1. Pergunte o que faltar e mude o resultado (ask_user): oferta exata e condições, validade, CTA e para onde leva, formato. Não invente condição.
2. Composição do padrão Make: logo no topo à esquerda (arquivo da marca) e o site à direita; tarja laranja com o tema ("BLACK FRIDAY"); o número da oferta gigante em Tomato ExtraBold off-white com o símbolo (%) em laranja; a palavra de apoio em Playfair itálico laranja ("off"); uma frase curta com a promessa do produto (uma palavra em Playfair itálico laranja); um elemento que mostre o produto (ex.: mini card de pipeline do CRM com 3 leads e selos coloridos); botão laranja arredondado com o CTA + "→" e o endereço ao lado; uma faixa fina no topo com o tema repetido ("BLACK FRIDAY ◆ 50% OFF ◆").
3. render_art, conferir, corrigir. Entregue a final e ofereça a versão story (mesma arte adaptada para 1080×1920).

---

# PARTE 3 · ENTREGA
- Na conversa: as artes finais ([[I#]]) na ordem, a legenda, e poucas linhas: ângulo, o que tem na capa, fontes dos dados, o que faltou (logo, fonte, fotos oficiais).
- Ofereça UMA alternativa de gancho em uma linha, se o tema tiver dois ângulos fortes.

---

# PARTE 4 · ARTE DE VAGA
Fundo claro #F2F6F4, logo escuro, "VAGA **ABERTA**" em Roc Wide espaçado, "Contrata-se ==Cargo==" (Light + laranja SemiBold) e o complemento em Bold navy, 2 chips com contorno navy (modelo e contrato), a frase "Sua **[competência]** pode ser o começo... / Sua próxima oportunidade **pode ser na Make**" e o botão laranja "CONHEÇA A VAGA". Fundo: multidão de bonecos 3D brancos com um laranja no centro (gerado, 9:16), topo com névoa clara.
Leia a vaga (link: scrape_pages), tire cargo, nível, modelo, contrato e 1 competência-chave, e faça feed (1080×1350) e story (1080×1920) — no story, a imagem aparece bastante e o botão não cobre o boneco laranja.

---

# CHECKLIST FINAL
Copy: números com fonte · UM eixo · ângulo não óbvio · antítese · provocação em 2ª pessoa · capa em 1 linha com lacuna · zero travessão · ponte = consequência, um produto.
Visual: marca lida · cenas reais sem texto · capa com objeto + palavra gigante · heat + título + apoio + elemento em todo card · textos grandes · sem viúvas · margem 84px · conferido na imagem · CTA ≤ 3 linhas.
