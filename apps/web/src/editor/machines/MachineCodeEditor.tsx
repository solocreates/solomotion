"use client";

/**
 * The machine's Code tab IS the Scripts editor — one CodeMirror, one set of
 * completions (verbs, their inputs, the project's names), one error gutter.
 * Lazy-loaded by the machine window, so CodeMirror only arrives when someone
 * opens the Code tab.
 */
import CodeEditor from "../scripts/CodeEditor";
import type { CompletionDeps } from "../scripts/completions";
import { agentApi } from "../agent/runner";
import { getDocStore } from "../state/document-context";
import { useSession } from "../state/session";

const deps: CompletionDeps = { registry: agentApi, doc: () => getDocStore()?.getState() ?? null, focus: () => useSession.getState().activeFrameId };

export default function MachineCodeEditor(props: {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  error: { line: number; message: string } | null;
}) {
  return <CodeEditor mode="file" deps={deps} className="absolute inset-0 overflow-hidden" {...props} />;
}
