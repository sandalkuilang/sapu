import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees under .claude/ hold copies of the tests; never run them from here. Fixtures are data the
// tests read (the generated RED test's golden file is a Playwright spec, not a vitest one).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**", "tests/fixtures/**"] },
});
