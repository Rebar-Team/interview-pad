import { useQuery } from "@tanstack/react-query";

export type Me = {
  email: string;
  name: string;
  picture: string | null;
  /** How long a new room stays writable. */
  roomTtlMs: number;
};

export type Room = {
  id: string;
  name: string;
  createdBy?: string;
  createdAt: number;
  expiresAt: number;
  writable: boolean;
  /** Server clock at response time; only on the public room endpoint. */
  serverNow?: number;
  /** Whether the interview assistant is available; public endpoint only. */
  assistant?: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(response.status, message);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  me: () => request<Me>("/api/me"),
  gamertag: () => request<{ name: string }>("/api/gamertag"),
  rooms: () => request<Room[]>("/api/rooms"),
  room: (id: string) => request<Room>(`/api/rooms/${encodeURIComponent(id)}`),
  createRoom: (name: string) =>
    request<Room>("/api/rooms", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
};

/** Resolves to `null` when signed out. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useRooms() {
  return useQuery({
    queryKey: ["rooms"],
    queryFn: api.rooms,
    refetchInterval: 60_000,
  });
}

/** Resolves to `null` for an unknown room. */
export function useRoom(id: string) {
  return useQuery({
    queryKey: ["room", id],
    queryFn: async () => {
      try {
        return await api.room(id);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: Infinity,
  });
}

export function loginUrl(next = window.location.pathname) {
  return `/auth/login?next=${encodeURIComponent(next)}`;
}

export function roomUrl(id: string) {
  return `${window.location.origin}/r/${id}`;
}
