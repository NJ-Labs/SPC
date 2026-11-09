import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';
import 'vitest';

// Vitest 5 uses Matchers for custom assertions and carries their sync/async return type.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Module augmentation.
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown>
    extends TestingLibraryMatchers<T, R> {}
}
