import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .cerebro/ is the cerebro harness (a submodule) and the links into it; it is not Beacon code.
  { ignores: ["dist/", "node_modules/", ".cerebro/", ".claude/", ".github/agents/", ".github/hooks/", ".github/skills/"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["eslint.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
