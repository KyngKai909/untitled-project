import type { Channel, PlaylistItem } from "./types";

export interface CreatorProfile {
  displayName: string;
  handle: string;
  bio: string;
  followers: number;
}

export interface BroadcastSlot {
  id: string;
  title: string;
  kind: "Program" | "Ad";
  durationSec: number;
  startsAt: Date;
}

function seedFromString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function shortDescription(description: string, fallback: string): string {
  if (!description.trim()) {
    return fallback;
  }
  if (description.length <= 120) {
    return description;
  }
  return `${description.slice(0, 117)}...`;
}

export function deriveCreatorProfile(channel: Channel): CreatorProfile {
  const baseName = channel.playerLabel?.trim() || channel.name;
  const followers = 500 + (seedFromString(channel.id) % 24500);

  return {
    displayName: `${baseName} Studios`,
    handle: `@${channel.slug}`,
    followers,
    bio: shortDescription(
      channel.description,
      "Independent creator building a 24/7 station with curated programming."
    )
  };
}

export function estimateViewerCount(channelId: string, isLive: boolean): number {
  if (!isLive) {
    return 0;
  }

  return 24 + (seedFromString(channelId) % 1700);
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) {
    return "Duration unknown";
  }

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours <= 0) {
    return `${minutes}m`;
  }

  if (minutes <= 0) {
    return `${hours}h`;
  }

  return `${hours}h ${minutes}m`;
}

export function formatCalendarDate(input: string): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function formatClockTime(input: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(input);
}

export function buildBroadcastSchedule(input: {
  playlist: PlaylistItem[];
  queueIndex: number;
  limit?: number;
  defaultProgramDurationSec?: number;
  defaultAdDurationSec?: number;
  startsAt?: string | number | Date;
}): BroadcastSlot[] {
  const {
    playlist,
    queueIndex,
    limit = 8,
    defaultProgramDurationSec = 1800,
    defaultAdDurationSec = 120,
    startsAt
  } = input;

  if (!playlist.length) {
    return [];
  }

  const startIndex = Math.max(0, queueIndex) % playlist.length;
  const slots: BroadcastSlot[] = [];
  const parsedStartsAt =
    startsAt instanceof Date
      ? startsAt.getTime()
      : typeof startsAt === "string" || typeof startsAt === "number"
        ? Date.parse(String(startsAt))
        : Number.NaN;
  let cursor = Number.isFinite(parsedStartsAt) ? parsedStartsAt : Date.now();

  for (let offset = 0; offset < limit; offset += 1) {
    const item = playlist[(startIndex + offset) % playlist.length];
    const durationSec =
      item.asset.durationSec ?? (item.asset.type === "ad" ? defaultAdDurationSec : defaultProgramDurationSec);

    slots.push({
      id: `${item.id}-${offset}`,
      title: item.asset.title,
      kind: item.asset.type === "ad" ? "Ad" : "Program",
      durationSec,
      startsAt: new Date(cursor)
    });

    cursor += durationSec * 1000;
  }

  return slots;
}
