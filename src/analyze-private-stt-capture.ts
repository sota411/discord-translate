import { analyzePrivateSttCapture } from "./diagnostics/private-stt-capture-analysis.js";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1 || arguments_[0] === undefined) {
  process.stderr.write(
    "usage: pnpm stt:capture:analyze -- /absolute/path/to/capture-<uuid>\n",
  );
  process.exitCode = 1;
} else {
  const analysis = await analyzePrivateSttCapture(arguments_[0]);
  process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
}
