import { promises as fs } from "node:fs";
import path from "node:path";
import type { MediaInput, PostContent } from "../types.js";
import { ValidationError } from "./errors.js";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
};

export function mimeFor(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export async function statMedia(
  media: MediaInput,
): Promise<{ size: number; mime: string; path: string }> {
  if (!media.path) {
    throw new ValidationError(
      "This platform needs a local file (media.path); only a URL was supplied.",
    );
  }
  const resolved = path.resolve(media.path);
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new ValidationError(`Media file not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new ValidationError(`Media path is not a file: ${resolved}`);
  }
  return { size: stat.size, mime: mimeFor(resolved), path: resolved };
}

export function requireUrl(media: MediaInput, platform: string): string {
  if (!media.url) {
    throw new ValidationError(
      `${platform} can only ingest media from a public URL. ` +
        `Host the file somewhere reachable and pass media[].url ` +
        `(a local path cannot be uploaded to this endpoint).`,
    );
  }
  return media.url;
}

export function firstVideo(content: PostContent): MediaInput | undefined {
  return content.media?.find((m) => m.kind === "video");
}

export function images(content: PostContent): MediaInput[] {
  return content.media?.filter((m) => m.kind === "image") ?? [];
}

/**
 * Builds the caption a platform should receive: body text plus hashtags,
 * trimmed to the platform's limit. Returns the text and whether it was cut.
 */
export function composeCaption(
  content: PostContent,
  opts: {
    limit: number;
    /** Include the topic as a leading line. */
    includeTopic?: boolean;
    hashtagLimit?: number;
  },
): { text: string; truncated: boolean } {
  const parts: string[] = [];
  if (opts.includeTopic && content.topic) parts.push(content.topic);
  if (content.description) parts.push(content.description);

  let text = parts.join("\n\n");

  const tags = (content.hashtags ?? [])
    .slice(0, opts.hashtagLimit ?? 30)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
  if (tags.length) {
    text = text ? `${text}\n\n${tags.join(" ")}` : tags.join(" ");
  }

  if (text.length <= opts.limit) return { text, truncated: false };
  // Cut on a word boundary and leave room for the ellipsis.
  const cut = text.slice(0, opts.limit - 1);
  const boundary = cut.lastIndexOf(" ");
  const safe = boundary > opts.limit * 0.6 ? cut.slice(0, boundary) : cut;
  return { text: `${safe}…`, truncated: true };
}

export async function readFileChunk(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
