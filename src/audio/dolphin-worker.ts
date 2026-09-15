import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";

export class DolphinWorker {
  readonly #child: ChildProcessWithoutNullStreams;
  #reply: { resolve: (text: string) => void; reject: (error: Error) => void } | undefined;
  #failure: Error | undefined;
  #closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) { this.#child = child; }

  public static async start(command = "/opt/dolphin/worker", args = [
    "/opt/dolphin/model.int8.onnx", "/opt/dolphin/tokens.txt",
  ]): Promise<DolphinWorker> {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, LANG: "C.UTF-8" } });
    const worker = new DolphinWorker(child);
    let buffered = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 40_001) { worker.#fail(new Error("補助認識の応答が上限を超えました")); return; }
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const reply = worker.#reply;
        if (!reply) { worker.#fail(new Error("補助認識から予期しない応答を受信しました")); return; }
        worker.#reply = undefined;
        reply.resolve(line);
      }
    });
    // Native diagnostics may contain speech; they never enter application logs.
    child.stderr.resume();
    child.on("error", () => worker.#fail(new Error("補助認識を起動できませんでした")));
    child.stdin.on("error", () => worker.#fail(new Error("補助認識への音声送信に失敗しました")));
    child.once("exit", () => { if (!worker.#closed) worker.#fail(new Error("補助認識が予期せず終了しました")); });
    const timer = setTimeout(() => worker.#fail(new Error("補助認識の起動がタイムアウトしました")), 30_000);
    try {
      const ready = await new Promise<string>((resolve, reject) => { worker.#reply = { resolve, reject }; });
      if (ready !== "READY") throw new Error("補助認識の起動応答が不正です");
      // Populate lazy native allocations before accepting the first live turn.
      await worker.transcribe(Buffer.alloc(288_000));
      return worker;
    } catch (error) { await worker.close(); throw error; }
    finally { clearTimeout(timer); }
  }

  public async transcribe(pcm: Buffer): Promise<string> {
    if (this.#failure) throw this.#failure;
    if (this.#closed || this.#reply) throw new Error("補助認識を開始できません");
    if (!pcm.length || pcm.length > 288_000 || pcm.length % 2) throw new TypeError("補助認識のPCMが不正です");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(pcm.length);
    const timer = setTimeout(() => this.#fail(new Error("補助認識がタイムアウトしました")), 8_000);
    try {
      return await new Promise<string>((resolve, reject) => {
        this.#reply = { resolve, reject };
        this.#child.stdin.write(Buffer.concat([header, pcm]));
      });
    } finally { clearTimeout(timer); }
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#reply?.reject(new DOMException("補助認識を終了しました", "AbortError"));
    this.#reply = undefined;
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const ended = once(this.#child, "exit");
    this.#child.kill("SIGTERM");
    const timer = setTimeout(() => this.#child.kill("SIGKILL"), 3_000);
    try { await ended; } finally { clearTimeout(timer); }
  }

  #fail(error: Error): void {
    if (this.#failure || this.#closed) return;
    this.#failure = error;
    this.#reply?.reject(error);
    this.#reply = undefined;
    this.#child.kill("SIGTERM");
  }
}
