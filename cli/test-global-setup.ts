/** 全単体試験の開始前に、現在のソースから子プロセス用CLIを1回ビルドする。 */
import { build } from "esbuild";
export default async function setup(): Promise<void> {
  await build({ entryPoints: ["cli/main.ts"], bundle: true, loader: { ".md": "text" }, platform: "node", format: "esm", target: "node18",
    external: ["@modelcontextprotocol/sdk", "zod"], outfile: "bin/boxglow.js", banner: { js: "#!/usr/bin/env node" } });
}
