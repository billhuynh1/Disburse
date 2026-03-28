import * as React from "react";

import { cn } from "@/lib/utils";

function NativeSelect({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        "border-input flex h-10 w-full min-w-0 rounded-xl border bg-input/55 px-3 py-2 text-base shadow-[inset_0_1px_0_rgba(255,255,255,0.02)] transition-[color,box-shadow,border-color,background-color] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export { NativeSelect };
