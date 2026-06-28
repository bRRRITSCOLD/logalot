import { GapRow, LogRow } from './log-row';
import type { TailItem } from './use-log-tail';

// Renders an ordered list of tail items (log lines + gap markers) as table rows.
// Pure: no streaming/scroll logic, so #22's search results render through the exact
// same component. The owner provides the scroll container around it.

export interface LogListProps {
  items: TailItem[];
}

export function LogList({ items }: LogListProps) {
  return (
    <div className="flex flex-col">
      {items.map((item) =>
        item.kind === 'log' ? (
          <LogRow key={item.seq} event={item.event} />
        ) : (
          <GapRow key={item.seq} reason={item.reason} dropped={item.dropped} />
        ),
      )}
    </div>
  );
}
