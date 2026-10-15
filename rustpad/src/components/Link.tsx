import { navigate } from "@/lib/router";
import type { ComponentProps, MouseEvent } from "react";

/** An anchor that navigates client-side, keeping modifier-clicks native. */
export function Link({ href, onClick, ...props }: ComponentProps<"a">) {
  function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    onClick?.(e);
    if (
      e.defaultPrevented ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey ||
      !href
    ) {
      return;
    }
    e.preventDefault();
    navigate(href);
  }
  return <a href={href} onClick={handleClick} {...props} />;
}
