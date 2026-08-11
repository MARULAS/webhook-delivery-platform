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
