import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat["recommended-latest"],
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      // *Variants (shadcn/ui CVA pattern) are non-primitive constants co-located
      // with their component. allowConstantExport only covers Literal/Unary/
      // Template/Binary, not CallExpression, so we list these names explicitly.
      // Add new `<name>Variants` exports here as components are ported.
      // defaultLiveTitle is a plain function export co-located with
      // LiveStartDialog (unit-tested directly, same reasoning as *Variants).
      "react-refresh/only-export-components": [
        "error",
        {
          allowConstantExport: true,
          allowExportNames: [
            "buttonVariants",
            "badgeVariants",
            "cardVariants",
            "iconButtonVariants",
            "defaultLiveTitle",
          ],
        },
      ],
    },
  },
]);
