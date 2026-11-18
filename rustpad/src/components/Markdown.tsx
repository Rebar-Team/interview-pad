import { cn } from "@/lib/utils";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/** Element styles for chat-sized Markdown. Raw HTML in the source is never rendered. */
const components: Components = {
  p: ({ node: _, ...props }) => <p className="my-2" {...props} />,
  a: ({ node: _, ...props }) => (
    <a
      className="font-medium underline underline-offset-2"
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  ul: ({ node: _, ...props }) => (
    <ul className="my-2 list-disc space-y-1 pl-5" {...props} />
  ),
  ol: ({ node: _, ...props }) => (
    <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />
  ),
  li: ({ node: _, ...props }) => <li className="pl-0.5" {...props} />,
  h1: ({ node: _, ...props }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold" {...props} />
  ),
  h2: ({ node: _, ...props }) => (
    <h4 className="mt-4 mb-2 font-semibold" {...props} />
  ),
  h3: ({ node: _, ...props }) => (
    <h5 className="mt-3 mb-1.5 font-semibold" {...props} />
  ),
  h4: ({ node: _, ...props }) => (
    <h6 className="mt-3 mb-1.5 font-medium" {...props} />
  ),
  blockquote: ({ node: _, ...props }) => (
    <blockquote
      className="my-2 border-l-2 pl-3 text-muted-foreground"
      {...props}
    />
  ),
  hr: () => <hr className="my-3" />,
  pre: ({ node: _, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0"
      {...props}
    />
  ),
  code: ({ node: _, className, ...props }) => (
    <code
      className={cn(
        "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]",
        className,
      )}
      {...props}
    />
  ),
  table: ({ node: _, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs" {...props} />
    </div>
  ),
  th: ({ node: _, ...props }) => (
    <th className="border px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: ({ node: _, ...props }) => <td className="border px-2 py-1" {...props} />,
};

export function Markdown({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "wrap-anywhere [&>:first-child]:mt-0 [&>:last-child]:mb-0",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
