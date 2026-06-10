const BLOCK_REMOVALS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "footer",
  "nav"
] as const;

export function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? decodeHtmlEntities(stripTags(match[1])).replace(/\s+/g, " ").trim() : "";
  return title.length > 0 ? title : undefined;
}

export function htmlToMarkdown(html: string): string {
  let content = selectPrimaryContent(html);

  for (const tag of BLOCK_REMOVALS) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    content = content.replace(pattern, "\n");
  }

  content = content.replace(/<!--[\s\S]*?-->/g, "\n");

  const codeBlocks: string[] = [];
  content = content.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner) => {
    const code = decodeHtmlEntities(stripTags(inner)).replace(/\n{3,}/g, "\n\n").trim();
    const placeholder = `__AIA_CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(code.length > 0 ? `\n\`\`\`\n${code}\n\`\`\`\n` : "");
    return placeholder;
  });

  content = content.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, inner) => {
    const heading = renderInline(inner);
    if (!heading) {
      return "\n";
    }
    return `\n${"#".repeat(Number(level))} ${heading}\n\n`;
  });
  content = content.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, inner) => {
    const text = renderInline(inner);
    if (!text) {
      return "\n";
    }
    return `\n${text
      .split(/\n+/)
      .map((line) => `> ${line}`)
      .join("\n")}\n\n`;
  });
  content = content.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, inner) => {
    const text = renderInline(inner);
    return text ? `- ${text}\n` : "";
  });
  content = content.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => `\n${inner}\n`);
  content = content.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_match, inner) => {
    const text = renderInline(inner);
    return text ? `\n${text}\n\n` : "\n";
  });
  content = content.replace(/<div\b[^>]*>([\s\S]*?)<\/div>/gi, (_match, inner) => {
    const text = renderInline(inner);
    return text ? `\n${text}\n` : "\n";
  });
  content = content.replace(/<br\s*\/?>/gi, "\n");

  content = renderInline(content);
  for (let index = 0; index < codeBlocks.length; index += 1) {
    content = content.replaceAll(`__AIA_CODE_BLOCK_${index}__`, codeBlocks[index] ?? "");
  }

  return content
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function selectPrimaryContent(html: string): string {
  for (const tag of ["main", "article", "body"]) {
    const match = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match?.[1]) {
      return match[1];
    }
  }
  return html;
}

function renderInline(value: string): string {
  let text = value;

  text = text.replace(/<a\b[^>]*href=(['"])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_match, _quote, href, inner) => {
    const label = renderInline(inner);
    const normalizedHref = decodeHtmlEntities(String(href)).trim();
    if (!label) {
      return normalizedHref;
    }
    return normalizedHref ? `[${label}](${normalizedHref})` : label;
  });
  text = text.replace(/<img\b[^>]*alt=(['"])(.*?)\1[^>]*src=(['"])(.*?)\3[^>]*>/gi, (_match, _a, alt, _b, src) => {
    const normalizedAlt = decodeHtmlEntities(String(alt)).trim() || "image";
    const normalizedSrc = decodeHtmlEntities(String(src)).trim();
    return normalizedSrc ? `![${normalizedAlt}](${normalizedSrc})` : "";
  });
  text = text.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => {
    const rendered = renderInline(inner);
    return rendered ? `**${rendered}**` : "";
  });
  text = text.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, inner) => {
    const rendered = renderInline(inner);
    return rendered ? `*${rendered}*` : "";
  });
  text = text.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, inner) => {
    const rendered = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return rendered ? `\`${rendered}\`` : "";
  });
  text = text.replace(/<\/?(span|section|article|header|main|tbody|thead|tr|td|th|table)\b[^>]*>/gi, " ");
  text = stripTags(text);
  text = decodeHtmlEntities(text);
  return text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1]?.toLowerCase() === "x";
      const numeric = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return Number.isFinite(numeric) ? String.fromCodePoint(numeric) : match;
    }

    return HTML_ENTITIES[entity] ?? match;
  });
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  copy: "©",
  gt: ">",
  hellip: "...",
  lt: "<",
  mdash: "-",
  nbsp: " ",
  ndash: "-",
  quot: '"',
  reg: "®",
  rsquo: "'",
  trade: "™"
};
