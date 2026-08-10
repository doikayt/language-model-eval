import { defineConfig } from "vitest/config";

// Seeded by `typescript-build-config init`. Vitest runs TypeScript with zero
// config, so everything here is optional — it exists as a signpost for the
// common knobs. Uncomment and adjust as your project needs.
export default defineConfig({
  test: {
    // include: ["src/**/*.test.ts"],
    // environment: "node", // or "jsdom" / "happy-dom" for DOM tests
    // coverage: { provider: "v8", reporter: ["text", "html"] },
  },
});
