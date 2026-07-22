import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../lib";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-lg border border-white/10 bg-white/6 px-3 py-2 text-sm font-medium text-slate-100 transition hover:-translate-y-px hover:border-amber-400/60 hover:bg-white/10",
  {
    variants: {
      variant: {
        default: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { className, variant, ...props },
  ref,
) {
  return <button className={cn(buttonVariants({ variant }), className)} ref={ref} {...props} />;
});
