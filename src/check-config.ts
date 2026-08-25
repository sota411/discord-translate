import { ConfigError, loadConfig } from "./config.js";
import { loadTranslationTerms } from "./config/translation-terms.js";

try {
  const config = loadConfig();
  loadTranslationTerms(
    config.storage.translationTermsPath,
    config.soniox.generalContextEnabled,
  );
  console.log("設定は有効です。Botを起動できます。");
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(".env.localの設定を修正してください:");
    for (const issue of error.issues) {
      console.error(`- ${issue}`);
    }
  } else if (error instanceof Error) {
    console.error("起動前の設定確認に失敗しました:");
    console.error(`- ${error.message}`);
  } else {
    throw error;
  }
  process.exitCode = 1;
}
