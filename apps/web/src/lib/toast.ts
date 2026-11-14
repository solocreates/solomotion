import { useStatusBar, type StatusKind } from "@/editor/state/status-bar";

/**
 * Drop-in `toast` — the SAME surface the app already imported from "sonner", so
 * every call site stays byte-for-byte identical; only the destination changed.
 * Instead of a floating popup, each message lands on the headless status bus
 * (`useStatusBar`) and shows on the sticky bottom StatusBar. A returned id can
 * be passed back as `{ id }` to update the same line (loading → success/error).
 */

interface ToastOptions {
  id?: string;
  description?: string;
  /** One offer beside the message — see `StatusAction`. Sonner's own shape. */
  action?: { label: string; onClick: () => void };
  // Accept-and-ignore the rest of sonner's option surface so call sites that
  // pass duration/etc. keep type-checking without special-casing.
  [key: string]: unknown;
}

type Message = string | number;

function emit(kind: StatusKind, message: Message, opts?: ToastOptions): string {
  return useStatusBar.getState().notify({
    kind,
    text: String(message),
    description: typeof opts?.description === "string" ? opts.description : undefined,
    action:
      opts?.action && typeof opts.action.onClick === "function"
        ? { label: String(opts.action.label), onClick: opts.action.onClick }
        : undefined,
    id: opts?.id,
  });
}

interface ToastFn {
  (message: Message, opts?: ToastOptions): string;
  success: (message: Message, opts?: ToastOptions) => string;
  error: (message: Message, opts?: ToastOptions) => string;
  warning: (message: Message, opts?: ToastOptions) => string;
  info: (message: Message, opts?: ToastOptions) => string;
  message: (message: Message, opts?: ToastOptions) => string;
  loading: (message: Message, opts?: ToastOptions) => string;
  dismiss: (id?: string) => void;
}

export const toast: ToastFn = Object.assign(
  (message: Message, opts?: ToastOptions) => emit("info", message, opts),
  {
    success: (message: Message, opts?: ToastOptions) => emit("success", message, opts),
    error: (message: Message, opts?: ToastOptions) => emit("error", message, opts),
    warning: (message: Message, opts?: ToastOptions) => emit("warning", message, opts),
    info: (message: Message, opts?: ToastOptions) => emit("info", message, opts),
    message: (message: Message, opts?: ToastOptions) => emit("info", message, opts),
    loading: (message: Message, opts?: ToastOptions) => emit("loading", message, opts),
    dismiss: (id?: string) => {
      if (id) useStatusBar.getState().dismiss(id);
    },
  },
);
