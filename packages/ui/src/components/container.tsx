import * as React from "react";
import { cn } from "../lib/cn";

/** Centered page container — the single source of horizontal rhythm (design.md §4). */
function Container({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("mx-auto w-full max-w-[1200px] px-6 md:px-8", className)}
      {...props}
    />
  );
}

export { Container };
