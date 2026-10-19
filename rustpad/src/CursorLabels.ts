import type {
  IDisposable,
  IPosition,
  editor,
} from "monaco-editor/esm/vs/editor/editor.api";

import "./cursor-labels.css";

const LABEL_IDLE_MS = 2000;
const LABEL_FADE_MS = 150;

export type CursorLabel = {
  readonly id: string;
  readonly name: string;
  readonly hue: number;
  readonly position: IPosition;
};

/** Names use a separate, non-interactive layer so they never move the text/carets. */
export default class CursorLabels implements editor.IOverlayWidget {
  private readonly node = document.createElement("div");
  private readonly subscriptions: IDisposable[];
  private cursors: CursorLabel[] = [];
  private lastActivity = new Map<string, number>();
  private pointer?: { x: number; y: number };
  private localEditUntil = 0;
  private timer?: number;
  private frame?: number;
  private disposed = false;

  constructor(private readonly editor: editor.IStandaloneCodeEditor) {
    this.node.className = "remote-cursor-labels";
    this.node.setAttribute("role", "list");
    this.node.setAttribute("aria-label", "Collaborator cursors");
    editor.addOverlayWidget(this);
    this.subscriptions = [
      editor.onDidScrollChange(() => this.scheduleLayout()),
      editor.onDidChangeHiddenAreas(() => this.scheduleLayout()),
      editor.onDidLayoutChange(() => this.scheduleLayout()),
      editor.onDidChangeConfiguration(() => this.scheduleLayout()),
      editor.onDidChangeCursorPosition(() => this.scheduleLayout()),
      editor.onDidFocusEditorText(() => this.scheduleLayout()),
      editor.onDidBlurEditorText(() => this.scheduleLayout()),
      editor.onMouseMove(({ event }) => {
        this.pointer = {
          x: event.browserEvent.clientX,
          y: event.browserEvent.clientY,
        };
        this.scheduleLayout();
      }),
      editor.onMouseLeave(() => {
        this.pointer = undefined;
        this.scheduleLayout();
      }),
    ];
  }

  getId() {
    return "rustpad.cursor-labels";
  }

  getDomNode() {
    return this.node;
  }

  getPosition() {
    return null;
  }

  update(cursors: CursorLabel[], activeUserId?: number) {
    const now = Date.now();
    this.lastActivity = new Map(
      cursors.map((cursor) => [
        cursor.id,
        cursor.id.startsWith(`${activeUserId}:`)
          ? now
          : (this.lastActivity.get(cursor.id) ?? now),
      ]),
    );
    this.cursors = cursors;
    this.scheduleLayout();
  }

  onLocalEdit() {
    this.localEditUntil = Date.now() + LABEL_IDLE_MS;
    this.scheduleLayout();
  }

  dispose() {
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
    this.subscriptions.forEach((subscription) => subscription.dispose());
    this.editor.removeOverlayWidget(this);
  }

