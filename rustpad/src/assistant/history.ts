export const MAX_HISTORY_EXCHANGES = 10;

/** Retain complete visible exchanges, matching the server's turn-count bound. */
export function appendTurn<T>(turns: T[], turn: T): T[] {
  return [...turns.slice(-(MAX_HISTORY_EXCHANGES - 1)), turn];
}
