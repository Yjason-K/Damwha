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
      // buttonVariants (shadcn/ui CVA pattern) is a non-primitive constant that
      // co-locates with Button. allowConstantExport only covers Literal/Unary/
      // Template/Binary, not CallExpression, so we explicitly allow this name.
      "react-refresh/only-export-components": [
        "error",
        { allowConstantExport: true, allowExportNames: ["buttonVariants"] },
      ],
    },
  },
]);
