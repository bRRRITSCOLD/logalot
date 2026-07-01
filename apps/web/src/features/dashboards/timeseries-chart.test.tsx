import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PanelBucket } from './panel-data';
import { TimeseriesChart } from './timeseries-chart';

function bucket(bucketStart: string, count: number): PanelBucket {
  return { bucketStart, count };
}

const series: PanelBucket[] = [
  bucket('2026-06-27T10:00:00Z', 1),
  bucket('2026-06-27T10:05:00Z', 4),
  bucket('2026-06-27T10:10:00Z', 2),
];

describe('TimeseriesChart', () => {
  it('renders one bar per bucket in the series', () => {
    render(<TimeseriesChart series={series} />);
    const bars = screen.getAllByTestId('timeseries-bar');
    expect(bars).toHaveLength(series.length);
  });

  it('shows the empty state for an empty series', () => {
    render(<TimeseriesChart series={[]} />);
    expect(screen.getByText(/no data/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId('timeseries-bar')).toHaveLength(0);
  });

  it('shows a loading state, ignoring any series prop', () => {
    render(<TimeseriesChart series={series} state="loading" />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryAllByTestId('timeseries-bar')).toHaveLength(0);
  });

  it('shows an error state with the given message', () => {
    render(<TimeseriesChart series={series} state="error" errorMessage="panel query not found" />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('panel query not found')).toBeInTheDocument();
  });

  it('applies severity coloring to bars above the warn/error thresholds', () => {
    render(
      <TimeseriesChart
        series={[bucket('2026-06-27T10:00:00Z', 1)]}
        errorThreshold={1}
        warnThreshold={0}
      />,
    );
    const bar = screen.getByTestId('timeseries-bar');
    expect(bar.getAttribute('fill')).toContain('severity-error');
  });
});
