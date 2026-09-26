import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "artifacts/**", "node_modules/**", "coverage/**"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": ["error", { allow: ["error"] }],
      "no-var": "error",
      "prefer-const": "error",

      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Returning a Promise without awaiting anything inside is legitimate for the
      // small adapter objects used here (storage areas, settings, providers), so this
      // stylistic rule is disabled rather than sprinkling `await Promise.resolve()`.
      "@typescript-eslint/require-await": "off",
    },
  },

  {
    files: ["tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    // Build and tooling scripts are plain Node ESM and are not part of the typed
    // project, so type information is disabled for them. The two spreads are
    // deliberate: assigning `rules`/`languageOptions` directly would discard the
    // entries that `disableTypeChecked` contributes.
    files: ["scripts/**/*.mjs", "eslint.config.js", "prettier.config.mjs"],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { ...globals.node },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      "no-console": "off",
    },
  },

  prettier,
);
