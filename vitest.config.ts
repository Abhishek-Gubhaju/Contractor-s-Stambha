import { defineConfig } from 'vitest/config';

// Tests run pinned to Kathmandu so local midnight == Kathmandu midnight,
// making exact round-trip assertions deterministic.
export default defineConfig({
  test: {
    globals: true,
    env: { TZ: 'Asia/Kathmandu' },
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
