import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The build writes into `docs/`, which is what the Worker serves and what the
 * site tests check. `emptyOutDir` is off on purpose: `docs/attestation/**`,
 * `docs/schema/**` and `docs/writing/**` are hand-written static files that
 * this build must never touch.
 *
 * Those three paths are deliberately NOT part of the React app. The predicate
 * URL is the `predicateType` string inside every receipt Provene has emitted
 * and the schemas are resolved by validators; both must answer a plain fetch
 * with no JavaScript. The writing is long-form prose that should survive an
 * archiver. React serves the homepage, where components actually pay.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../docs",
    emptyOutDir: false,
    assetsDir: "assets",
    // A stable filename keeps the committed build reviewable: a content diff
    // rather than a rename plus an addition on every change.
    rollupOptions: {
      output: {
        entryFileNames: "assets/site.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
