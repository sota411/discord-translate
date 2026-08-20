import {
  ComponentType,
  escapeMarkdown,
  type Collection,
} from "discord.js";

import { ApplicationError } from "../domain/application-error.js";
import { isFinalCaptionStatus } from "./message-payload.js";

type ExportableMessage = {
  id: string;
  author: { id: string };
  createdAt: Date;
  components: readonly { toJSON(): unknown }[];
};

export type ExportableThread = {
  id: string;
  name: string;
  messages: {
    fetch(options: {
      limit: number;
      cache: false;
      before?: string;
    }): Promise<Collection<string, ExportableMessage>>;
  };
};

export type ThreadMarkdownExport = {
  filename: string;
  markdown: string;
  byteLength: number;
  captionCount: number;
};

type CaptionExport = {
  createdAt: Date;
  header: string;
  source: string;
  target: string;
};

type DateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

export async function exportThreadToMarkdown(input: {
  thread: ExportableThread;
  botUserId: string;
  now?: () => Date;
}): Promise<ThreadMarkdownExport> {
  const messages: ExportableMessage[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await input.thread.messages.fetch({
      limit: 100,
      cache: false,
      ...(before === undefined ? {} : { before }),
    });
    messages.push(...page.values());
    if (page.size < 100) break;
    const oldest = page.last();
    if (!oldest) break;
    before = oldest.id;
  }

  const captions = messages
    .filter((message) => message.author.id === input.botUserId)
    .map(parseCaption)
    .filter((caption): caption is CaptionExport => caption !== undefined)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  if (captions.length === 0) {
    throw new ApplicationError(
      "EXPORT_EMPTY",
      "対象スレッドにエクスポートできる確定字幕がありません。",
    );
  }

  const now = (input.now ?? (() => new Date()))();
  const markdown = [
    "# Discord翻訳会話",
    "",
    `- スレッド: ${escapeMarkdown(input.thread.name)}`,
    `- 出力日時: ${formatDateTime(now)} JST`,
    `- 字幕件数: ${String(captions.length)}`,
    "",
    ...captions.flatMap((caption) => [
      `## ${formatDateTime(caption.createdAt)} JST`,
      "",
      caption.header,
      "",
      caption.source,
      "",
      caption.target,
      "",
    ]),
  ].join("\n");
  return {
    filename: `translation-export-${formatFileTimestamp(now)}.md`,
    markdown,
    byteLength: Buffer.byteLength(markdown, "utf8"),
    captionCount: captions.length,
  };
}

function parseCaption(message: ExportableMessage): CaptionExport | undefined {
  const contents = message.components.flatMap((component) =>
    collectTextDisplays(component.toJSON()));
  if (contents.length !== 4) return undefined;
  const [header, source, target, status] = contents;
  if (!header || !source || !target || !status) return undefined;
  const direction = /`([A-Z]{2}) → ([A-Z]{2})`$/u.exec(header);
  if (!direction?.[1] || !direction[2]) return undefined;
  if (!source.startsWith(`**${direction[1]}**\n`)) return undefined;
  if (!target.startsWith(`**${direction[2]}**\n`)) return undefined;
  if (!isFinalCaptionStatus(status)) return undefined;
  return { createdAt: message.createdAt, header, source, target };
}

function collectTextDisplays(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (
    value.type === ComponentType.TextDisplay &&
    typeof value.content === "string"
  ) {
    return [value.content];
  }
  return Array.isArray(value.components)
    ? value.components.flatMap(collectTextDisplays)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function dateParts(at: Date): DateParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at).map((part) => [part.type, part.value]));
  const { year, month, day, hour, minute, second } = values;
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error("日時をAsia/Tokyo形式へ変換できませんでした");
  }
  return { year, month, day, hour, minute, second };
}

function formatDateTime(at: Date): string {
  const parts = dateParts(at);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatFileTimestamp(at: Date): string {
  const parts = dateParts(at);
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}${parts.second}`;
}
