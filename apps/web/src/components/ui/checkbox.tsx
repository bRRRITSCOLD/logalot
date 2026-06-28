import * as React from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxFieldProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Visible, programmatically-associated label. Required for accessibility. */
  label: string;
  description?: string;
}

// Accessible labeled checkbox built on the native control (keyboard + screen-reader
// semantics come free). Used for boolean flags like an alert rule's `enabled`.
export const CheckboxField = React.forwardRef<HTMLInputElement, CheckboxFieldProps>(
  ({ label, description, id, className, ...props }, ref) => {
    const autoId = React.useId();
    const fieldId = id ?? autoId;
    const descId = `${fieldId}-description`;

    return (
      <div className="flex items-start gap-2.5">
        <input
          id={fieldId}
          ref={ref}
          type="checkbox"
          aria-describedby={description ? descId : undefined}
          className={cn(
            'mt-0.5 size-4 shrink-0 rounded-input border border-border-default bg-bg-inset accent-brand-solid',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus',
            'disabled:cursor-not-allowed disabled:opacity-50',
            className,
          )}
          {...props}
        />
        <div className="flex flex-col gap-0.5">
          <label htmlFor={fieldId} className="font-medium text-fg-default text-sm">
            {label}
          </label>
          {description ? (
            <p id={descId} className="text-fg-muted text-xs">
              {description}
            </p>
          ) : null}
        </div>
      </div>
    );
  },
);
CheckboxField.displayName = 'CheckboxField';
