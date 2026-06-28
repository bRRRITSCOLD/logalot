import * as React from 'react';
import { cn } from '../../lib/cn';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

// Styled native input. Used standalone or rendered into a Base UI <Field.Control>
// (see text-field.tsx) which supplies the accessible label/error wiring. The
// aria-invalid hook lets the error state restyle the border without extra props.
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-8 w-full rounded-input border border-border-default bg-bg-inset px-2.5 text-base text-fg-default transition-colors',
        'placeholder:text-fg-subtle',
        'focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-severity-error-border aria-[invalid=true]:ring-severity-error-border',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
