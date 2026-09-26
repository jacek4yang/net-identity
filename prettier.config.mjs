/** @type {import("prettier").Config} */
export default {
  printWidth: 100,
  tabWidth: 2,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  arrowParens: "always",
  endOfLine: "lf",
  overrides: [
    {
      files: ["*.json", "*.jsonc"],
      options: { printWidth: 120 },
    },
  ],
};
