import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/cn';

// Button variants map 1:1 onto the semantic token layer: `variant` -> brand/status
// colors, `size` -> control heights (h-7/8/10 == semantic.size.control sm/md/lg on
// the 4px grid). Exported separately so a router <Link> can wear button styling
// without nesting an actual <button> (cva is the single source of these classes).
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg-base disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary:
          'bg-brand-solid text-fg-on-brand hover:bg-brand-solid-hover active:bg-brand-solid-active',
        secondary: 'border border-border-default bg-bg-elevated text-fg-default hover:bg-bg-hover',
        ghost: 'text-fg-default hover:bg-bg-hover',
        danger: 'bg-status-danger text-fg-on-brand hover:opacity-90',
        link: 'text-fg-link underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-7 px-2.5 text-sm',
        md: 'h-8 px-3 text-base',
        lg: 'h-10 px-4 text-md',
        icon: 'h-8 w-8 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      // Default to type="button": an unspecified button inside a form submits it,
      // which is a classic accidental-submit footgun.
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
