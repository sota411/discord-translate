import assert from "node:assert/strict";
import { test } from "node:test";

import { SpeakerVoiceAssignments } from "../src/session/speaker-voice-assignments.js";

void test("参加中の3人へ異なる多言語voiceを固定し、退出枠を新規参加者へ再利用する", () => {
  const assignments = new SpeakerVoiceAssignments(["voice-1", "voice-2", "voice-3"]);
  assignments.updateParticipants(["user-a", "user-b", "user-c"]);

  assert.equal(assignments.get("user-a"), "voice-1");
  assert.equal(assignments.get("user-b"), "voice-2");
  assert.equal(assignments.get("user-c"), "voice-3");

  assignments.updateParticipants(["user-c", "user-a", "user-d"]);
  assert.equal(assignments.get("user-a"), "voice-1");
  assert.equal(assignments.get("user-c"), "voice-3");
  assert.equal(assignments.get("user-d"), "voice-2");
  assert.throws(() => assignments.get("user-b"), /割り当て/u);
});
