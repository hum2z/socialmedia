import { ValidationError } from "../util/errors.js";

/** True when the string carries an explicit UTC offset or Z. */
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const RELATIVE = /^\+\s*(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i;
const BARE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Offset of a named zone at a given instant, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(instant)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asIfUtc - instant.getTime();
}

function assertZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new ValidationError(
      `"${timeZone}" is not a recognized IANA time zone. Use a name like "Europe/London" or "America/New_York".`,
    );
  }
}

export interface ResolvedTime {
  /** Absolute instant, always UTC. */
  iso: string;
  /** What the user typed, kept for display. */
  requested: string;
  /** How the input was interpreted, so an ambiguous entry can be caught. */
  interpretation: string;
  warnings: string[];
}

/**
 * Turns a user-supplied time into an absolute instant.
 *
 * Accepts an ISO-8601 timestamp with an offset (unambiguous), a bare
 * wall-clock time plus an IANA `timezone`, or a relative offset like "+2h".
 * A bare time with no zone is read as the server's local time and warned
 * about, because that is the mistake that posts at the wrong hour.
 */
export function resolveWhen(input: string, timeZone?: string): ResolvedTime {
  const raw = input.trim();
  if (!raw) throw new ValidationError("A scheduled time is required.");
  const warnings: string[] = [];

  const relative = raw.match(RELATIVE);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms = unit.startsWith("m")
      ? amount * 60_000
      : unit.startsWith("h")
        ? amount * 3_600_000
        : unit.startsWith("d")
          ? amount * 86_400_000
          : amount * 7 * 86_400_000;
    const iso = new Date(Date.now() + ms).toISOString();
    return {
      iso,
      requested: raw,
      interpretation: `${amount} ${unit} from now → ${iso}`,
      warnings,
    };
  }

  if (HAS_OFFSET.test(raw)) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
      throw new ValidationError(`Could not parse "${raw}" as a timestamp.`);
    }
    if (timeZone) {
      warnings.push(
        `The timestamp already carries its own offset, so the "${timeZone}" timezone argument was ignored.`,
      );
    }
    return {
      iso: new Date(parsed).toISOString(),
      requested: raw,
      interpretation: `explicit offset → ${new Date(parsed).toISOString()}`,
      warnings,
    };
  }

  const bare = raw.match(BARE_LOCAL);
  if (!bare) {
    throw new ValidationError(
      `Could not read "${raw}" as a time. Use an ISO-8601 timestamp ` +
        `("2026-09-01T15:00:00Z" or "2026-09-01T15:00:00+02:00"), ` +
        `a wall-clock time with a timezone ("2026-09-01 15:00" + timezone: "Europe/Berlin"), ` +
        `or a relative offset ("+2h").`,
    );
  }

  const [, y, mo, d, h, mi, sec] = bare;
  const wallClockAsUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec ?? 0),
  );

  if (timeZone) {
    assertZone(timeZone);
    // Two passes: the first offset may be wrong across a DST boundary.
    let instant = wallClockAsUtc - zoneOffsetMs(new Date(wallClockAsUtc), timeZone);
    instant = wallClockAsUtc - zoneOffsetMs(new Date(instant), timeZone);
    const iso = new Date(instant).toISOString();
    return {
      iso,
      requested: raw,
      interpretation: `${raw} in ${timeZone} → ${iso}`,
      warnings,
    };
  }

  // No zone given: fall back to this machine's local time, and say so.
  const local = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec ?? 0),
  );
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local time";
  warnings.push(
    `"${raw}" has no timezone, so it was read as ${localZone} (the server's zone) → ${local.toISOString()}. ` +
      `Pass a timezone, or an ISO timestamp with an offset, to remove the ambiguity.`,
  );
  return {
    iso: local.toISOString(),
    requested: raw,
    interpretation: `${raw} in ${localZone} → ${local.toISOString()}`,
    warnings,
  };
}

/** Human-friendly "in 3 hours" / "2 days ago" for listings. */
export function relativeToNow(iso: string, now = Date.now()): string {
  const delta = Date.parse(iso) - now;
  const abs = Math.abs(delta);
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const value = Math.round(abs / ms);
      const plural = value === 1 ? name : `${name}s`;
      return delta >= 0 ? `in ${value} ${plural}` : `${value} ${plural} ago`;
    }
  }
  return delta >= 0 ? "in under a minute" : "just now";
}
