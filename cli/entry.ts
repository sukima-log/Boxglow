/** bin/boxglow.js の入口: コマンドラインの引数で CLI を動かす (main.ts は読み込んでも何もしない。Worker からも読める) */
import { cliMain } from "./main";
cliMain(process.argv.slice(2));
