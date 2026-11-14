"use client";

import { createJobQueue, isJobFinished } from "@solomotion/core";

/**
 * THE RENDER LINE — every export this tab makes, from the panel or from any
 * agent, waits here for the one before it. Renders share one thread and one
 * GPU; two at once is not twice the throughput, it is two exports each too
 * slow to finish (six agent exports sent together all timed out). An agent's
 * export answers with its job id at once and is collected with `export.wait`.
 */
export const renderJobs = createJobQueue<unknown>({ prefix: "export" });

/** Something is rendering or waiting to. */
export const renderLineBusy = (): boolean => renderJobs.list().some((j) => !isJobFinished(j));
