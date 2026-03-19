import * as SeparatorPrimitive from "@radix-ui/react-separator";

import { cn } from "../../lib";

export function Separator({ className }: { className?: string }) {
  return (
    <SeparatorPrimitive.Root
      className={cn("h-px w-full bg-white/10", className)}
      decorative
      orientation="horizontal"
    />
  );
}
