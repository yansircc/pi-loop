import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: { ignorePatterns: ["dist/**"] },
  lint: {
    ignorePatterns: ["dist/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: false },
  },
  test: { include: ["test-suite/**/*.test.ts"] },
  run: {
    tasks: {
      build: { command: "pnpm run pi:build", cache: false },
      typecheck: { command: "tsc --noEmit", cache: false },
      "lint:effect": {
        command: "effect-scan . --strict --output gate-json --evidence .effect-evidence",
        cache: false,
      },
      "package:artifact": { command: "pnpm run pi:distribution-check", cache: false },
      quality: {
        command: ["vp check", "vp run typecheck", "vp test", "vp run lint:effect"],
        cache: false,
      },
    },
  },
});
