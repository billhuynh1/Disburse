import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        data-slot="input"
        className={cn(
          "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-10 w-full min-w-0 rounded-lg border border-border/70 bg-input px-3 py-1 text-base shadow-[inset_0_1px_0_rgba(255,255,255,0.018)] transition-[color,box-shadow,background-color,border-color] outline-none file:cursor-pointer file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          type === "file" && "cursor-pointer",
          "focus-visible:border-ring/50 focus-visible:ring-ring/25 focus-visible:ring-[3px]",
          "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          className
        )}
        {...props}
      />
    );
  }
);

Input.displayName = "Input";

export { Input };
