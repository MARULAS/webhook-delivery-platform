import type { NodeEnv } from "../../app/config.ts";
import { SecurityError } from "../../shared/errors/app-error.ts";

/**
 * Centralized outbound endpoint URL safety.
 *
 * This is the single decision point for whether a webhook destination is
 * safe to store and later deliver to (SPEC.md section 15, ARCHITECTURE.md
 * section 21, ENGINEERING_RULES.md section 17). It must be called at
 * endpoint creation and update (Part 2, this module's first caller) and
 * again immediately before each delivery attempt (Part 4), because DNS and
 * configuration can change between the two. Do not reimplement any part of
 * this check elsewhere.
 *
 * Known limitation, documented per SPEC.md section 15: this module validates
 * the literal host in the URL as given. It does not perform DNS resolution,
 * so a hostname that currently resolves to a public address but is later
 * repointed at an internal address (DNS rebinding) is not caught here. That
 * risk is explicitly accepted for this project's scope.
 */

export interface UrlSafetyConfig {
  readonly nodeEnv: NodeEnv;
  readonly allowLocalEndpoints: boolean;
}

type HostCategory = "loopback" | "private" | "link-local" | "unspecified" | "localhost" | "malformed" | null;

const LOCALHOST_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

function isLocalhostName(hostname: string): boolean {
  return LOCALHOST_NAMES.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * Matches a dotted-quad IPv4 literal. The WHATWG URL parser already
 * canonicalizes non-standard numeric encodings (decimal, hex, octal,
 * shorthand like "127.1") into this dotted-decimal form before `hostname` is
 * read, so this single check covers all of them.
 */
function parseIPv4(hostname: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return null;
  }
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function classifyIPv4(octets: [number, number, number, number]): HostCategory {
  const [a, b] = octets;
  if (a === 127) return "loopback";
  if (a === 0) return "unspecified"; // covers 0.0.0.0 and the rest of the reserved 0.0.0.0/8 block
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // covers the common cloud metadata address
  return null;
}

/**
 * Expands a bracket-stripped IPv6 host into its 8 numeric 16-bit groups,
 * resolving "::" compression. Returns null if the host does not parse as a
 * well-formed IPv6 address.
 */
function parseIPv6Groups(hostname: string): number[] | null {
  const parts = hostname.split("::");
  if (parts.length > 2) {
    return null;
  }

  let groups: string[];
  if (parts.length === 2) {
    const head = parts[0] === "" ? [] : parts[0].split(":");
    const tail = parts[1] === "" ? [] : parts[1].split(":");
    const missing = 8 - head.length - tail.length;
    if (missing < 0) {
      return null;
    }
    groups = [...head, ...(Array(missing).fill("0") as string[]), ...tail];
  } else {
    groups = hostname.split(":");
  }

  if (groups.length !== 8) {
    return null;
  }

  const nums: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
      return null;
    }
    nums.push(parseInt(group, 16));
  }
  return nums;
}

function classifyIPv6(nums: number[]): HostCategory {
  if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1) {
    return "loopback"; // ::1
  }
  if (nums.every((n) => n === 0)) {
    return "unspecified"; // ::
  }

  // IPv4-mapped IPv6 (::ffff:0:0/96): reclassify using the embedded IPv4
  // address so ::ffff:127.0.0.1 is treated the same as 127.0.0.1.
  if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) {
    const embedded: [number, number, number, number] = [
      (nums[6]! >> 8) & 0xff,
      nums[6]! & 0xff,
      (nums[7]! >> 8) & 0xff,
      nums[7]! & 0xff,
    ];
    return classifyIPv4(embedded);
  }

  if ((nums[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 (unique local)
  if ((nums[0]! & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  return null;
}

function classifyHostname(hostname: string): HostCategory {
  if (hostname.length === 0) {
    return "malformed";
  }
  if (isLocalhostName(hostname)) {
    return "localhost";
  }

  const ipv4 = parseIPv4(hostname);
  if (ipv4) {
    return classifyIPv4(ipv4);
  }

  if (hostname.includes(":")) {
    const groups = parseIPv6Groups(hostname);
    // Fail closed: a host containing ':' that we cannot confidently classify
    // is rejected rather than treated as an ordinary domain name.
    return groups ? classifyIPv6(groups) : "malformed";
  }

  // An ordinary domain name: not an IP literal, not localhost. Reject empty
  // labels (e.g. from "..", or a lone "." left after trailing-dot removal)
  // rather than silently treating a degenerate host as a valid domain.
  if (hostname.split(".").some((label) => label.length === 0)) {
    return "malformed";
  }

  return null;
}

/**
 * Throws SecurityError if `rawUrl` is not a safe outbound webhook
 * destination under `config`. Returns normally when the URL is acceptable.
 *
 * Error messages are deliberately generic categories (scheme, host,
 * malformed) rather than specific reasons, so a rejection never reveals
 * whether an internal host exists or what it resolved to.
 */
export function assertSafeEndpointUrl(rawUrl: string, config: UrlSafetyConfig): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SecurityError("Endpoint URL is malformed.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SecurityError("Endpoint URL must use http or https.");
  }

  // D6: https is required under production configuration; http remains
  // available in development so the local test receiver works.
  if (config.nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new SecurityError("Endpoint URL must use https.");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new SecurityError("Endpoint URL must not include embedded credentials.");
  }

  let hostname = parsed.hostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  } else if (hostname.endsWith(".")) {
    // A trailing DNS root dot survives the WHATWG URL parser for domain-name
    // hosts (though never for IPv4 literals, which are already normalized
    // without one). Strip exactly one so "localhost." normalizes to the
    // same value as "localhost" before classification — otherwise it
    // matches neither the exact-name set nor the ".localhost" suffix check
    // and falls through as an unclassified "ordinary domain", bypassing the
    // localhost rejection entirely.
    hostname = hostname.slice(0, -1);
  }

  const category = classifyHostname(hostname);

  if (category === "malformed") {
    throw new SecurityError("Endpoint URL is malformed.");
  }

  // D5: a single, explicit, development-only exemption for the local test
  // receiver. `config.allowLocalEndpoints` is already validated at config
  // load to be structurally impossible to be true under production
  // configuration (see app/config.ts); the `nodeEnv !== "production"` check
  // here is a second, independent guard so this exemption can never fire in
  // production even if that invariant were ever weakened elsewhere. The
  // exemption covers only loopback and localhost-name destinations, never
  // private or link-local ranges.
  const localExemptionApplies =
    config.nodeEnv !== "production" &&
    config.allowLocalEndpoints &&
    (category === "loopback" || category === "localhost");

  if (localExemptionApplies) {
    return;
  }

  if (category !== null) {
    throw new SecurityError("Endpoint URL host is not allowed.");
  }
}
