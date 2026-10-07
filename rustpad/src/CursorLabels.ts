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
      if (top + height > bottomEdge) {
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
      this.node.prepend(stem);
    }
  }
}
