import { type ComponentProps } from "react";

import { cn } from "../../lib";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return (
    <div className={cn("rounded-2xl border border-white/10 bg-white/5", className)} {...props} />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex items-center justify-between gap-3", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-sm font-semibold tracking-[0.02em] text-slate-100", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(className)} {...props} />;
}
