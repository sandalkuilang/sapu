import { configDefaults, defineConfig } from "vitest/config";

// Agent worktrees under .claude/ hold copies of the tests; never run them from here.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, ".claude/**"] },
});
