import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeEndpointUrl, type UrlSafetyConfig } from "../src/infrastructure/security/url-safety.ts";
import { SecurityError } from "../src/shared/errors/app-error.ts";

const dev: UrlSafetyConfig = { nodeEnv: "development", allowLocalEndpoints: false };
const devWithLocal: UrlSafetyConfig = { nodeEnv: "development", allowLocalEndpoints: true };
const prod: UrlSafetyConfig = { nodeEnv: "production", allowLocalEndpoints: false };

interface Case {
  url: string;
  config: UrlSafetyConfig;
  allowed: boolean;
}

const cases: Case[] = [
  // Ordinary public destinations
  { url: "https://example.com/webhook", config: dev, allowed: true },
  { url: "http://example.com/webhook", config: dev, allowed: true },
  { url: "https://example.com/webhook", config: prod, allowed: true },

  // D6: http rejected under production, allowed in development
  { url: "http://example.com/webhook", config: prod, allowed: false },

  // Unsupported schemes
  { url: "file:///etc/passwd", config: dev, allowed: false },
  { url: "ftp://example.com/", config: dev, allowed: false },
  { url: "gopher://example.com/", config: dev, allowed: false },
  { url: "data:text/plain;base64,aGk=", config: dev, allowed: false },

  // Malformed
  { url: "not a url", config: dev, allowed: false },
  { url: "://missing-scheme", config: dev, allowed: false },

  // Embedded credentials
  { url: "https://user:pass@example.com/webhook", config: dev, allowed: false },

  // localhost / loopback — rejected by default, allowed only with the D5 flag
  { url: "http://localhost:3000/hook", config: dev, allowed: false },
  { url: "http://localhost:3000/hook", config: devWithLocal, allowed: true },
  { url: "http://127.0.0.1:3000/hook", config: dev, allowed: false },
  { url: "http://127.0.0.1:3000/hook", config: devWithLocal, allowed: true },
  { url: "http://[::1]:3000/hook", config: dev, allowed: false },
  { url: "http://[::1]:3000/hook", config: devWithLocal, allowed: true },
  // Non-standard numeric encodings of a loopback address
  { url: "http://2130706433/hook", config: dev, allowed: false }, // decimal 127.0.0.1
  { url: "http://0x7f000001/hook", config: dev, allowed: false }, // hex 127.0.0.1
  { url: "http://017700000001/hook", config: dev, allowed: false }, // octal 127.0.0.1
  // The D5 flag is never consulted under production, even if it were somehow true
  { url: "http://127.0.0.1:3000/hook", config: prod, allowed: false },

  // Regression: a trailing DNS root dot survives the WHATWG URL parser for
  // domain-name hosts and must not bypass the localhost rejection. Checked
  // under production configuration to rule out any D5 interaction.
  { url: "https://localhost./hook", config: prod, allowed: false },
  { url: "https://foo.localhost./hook", config: prod, allowed: false },
  { url: "https://ip6-localhost./hook", config: prod, allowed: false },
  // A dots-only host must not slip through as an "ordinary domain" either,
  // including after trailing-dot stripping reduces it further.
  { url: "https://.../hook", config: prod, allowed: false },
  { url: "https://../hook", config: prod, allowed: false },

  // Private ranges — never exempted by D5
  { url: "http://10.0.0.5/hook", config: dev, allowed: false },
  { url: "http://10.0.0.5/hook", config: devWithLocal, allowed: false },
  { url: "http://172.16.0.1/hook", config: dev, allowed: false },
  { url: "http://192.168.1.1/hook", config: dev, allowed: false },
  { url: "http://[fc00::1]/hook", config: dev, allowed: false },
  { url: "http://[fd12:3456::1]/hook", config: dev, allowed: false },

  // Link-local, including the common cloud metadata address
  { url: "http://169.254.169.254/hook", config: dev, allowed: false },
  { url: "http://169.254.169.254/hook", config: devWithLocal, allowed: false },
  { url: "http://[fe80::1]/hook", config: dev, allowed: false },

  // Unspecified
  { url: "http://0.0.0.0/hook", config: dev, allowed: false },
  { url: "http://0/hook", config: dev, allowed: false },

  // A private range does not become a domain name just because it isn't 127/8
  { url: "http://172.32.0.1/hook", config: dev, allowed: true },

  // RFC 6598 shared address space (100.64.0.0/10), including both edges of
  // the range. 100.63.x and 100.128.x sit outside it and stay allowed, so the
  // mask is not silently over-broad.
  { url: "http://100.64.0.1/hook", config: dev, allowed: false },
  { url: "http://100.127.255.254/hook", config: dev, allowed: false },
  { url: "https://100.64.0.1/hook", config: prod, allowed: false },
  { url: "http://100.63.255.255/hook", config: dev, allowed: true },
  { url: "http://100.128.0.1/hook", config: dev, allowed: true },

  // Oracle Cloud instance metadata, which falls outside the link-local range
  // that already covers 169.254.169.254. Neighbouring addresses in 192.0.0/24
  // are not part of this rule.
  { url: "http://192.0.0.192/hook", config: dev, allowed: false },
  { url: "https://192.0.0.192/hook", config: prod, allowed: false },
  { url: "http://192.0.0.191/hook", config: dev, allowed: true },

  // NAT64 well-known prefix (64:ff9b::/96): the embedded IPv4 address must be
  // classified by the IPv4 rules, not treated as an ordinary public IPv6 host.
  // a9fe:a9fe is 169.254.169.254, the cloud metadata address.
  { url: "http://[64:ff9b::a9fe:a9fe]/hook", config: dev, allowed: false },
  { url: "http://[64:ff9b::169.254.169.254]/hook", config: dev, allowed: false },
  { url: "https://[64:ff9b::a9fe:a9fe]/hook", config: prod, allowed: false },
  { url: "http://[64:ff9b::7f00:1]/hook", config: dev, allowed: false }, // 127.0.0.1
  { url: "http://[64:ff9b::a00:5]/hook", config: dev, allowed: false }, // 10.0.0.5
  { url: "http://[64:ff9b::6440:1]/hook", config: dev, allowed: false }, // 100.64.0.1
  // D5 keys off the resolved category, not the spelling, so a NAT64-embedded
  // loopback is exempted in development exactly as 127.0.0.1 and
  // ::ffff:127.0.0.1 already are — unchanged behavior, and never production.
  // A NAT64-embedded private range is still never exempted.
  { url: "http://[64:ff9b::7f00:1]/hook", config: devWithLocal, allowed: true },
  { url: "http://[64:ff9b::a00:5]/hook", config: devWithLocal, allowed: false },
  { url: "http://[64:ff9b::a9fe:a9fe]/hook", config: devWithLocal, allowed: false },
  // A NAT64-embedded public address is still a public destination.
  { url: "http://[64:ff9b::808:808]/hook", config: dev, allowed: true }, // 8.8.8.8

  // Regression: the existing ::ffff: IPv4-mapped handling still works after
  // the NAT64 branch was added alongside it.
  { url: "http://[::ffff:127.0.0.1]/hook", config: dev, allowed: false },
  { url: "http://[::ffff:169.254.169.254]/hook", config: dev, allowed: false },
  { url: "http://[::ffff:8.8.8.8]/hook", config: dev, allowed: true },
];

for (const { url, config, allowed } of cases) {
  test(`assertSafeEndpointUrl(${JSON.stringify(url)}, ${config.nodeEnv}/allowLocal=${config.allowLocalEndpoints}) is ${allowed ? "allowed" : "rejected"}`, () => {
    if (allowed) {
      assert.doesNotThrow(() => assertSafeEndpointUrl(url, config));
    } else {
      assert.throws(() => assertSafeEndpointUrl(url, config), SecurityError);
    }
  });
}
