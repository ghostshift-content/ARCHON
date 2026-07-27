# ARCHON Vulnerable Lab

An intentionally vulnerable, localhost-only application used to exercise ARCHON's
black-box, static, and white-box workflows.

## Safety

- The server refuses to bind to a non-loopback address.
- The SSRF exercise only permits loopback destinations.
- Seed data is synthetic.
- Do not deploy this application or expose it through a tunnel.

## Run

```bash
npm start
```

The service listens on `http://127.0.0.1:4310`.

Seed accounts:

| Role | Email | Password |
|---|---|---|
| customer A | `alice` | `alicepass` |
| customer B | `bob` | `bobpass` |
| administrator | `admin` | `adminpass` |

Run the deterministic smoke suite with `npm test`.
