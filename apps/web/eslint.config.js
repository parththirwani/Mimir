import { nextJsConfig } from "@mimir/eslint-config/next-js";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...nextJsConfig,
  {
    rules: {
      // Design copy is written with literal apostrophes (see app/page.tsx, app/chat/page.tsx).
      "react/no-unescaped-entities": "off",
      // Fonts are loaded via <link> to Google Fonts (Archivo/DM Sans), matching the design.
      "@next/next/no-page-custom-font": "off",
    },
  },
];
