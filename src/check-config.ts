import { ConfigError, loadConfig } from "./config.js";

try {
  loadConfig();
  console.log("設定は有効です。Botを起動できます。");
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  console.error(".env.localの設定を修正してください:");
  for (const issue of error.issues) {
    console.error(`- ${issue}`);
  }
  process.exitCode = 1;
}
