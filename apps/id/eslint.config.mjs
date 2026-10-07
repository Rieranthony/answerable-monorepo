import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-duplicate-imports": "error",
    },
  },
  {
    ignores: ["coverage/**", "dist/**"],
  },
);
