import type { BenchmarkMetricKey, BenchmarkProfile, BenchmarkResult, BenchmarkTimeseriesPoint } from "./types";

function parseDisplayDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string): string {
  const date = parseDisplayDate(value);
  if (!date) return value || "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatThroughput(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${formatNumber(value, 2)} MiB/s`;
}

export function formatOps(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${formatNumber(value, 2)} ops/s`;
}

export function formatErrors(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return String(value);
}

export function workloadsFromResults(results: BenchmarkResult[]): string[] {
  return Array.from(new Set(results.map((result) => result.workload).filter(Boolean))).sort();
}

export function profilesForWorkload(profiles: BenchmarkProfile[], workload: string): BenchmarkProfile[] {
  return profiles
    .filter((profile) => profile.workload === workload)
    .sort((left, right) => {
      const leftConcurrency = left.concurrency || 0;
      const rightConcurrency = right.concurrency || 0;
      if ((left.object_size || "") !== (right.object_size || "")) {
        return String(left.object_size || "").localeCompare(String(right.object_size || ""));
      }
      if (leftConcurrency !== rightConcurrency) {
        return leftConcurrency - rightConcurrency;
      }
      return String(left.prefix_mode || "").localeCompare(String(right.prefix_mode || ""));
    });
}

export function profileLabel(profile: BenchmarkProfile | null | undefined): string {
  if (!profile) return "No profile";
  return [profile.object_size, profile.concurrency ? `c${profile.concurrency}` : "", profile.prefix_mode]
    .filter(Boolean)
    .join(" / ");
}

export function providerResultsForProfile(
  results: BenchmarkResult[],
  profileId: string,
  metric: BenchmarkMetricKey,
): BenchmarkResult[] {
  return results
    .filter((result) => result.profile_id === profileId)
    .sort((left, right) => {
      const leftValue = Number(left[metric] ?? Number.NEGATIVE_INFINITY);
      const rightValue = Number(right[metric] ?? Number.NEGATIVE_INFINITY);
      if (leftValue !== rightValue) return rightValue - leftValue;
      return left.provider.localeCompare(right.provider);
    });
}

export function providerColor(provider: string): string {
  const colors: Record<string, string> = {
    rustfs: "#0f8f6f",
    seaweedfs: "#4a7cda",
    ceph: "#d84a3a",
    ozone: "#8b63d9",
  };
  return colors[provider] || "#5d7186";
}

export function timeseriesForProfile(
  points: BenchmarkTimeseriesPoint[],
  profileId: string,
  provider: string,
): BenchmarkTimeseriesPoint[] {
  return points
    .filter((point) => point.profile_id === profileId && point.provider === provider)
    .sort((left, right) => (left.segment_index || 0) - (right.segment_index || 0));
}
