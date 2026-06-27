import type { Clock } from '../../app/ports';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
