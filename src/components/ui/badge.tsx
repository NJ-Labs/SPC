import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "../../lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border border-oklch(0.922 0 0) px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-hidden focus:ring-2 focus:ring-blue-500/50 focus:ring-oklch(0.708 0 0) focus:ring-offset-2 dark:border-oklch(1 0 0 / 10%) dark:focus:ring-oklch(0.556 0 0)",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-oklch(0.205 0 0) text-oklch(0.985 0 0) shadow-sm hover:bg-oklch(0.205 0 0)/80 dark:bg-oklch(0.922 0 0) dark:text-oklch(0.205 0 0) dark:hover:bg-oklch(0.922 0 0)/80",
        secondary:
          "border-transparent bg-oklch(0.97 0 0) text-oklch(0.205 0 0) hover:bg-oklch(0.97 0 0)/80 dark:bg-oklch(0.269 0 0) dark:text-oklch(0.985 0 0) dark:hover:bg-oklch(0.269 0 0)/80",
        destructive:
          "border-transparent bg-oklch(0.577 0.245 27.325) text-destructive-foreground shadow-sm hover:bg-oklch(0.577 0.245 27.325)/80 dark:bg-oklch(0.704 0.191 22.216) dark:hover:bg-oklch(0.704 0.191 22.216)/80",
        outline: "border-gray-200 text-oklch(0.145 0 0) dark:text-oklch(0.985 0 0)",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
