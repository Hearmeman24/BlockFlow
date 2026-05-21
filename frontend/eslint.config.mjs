import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated block modules — fixing the rule on these is no-op because
    // the source-of-truth is `custom_blocks/*/frontend.block.tsx` and the
    // generator overwrites changes on every predev/prebuild.
    "src/components/pipeline/custom_blocks/generated/**",
    "src/components/pipeline/custom_blocks/generated_private/**",
  ]),
  {
    // The React 19 `react-hooks/set-state-in-effect` rule flags any
    // synchronous setState call inside useEffect. That's a useful signal
    // for spotting "you might not need an effect" anti-patterns, but it
    // also fires on legitimate cases this codebase uses (URL.createObjectURL
    // with its required revokeObjectURL cleanup; clamping state when props
    // change is a fix for the source — but the rule fires on the
    // before-state too). Treat it as a warning so the signal stays visible
    // without blocking merges. Tracked under sgs-ui-wisp-las.13 follow-up.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
