import type { Platform } from "../types.js";
import type { PlatformAdapter } from "./base.js";
import { instagramAdapter } from "./instagram.js";
import { linkedinAdapter } from "./linkedin.js";
import { tiktokAdapter } from "./tiktok.js";
import { xAdapter } from "./x.js";
import { youtubeAdapter } from "./youtube.js";

/**
 * The single place a new platform gets wired in. Add an adapter here and it is
 * immediately reachable from every tool.
 */
export const ADAPTERS: Record<Platform, PlatformAdapter> = {
  instagram: instagramAdapter,
  youtube: youtubeAdapter,
  tiktok: tiktokAdapter,
  x: xAdapter,
  linkedin: linkedinAdapter,
};

export function adapterFor(platform: Platform): PlatformAdapter {
  const adapter = ADAPTERS[platform];
  if (!adapter) {
    throw new Error(`No adapter registered for platform "${platform}".`);
  }
  return adapter;
}

export type { PlatformAdapter } from "./base.js";
