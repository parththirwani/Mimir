"use client";

import { useLayoutEffect, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import { cn } from "@/lib/utils";

const WORD_MS = 500;

const components: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  h1: ({ children }) => (
    <h1 className="my-2 text-lg font-semibold first:mt-0 last:mb-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="my-2 text-base font-semibold first:mt-0 last:mb-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h4>
  ),
  h5: ({ children }) => (
    <h5 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="my-1.5 text-[0.975rem] font-semibold first:mt-0 last:mb-0">{children}</h6>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-signal underline underline-offset-2"
    >
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    const text = Array.isArray(children) ? children.join("") : String(children ?? "");
    // A fenced block carries a `language-*` class; one without a language still
    // spans newlines, so treat it as a block (rendered in the `pre` below) rather
    // than an inline pill.
    const isBlock = /language-/.test(className ?? "") || text.includes("\n");
    if (isBlock) {
      return <code className={cn(className, "font-mono")}>{children}</code>;
    }
    return (
      <code className="rounded bg-secondary/60 px-1.5 py-0.5 font-mono text-[0.875rem]">
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-secondary/60 p-3 text-[0.875rem] leading-6 first:mt-0 last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-muted-foreground/40 pl-3 text-muted-foreground first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-[0.875rem]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
  th: ({ children }) => (
    <th className="px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="px-2 py-1 align-top">{children}</td>,
};

type HNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
};

/**
 * rehype plugin: split every text node into .md-word spans so the word-by-word
 * reveal runs *inside* the parsed markdown (bold stays bold, lists stay lists).
 * Code/pre text is left whole and fades in as a unit.
 */
function wordStreamPlugin(active: boolean, wordDelay: number) {
  return () => (tree: HNode) => {
    if (!active) return;
    let index = 0;
    const visit = (node: HNode, inCode: boolean) => {
      if (node.type === "text") {
        const value = node.value ?? "";
        if (inCode || !/\S/.test(value)) return;
        const children: HNode[] = [];
        for (const token of value.split(/(\s+)/)) {
          if (token.length === 0) continue;
          if (/^\s+$/.test(token)) {
            children.push({
              type: "element",
              tagName: "span",
              properties: { className: "md-ws" },
              children: [{ type: "text", value: token }],
            });
          } else {
            children.push({
              type: "element",
              tagName: "span",
              properties: {
                className: "md-word",
                style: `animation-delay: ${index * wordDelay}ms`,
              },
              children: [{ type: "text", value: token }],
            });
            index++;
          }
        }
        node.type = "element";
        node.tagName = "span";
        node.properties = { className: "md-run" };
        node.children = children;
        delete node.value;
      } else if (node.children) {
        const childInCode = inCode || node.tagName === "code" || node.tagName === "pre";
        for (const child of node.children) visit(child, childInCode);
      }
    };
    visit(tree, false);
  };
}

/**
 * Render markdown. When `streaming`, words fade in one at a time while the
 * markdown structure stays intact; `onDone` fires once the last word landed.
 */
export function Markdown({
  children,
  streaming = false,
  wordDelay = 55,
  onDone,
  className,
}: {
  children: string;
  streaming?: boolean;
  wordDelay?: number;
  onDone?: () => void;
  className?: string;
}) {
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const containerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!streaming) return;
    const total = containerRef.current?.querySelectorAll(".md-word").length ?? 0;
    const t = setTimeout(() => doneRef.current?.(), total * wordDelay + WORD_MS + 100);
    return () => clearTimeout(t);
  }, [streaming, children, wordDelay]);

  return (
    <div ref={containerRef} className={cn("break-words", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkBreaks]}
        rehypePlugins={[wordStreamPlugin(streaming, wordDelay)] as never}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
