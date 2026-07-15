import { build } from "vite-plus";
import config from "./config.mjs";
import { isAllowedExternal, readDistributionContract } from "./distribution-contract.mjs";

const contract = readDistributionContract();

await build({
  configFile: false,
  root: contract.root,
  ssr: { noExternal: true },
  build: {
    ssr: config.source,
    target: config.target,
    outDir: contract.outputDirectory,
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    rolldownOptions: {
      external: isAllowedExternal,
      output: { entryFileNames: contract.outputFileName, format: "esm" },
    },
  },
});
