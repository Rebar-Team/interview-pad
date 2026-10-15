import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

window.addEventListener("popstate", notify);

/** Client-side navigation within the single-page app. */
export function navigate(path: string) {
  window.history.pushState(null, "", path);
  notify();
}

export function usePathname(): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => window.location.pathname,
  );
}

export type Route =
  | { page: "home" }
  | { page: "room"; id: string }
  | { page: "missing" };

export function matchRoute(pathname: string): Route {
  if (pathname === "/") return { page: "home" };
  const room = pathname.match(/^\/r\/([A-Za-z0-9_-]{1,64})\/?$/);
  if (room) return { page: "room", id: room[1] };
  return { page: "missing" };
}

/** Old invite links looked like `/#abc123`; send them to `/r/abc123`. */
export function redirectLegacyHash() {
  const id = window.location.hash.slice(1);
  if (window.location.pathname === "/" && /^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    window.history.replaceState(null, "", `/r/${id}`);
  }
}
