import { Field } from '@base-ui-components/react/field';
import * as React from 'react';
import { cn } from '../../lib/cn';
import { Input, type InputProps } from './input';

export interface TextFieldProps extends InputProps {
  /** Visible, programmatically-associated label. Required for accessibility. */
  label: string;
  /** Optional helper text shown below the control when there is no error. */
  description?: string;
  /** Error message; when set, the field is marked invalid and the message announced. */
  error?: string;
  /** Class applied to the Field.Root wrapper (layout), not the input. */
  rootClassName?: string;
}

// Accessible text field built on Base UI <Field>. The primitive wires the label's
// htmlFor, the control's id, aria-invalid, and aria-describedby (-> error or
// description) automatically — we never hand-roll those associations.
export const TextField = React.forwardRef<HTMLInputElement, TextFieldProps>(
  ({ label, description, error, className, rootClassName, ...props }, ref) => (
    <Field.Root invalid={Boolean(error)} className={cn('flex flex-col gap-1.5', rootClassName)}>
      <Field.Label className="text-sm font-medium text-fg-default">{label}</Field.Label>
      <Field.Control ref={ref} render={<Input className={className} />} {...props} />
      {error ? (
        // `match` keeps the message visible while we own validity externally
        // (e.g. via TanStack Form / server errors).
        <Field.Error match className="text-xs text-severity-error-fg">
          {error}
        </Field.Error>
      ) : description ? (
        <Field.Description className="text-xs text-fg-muted">{description}</Field.Description>
      ) : null}
    </Field.Root>
  ),
);
TextField.displayName = 'TextField';
