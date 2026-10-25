// Entry for the vendored editor bundle: `npm run build:editor` writes
// vendor/editor.js, which the page imports. Rebuild after changing versions.
export { EditorView, basicSetup } from "codemirror";
export { python } from "@codemirror/lang-python";
export { EditorState, Compartment } from "@codemirror/state";
