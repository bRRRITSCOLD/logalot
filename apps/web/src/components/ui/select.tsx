import * as React from 'react';
import { cn } from '../../lib/cn';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps
  extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** Visible, programmatically-associated label. Required for accessibility. */
  label: string;
  description?: string;
  error?: string;
  rootClassName?: string;
  /** Convenience option list; alternatively pass <option> children via `children`. */
  options?: SelectOption[];
  children?: React.ReactNode;
}

// Accessible native <select> field. A native control is itself an accessible
// primitive (keyboard, focus, screen-reader semantics come free), so we only wire
// the label/description/error associations explicitly. Styling matches <Input>.
export const SelectField = React.forwardRef<HTMLSelectElement, SelectFieldProps>(
  (
    { label, description, error, options, children, id, className, rootClassName, ...props },
    ref,
  ) => {
    const autoId = React.useId();
    const fieldId = id ?? autoId;
    const errorId = `${fieldId}-error`;
    const descId = `${fieldId}-description`;

    return (
      <div className={cn('flex flex-col gap-1.5', rootClassName)}>
        <label htmlFor={fieldId} className="font-medium text-fg-default text-sm">
          {label}
        </label>
        <select
          id={fieldId}
          ref={ref}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : description ? descId : undefined}
          className={cn(
            'h-8 w-full rounded-input border border-border-default bg-bg-inset px-2.5 text-base text-fg-default transition-colors',
            'focus-visible:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'aria-[invalid=true]:border-severity-error-border aria-[invalid=true]:ring-severity-error-border',
            className,
          )}
          {...props}
        >
          {options
            ? options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            : children}
        </select>
        {error ? (
          <p id={errorId} className="text-severity-error-fg text-xs">
            {error}
          </p>
        ) : description ? (
          <p id={descId} className="text-fg-muted text-xs">
            {description}
          </p>
        ) : null}
      </div>
    );
  },
);
SelectField.displayName = 'SelectField';
