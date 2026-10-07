import type {
  IDisposable,
  IPosition,
  editor,
} from "monaco-editor/esm/vs/editor/editor.api";

import "./cursor-labels.css";

export type CursorLabel = {
  readonly id: string;
  readonly name: string;
  readonly hue: number;
  readonly position: IPosition;
};

type Rect = { left: number; top: number; width: number; height: number };

function overlaps(a: Rect, b: Rect) {
  return (
    a.left < b.left + b.width + 2 &&
    a.left + a.width + 2 > b.left &&
    a.top < b.top + b.height + 2 &&
    a.top + a.height + 2 > b.top
  );
}

/** Names use a separate, non-interactive layer so they never move the text/carets. */
export default class CursorLabels implements editor.IOverlayWidget {
  private readonly node = document.createElement("div");
  private readonly subscriptions: IDisposable[];
  private cursors: CursorLabel[] = [];
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

  update(cursors: CursorLabel[]) {
    this.cursors = cursors;
    this.scheduleLayout();
  }

  dispose() {
    this.disposed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
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
    this.node.replaceChildren();
    const layout = this.editor.getLayoutInfo();
    const leftEdge = layout.contentLeft;
    const rightEdge =
      leftEdge + layout.contentWidth - layout.verticalScrollbarWidth;
    const bottomEdge = layout.height - layout.horizontalScrollbarHeight;
    this.node.style.width = `${layout.width}px`;
    this.node.style.height = `${layout.height}px`;

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

    // Reserve every caret, including our own, before placing any labels.
    const occupied: Rect[] = visible.map(({ anchor }) => ({
      ...anchor,
      width: 2,
    }));
    for (const selection of this.editor.getSelections() ?? []) {
      const anchor = this.editor.getScrolledVisiblePosition(
        selection.getPosition(),
      );
      if (anchor) occupied.push({ ...anchor, width: 2 });
    }

    const groups = new Map<string, typeof visible>();
    for (const entry of visible) {
      const key = `${entry.anchor.left}:${entry.anchor.top}`;
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }

    // Coincident cursors travel as one stack, in stable user/cursor order.
    for (const group of Array.from(groups.values())) {
      const { anchor } = group[0];
      const label = document.createElement("div");
      label.className = "remote-cursor-label-group";
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
      const candidates = [
        preferredTop,
        anchor.top + anchor.height + 2,
        ...occupied.flatMap((rect) => [
          rect.top - height - 2,
          rect.top + rect.height + 2,
        ]),
      ].sort((a, b) => Math.abs(a - preferredTop) - Math.abs(b - preferredTop));
      const top = candidates.find(
        (top) =>
          top >= 0 &&
          top + height <= bottomEdge &&
          !occupied.some((rect) =>
            overlaps({ left, top, width, height }, rect),
          ),
      );
      // A packed viewport can run out of space; never cover another name/caret.
      if (top === undefined) {
        label.remove();
        continue;
      }
      label.style.left = `${left}px`;
      label.style.top = `${top}px`;
      occupied.push({ left, top, width, height });

      const stem = document.createElement("div");
      stem.className = "remote-cursor-label-stem";
      const labelEnd = top < anchor.top ? top + height : top;
      const caretEnd =
        top < anchor.top ? anchor.top : anchor.top + anchor.height;
      stem.style.left = `${anchor.left}px`;
      stem.style.top = `${Math.min(labelEnd, caretEnd)}px`;
      stem.style.height = `${Math.abs(caretEnd - labelEnd)}px`;
      stem.style.borderColor = `hsl(${group[0].cursor.hue}, 90%, 60%)`;
      this.node.prepend(stem);
    }
  }
}
