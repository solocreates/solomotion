"use client";

import { identity } from "@/editor/identity";
import {
  fingerprintOf,
  redactForUpload,
  type FeedbackBody,
  type FeedbackContext,
  type FeedbackEvent,
  type ToolDef,
} from "@solomotion/agent";
import { API_VERSION } from "@solomotion/core";
import { SKILL_VERSION } from "./bridge";
import { APP_VERSION } from "../version";
import { installId, useAgent } from "./store";

/**
 * The client half of the feedback loop: record every signal locally (the
 * Reports view reads these), and — when the user leaves sharing on — send a
 * redacted copy to the collector, batched and fire-and-forget. A failed upload
 * never bothers anyone; the local copy is the record.
 */

/** Same-origin on the web app; the product's hosted collector from a desktop build (none: kept local). */
const ENDPOINT =
  typeof window !== "undefined" && /^https?:$/.test(window.location.protocol) && !window.location.hostname.endsWith("localhost")
    ? "/api/agent/feedback"
    : identity.hosts.agentFeedback;

let queue: FeedbackEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  timer = null;
  const batch = queue.splice(0, 50);
  if (!batch.length || !ENDPOINT) return;
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: batch.map(redactForUpload) }),
    keepalive: true,
  }).catch(() => {});
  if (queue.length) timer = setTimeout(flush, 2000);
}

export function recordFeedback(body: FeedbackBody, context: Omit<FeedbackContext, "appVersion" | "apiVersion" | "skillVersion" | "installId">): FeedbackEvent {
  const event: FeedbackEvent = {
    ...body,
    id: `fb_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    fingerprint: fingerprintOf(body),
    context: { appVersion: APP_VERSION, apiVersion: API_VERSION, skillVersion: SKILL_VERSION, installId: installId(), ...context },
  };
  void useAgent.getState().addFeedback(event);
  if (useAgent.getState().settings.shareFeedback) {
    queue.push(event);
    timer ??= setTimeout(flush, 1500);
  }
  return event;
}

export const REPORT_TOOL: ToolDef = {
  name: "report_issue",
  description:
    `File a report so ${identity.name}'s API and skill improve. Call it whenever you could not do what was asked, a command did something other than its description, the skill taught you something wrong or missing, you made a mistake worth learning from, or the app misbehaved (console errors, a render that is wrong). Be specific and honest about fault — including your own. One report per distinct problem; do not report the same thing twice in a chat. The user sees that you reported; they do not need to approve it.`,
  inputSchema: {
    type: "object",
    properties: {
      category: { type: "string", enum: ["api-gap", "api-bug", "docs-mismatch", "agent-mistake", "app-bug", "feature-request"] },
      fault: { type: "string", enum: ["ours-api", "ours-docs", "ours-app", "model", "user", "provider", "unknown"] },
      severity: { type: "integer", minimum: 1, maximum: 5, description: "1 cosmetic · 3 had to work around it · 5 the task could not be done." },
      title: { type: "string", description: "Under 80 characters, specific: \"No verb to reorder effects inside a grade node\"." },
      tried: { type: "string", description: "What you were trying to do." },
      happened: { type: "string", description: "What actually happened — the mistake or the gap." },
      expected: { type: "string", description: "What should have happened." },
      suggestion: { type: "string", description: "The fix in API or skill terms." },
      command: { type: "string", description: "The command involved, if any." },
      error: { type: "string", description: "The exact error text, if any." },
    },
    required: ["category", "fault", "severity", "title", "tried", "happened", "expected"],
  },
  effect: "read",
};
