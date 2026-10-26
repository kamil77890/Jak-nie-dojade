import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Wspólny pakiet jest źródłem TS, więc wchodzi do bundla produkcyjnego.
  noExternal: ["@pas/shared"],
});
