# Security Policy

## Supported Versions

Only the latest minor release receives security fixes.

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Email **security@reearth.io** with:

- a description of the vulnerability and its impact
- steps to reproduce, or a minimal proof of concept
- any mitigation you know of

You can expect an acknowledgement within **48 hours** and a resolution timeline within **90 days** (coordinated disclosure). Reporters are credited in the release notes unless they prefer to stay anonymous.

## Threat Model

- **Sentinel enforces nothing.** It is a service worker that attaches a credential to matching requests. Anyone can read a protected asset by sending the request without the worker. The server that holds the asset must check every read.
- **The token is readable by the page's origin.** The page hands the token to the worker with `updateToken`, and the worker keeps it in IndexedDB. Script running on the page's origin, such as an XSS payload or a compromised dependency, can read it. Use short-lived tokens scoped to asset reads, never a session or API credential. With `debug: true`, the worker also logs the token's first 20 characters.
- **Host matching is by substring in 0.1.x.** An entry with a port must equal the request's `host`. An entry without one matches any hostname that equals or contains it. With `protectedDomains: ["tiles.example.com"]`, a request to `tiles.example.com.attacker.test` also carries the token. Only list names for which every hostname containing them is yours. Exact host matching is planned for 1.0.0.
- **Protected requests send credentials.** In 0.1.x, intercepted requests use `credentials: "include"`, so the browser also sends cookies for the protected host. That host must not echo arbitrary origins in `Access-Control-Allow-Origin` with `Access-Control-Allow-Credentials: true`.
- **Cached responses outlive the token.** Cache strategies store protected responses in the Cache API under the sentinel namespace, without the token. A later reader on the same origin can read them until they expire or are evicted. Use `no-store` on responses that must not persist.
