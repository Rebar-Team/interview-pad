import { type APIRequestContext, request } from "@playwright/test";

export const BASE_URL = `http://127.0.0.1:${process.env.PW_PORT ?? 5173}`;
export const TEST_EMAIL = "test@withrebar.ai";

/** Signs in through the dev-only login route. */
export async function signedIn(): Promise<APIRequestContext> {
  const context = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
  });
  const login = await context.get(
    `/auth/dev?${new URLSearchParams({ email: TEST_EMAIL, next: "/" })}`,
  );
  if (!login.ok()) throw new Error(`dev login failed: ${login.status()}`);
  return context;
}

/** Creates a room as the test interviewer and returns its id. */
export async function createRoom(name: string): Promise<string> {
  const context = await signedIn();
  try {
    const response = await context.post("/api/rooms", { data: { name } });
    if (response.status() !== 201) {
      throw new Error(`create room failed: ${response.status()}`);
    }
    const room: { id: string } = await response.json();
    return room.id;
  } finally {
    await context.dispose();
  }
}
