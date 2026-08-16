import assert from "node:assert/strict";
import { test } from "node:test";

import { sttFinalizeFlowStage } from "../src/observability/translation-flow.js";

void test("manual finalizeの理由を運用ログのstageへ対応付ける", () => {
  assert.equal(
    sttFinalizeFlowStage("speaking_end"),
    "stt_manual_finalize_speaking_end",
  );
  assert.equal(
    sttFinalizeFlowStage("transcript_inactivity"),
    "stt_manual_finalize_inactivity",
  );
  assert.equal(
    sttFinalizeFlowStage("max_turn_duration"),
    "stt_manual_finalize_max_duration",
  );
});
