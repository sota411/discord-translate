export class SpeakerVoiceAssignments {
  readonly #voices: readonly string[];
  readonly #assignments = new Map<string, string>();

  public constructor(voices: readonly string[]) {
    if (voices.length === 0 || new Set(voices).size !== voices.length) {
      throw new Error("話者voiceには重複しないIDを1件以上指定してください。");
    }
    this.#voices = [...voices];
  }

  public updateParticipants(userIds: readonly string[]): void {
    if (userIds.length > this.#voices.length) {
      throw new Error("参加者数に必要な話者voiceがありません。");
    }
    const active = new Set(userIds);
    for (const userId of this.#assignments.keys()) {
      if (!active.has(userId)) this.#assignments.delete(userId);
    }
    const used = new Set(this.#assignments.values());
    for (const userId of userIds) {
      if (this.#assignments.has(userId)) continue;
      const voice = this.#voices.find((candidate) => !used.has(candidate));
      if (!voice) throw new Error("参加者へ話者voiceを割り当てられませんでした。");
      this.#assignments.set(userId, voice);
      used.add(voice);
    }
  }

  public get(userId: string): string {
    const voice = this.#assignments.get(userId);
    if (!voice) throw new Error("参加者に話者voiceが割り当てられていません。");
    return voice;
  }
}
