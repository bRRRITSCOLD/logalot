import { Dialog as BaseDialog } from '@base-ui-components/react/dialog';
import type * as React from 'react';
import { cn } from '../../lib/cn';

// Accessible modal dialog built on Base UI <Dialog>. The primitive owns the hard
// parts — focus trap + restore, Escape-to-close, `role="dialog"`,
// aria-labelledby/-describedby wiring, and scroll locking — so we never hand-roll
// them. Styling is entirely token-driven.

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </BaseDialog.Root>
  );
}

export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

export interface DialogContentProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function DialogContent({ title, description, children, className }: DialogContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="fixed inset-0 z-modal bg-bg-overlay" />
      <BaseDialog.Popup
        className={cn(
          'fixed top-1/2 left-1/2 z-modal flex w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-4',
          'rounded-card border border-border-default bg-bg-surface p-5 shadow-lg',
          'max-h-[90svh] overflow-y-auto',
          className,
        )}
      >
        <div className="flex flex-col gap-1">
          <BaseDialog.Title className="font-semibold text-fg-default text-lg">
            {title}
          </BaseDialog.Title>
          {description ? (
            <BaseDialog.Description className="text-fg-muted text-sm">
              {description}
            </BaseDialog.Description>
          ) : null}
        </div>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

/** Standard footer row for dialog actions (right-aligned). */
export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center justify-end gap-2 pt-1', className)} {...props} />;
}
