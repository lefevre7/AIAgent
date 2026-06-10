import React from "react";

type PromptElementProps = {
  children?: React.ReactNode;
  [key: string]: unknown;
};

export function renderPrompt(node: React.ReactNode): string {
  return collapsePromptWhitespace(renderNode(node)).trim();
}

function renderNode(node: React.ReactNode, listDepth = 0): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => renderNode(child, listDepth)).join("");
  }
  if (!React.isValidElement(node)) {
    return "";
  }

  const element = node as React.ReactElement<PromptElementProps>;
  const props = (element.props ?? {}) as PromptElementProps;

  if (typeof element.type === "function") {
    const rendered = (element.type as (props: PromptElementProps) => React.ReactNode)(props);
    return renderNode(rendered, listDepth);
  }

  if ((element.type as unknown) === React.Fragment) {
    return renderNode(props.children, listDepth);
  }

  const children = renderNode(props.children, listDepth);

  switch (element.type) {
    case "h1":
    case "h2":
    case "h3":
      return `${children.trim()}\n\n`;
    case "p":
      return `${children.trim()}\n\n`;
    case "section":
      return `${children.trim()}\n\n`;
    case "ul":
      return renderList(props.children, false, listDepth);
    case "ol":
      return renderList(props.children, true, listDepth);
    case "li":
      return children;
    case "pre":
      return `${children.trim()}\n\n`;
    case "code":
      return `\`${children.trim()}\``;
    case "br":
      return "\n";
    default:
      return children;
  }
}

function renderList(children: React.ReactNode, ordered: boolean, listDepth: number): string {
  const items = React.Children.toArray(children);
  return items
    .map((item, index) => {
      const bullet = ordered ? `${index + 1}. ` : `${"  ".repeat(listDepth)}- `;
      const content = renderNode(item, listDepth + 1).trim();
      return `${bullet}${content}\n`;
    })
    .join("") + "\n";
}

function collapsePromptWhitespace(value: string): string {
  return value
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n");
}
