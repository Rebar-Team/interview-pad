import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding";
import { editor } from "monaco-editor/esm/vs/editor/editor.api";

import Rustpad from "../src/rustpad";

const params = new URLSearchParams(location.search);
const ed = editor.create(document.getElementById("editor")!, {
  theme: "vs-dark",
  language: "python",
  automaticLayout: true,
  minimap: { enabled: false },
  padding: { top: 12 },
  fontSize: 14,
  scrollBeyondLastLine: false,
});
const state = { connected: false };
const client = new Rustpad({
  uri: `ws://${location.host}/api/socket/${params.get("pad")}`,
  editor: ed,
  onConnected: () => {
    state.connected = true;
  },
  onDisconnected: () => {
    state.connected = false;
  },
});
client.setInfo({
  name: params.get("name")!,
  hue: Number(params.get("hue") ?? 140),
});

declare global {
  interface Window {
    pad: {
      editor: typeof ed;
      client: Rustpad;
      state: typeof state;
      setTheme: typeof editor.setTheme;
    };
  }
}
window.pad = { editor: ed, client, state, setTheme: editor.setTheme };
