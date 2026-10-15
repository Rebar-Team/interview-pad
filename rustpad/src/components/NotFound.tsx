import { SearchX } from "lucide-react";

import { Brand } from "./Brand";
import { Link } from "./Link";
import { Button } from "./ui/button";

export function NotFound({
  title,
  description = "Check the link, or head back to the dashboard.",
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex h-14 items-center px-6">
        <Brand />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-24 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-muted">
          <SearchX className="size-5 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        <Button asChild variant="outline" className="mt-2">
          <Link href="/">Go home</Link>
        </Button>
      </main>
    </div>
  );
}
