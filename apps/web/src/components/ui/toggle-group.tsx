"use client";

import * as React from "react";
import * as ToggleGroupPrimitive from "@radix-ui/react-toggle-group";
import { type VariantProps } from "class-variance-authority";
import { toggleVariants } from "@/components/ui/toggle";
import { cn } from "@/lib/utils";

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: "default",
  variant: "default",
});

function ToggleGroup({
  className,
  variant,
  size,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <ToggleGroupPrimitive.Root
      className={cn(
        // WRAPS rather than clips. A segmented control is as wide as its
        // longest labels, and in a narrow panel or dialog row that is regularly
        // wider than the space it is given — where the last option would simply
        // be cut off the edge with no way to reach it. Two short rows is a
        // worse-looking control and a working one. `max-w-full` is what lets
        // the wrap happen at all; without it the group sizes to its content and
        // takes the panel's scrollbar with it.
        //
        // The wrap lives HERE and not as a `shrink-0` on the item, deliberately.
        // Four call sites give their items `flex-1`, and `shrink-0` beside
        // `flex-1` is two utilities in different tailwind-merge groups settling
        // it by stylesheet order — a rule that works until someone reorders the
        // build. Items keep their default flex; the container decides.
        "flex min-w-0 max-w-full flex-wrap items-center justify-center gap-1",
        className,
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>{children}</ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item> & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext);
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        toggleVariants({ variant: context.variant || variant, size: context.size || size }),
        className,
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
