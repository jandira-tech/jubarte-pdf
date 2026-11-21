import { defineConfig } from "vite";

export default defineConfig({
  // The page imports the library's source and the built module from above.
  server: { fs: { allow: [".."] } },
  build: { outDir: "../.scratch/demo-dist", emptyOutDir: true },
});