  private scheduleLayout() {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.layout();
    });
  }

  private layout() {
    window.clearTimeout(this.timer);
    const now = Date.now();
    const deadlines = Array.from(
      this.lastActivity.values(),
      (time) => time + LABEL_IDLE_MS + LABEL_FADE_MS,
    );
    deadlines.push(this.localEditUntil);
    const nextDeadline = Math.min(...deadlines.filter((time) => time > now));
    if (Number.isFinite(nextDeadline)) {
      this.timer = window.setTimeout(
        () => this.scheduleLayout(),
        nextDeadline - now,
      );
    }
    this.node.replaceChildren();
    const layout = this.editor.getLayoutInfo();
    const leftEdge = layout.contentLeft;
    const rightEdge =
      leftEdge + layout.contentWidth - layout.verticalScrollbarWidth;
    const bottomEdge = layout.height - layout.horizontalScrollbarHeight;
    this.node.style.width = `${layout.width}px`;
    this.node.style.height = `${layout.height}px`;
    const editorRect = this.editor.getDomNode()!.getBoundingClientRect();
    const editingRows =
      this.editor.hasTextFocus() && now < this.localEditUntil
        ? (this.editor.getSelections() ?? []).flatMap((selection) => {
            const position = this.editor.getScrolledVisiblePosition(
              selection.getPosition(),
            );
            return position ? [position] : [];
          })
        : [];

    const visibleRanges = this.editor.getVisibleRanges();
    const visible = this.cursors.flatMap((cursor) => {
      if (
        !visibleRanges.some((range) => range.containsPosition(cursor.position))
      )
        return [];
      const anchor = this.editor.getScrolledVisiblePosition(cursor.position);
      if (
        !anchor ||
        anchor.top < 0 ||
        anchor.top + anchor.height > bottomEdge ||
        anchor.left < leftEdge ||
        anchor.left > rightEdge
      )
        return [];
      return [{ cursor, anchor }];
    });

    const groups = new Map<string, typeof visible>();
    for (const entry of visible) {
      const key = `${entry.cursor.position.lineNumber}:${entry.cursor.position.column}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }

    // Only identical document positions stack. Later positions paint on top.
    const orderedGroups = Array.from(groups.values()).sort(
      (a, b) =>
        a[0].cursor.position.lineNumber - b[0].cursor.position.lineNumber ||
        a[0].cursor.position.column - b[0].cursor.position.column,
    );
    for (let index = 0; index < orderedGroups.length; index++) {
      const group = orderedGroups[index];
      const { anchor } = group[0];
      const hovered =
        this.pointer !== undefined &&
        Math.abs(this.pointer.x - editorRect.left - anchor.left) <= 6 &&
        this.pointer.y >= editorRect.top + anchor.top &&
        this.pointer.y <= editorRect.top + anchor.top + anchor.height;
      const elapsed =
        now -
        Math.max(
          ...group.map(({ cursor }) => this.lastActivity.get(cursor.id)!),
        );
      if (!hovered && elapsed >= LABEL_IDLE_MS + LABEL_FADE_MS) continue;
      const label = document.createElement("div");
      label.className = "remote-cursor-label-group";
      label.style.zIndex = String(index + 1);
      label.setAttribute("role", "presentation");
      for (const { cursor } of group) {
        const name = document.createElement("div");
        name.className = "remote-cursor-label";
        name.dataset.cursorId = cursor.id;
        name.textContent = cursor.name.trim().split(/\s+/)[0] || "Anonymous";
        name.setAttribute("role", "listitem");
        name.setAttribute(
          "aria-label",
          `${cursor.name}, line ${cursor.position.lineNumber}, column ${cursor.position.column}`,
        );
        name.style.backgroundColor = `hsl(${cursor.hue}, 90%, 75%)`;
        name.style.maxWidth = `${Math.max(0, Math.min(200, rightEdge - leftEdge))}px`;
        label.appendChild(name);
      }
      this.node.appendChild(label);

      const width = label.offsetWidth;
      const height = label.offsetHeight;
      const left = Math.max(leftEdge, Math.min(anchor.left, rightEdge - width));
      const preferredTop = anchor.top - height - 2;
      const top =
        preferredTop >= 0 ? preferredTop : anchor.top + anchor.height + 2;
      if (
        top + height > bottomEdge ||
        editingRows.some(
          (row) => top < row.top + row.height && top + height > row.top,
        )
      ) {
        label.remove();
        continue;
      }
      label.style.left = `${left}px`;
      label.style.top = `${top}px`;

      const stem = document.createElement("div");
      stem.className = "remote-cursor-label-stem";
      const labelEnd = top < anchor.top ? top + height : top;
      const caretEnd =
        top < anchor.top ? anchor.top : anchor.top + anchor.height;
      stem.style.left = `${anchor.left}px`;
      stem.style.top = `${Math.min(labelEnd, caretEnd)}px`;
      stem.style.height = `${Math.abs(caretEnd - labelEnd)}px`;
      stem.style.borderColor = `hsl(${group[0].cursor.hue}, 90%, 60%)`;
      if (!hovered) {
        for (const element of [label, stem]) {
          element.style.animation = `remote-cursor-label-fade ${LABEL_FADE_MS}ms linear ${LABEL_IDLE_MS - elapsed}ms forwards`;
        }
      }
      this.node.prepend(stem);
    }
  }
}
