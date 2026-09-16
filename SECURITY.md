# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Canari, please report it **privately** to help us fix it before public disclosure.

### How to Report

1. **Do NOT open a public GitHub Issue** for security vulnerabilities
2. Instead, email your report to the maintainers with:
   - Description of the vulnerability
   - Steps to reproduce (if applicable)
   - Potential impact
   - Suggested fix (if you have one)

3. **Expected Response Time:**
   - Initial acknowledgment: within 48 hours
   - Status updates: every 7 days
   - Fix and release: as soon as possible

### Security Contact

Please report security vulnerabilities by opening a [GitHub Security Advisory](https://github.com/emse-students/canari/security/advisories/new) with the "Report a vulnerability" option, or by contacting the project maintainers directly.

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| main    | ✅ Yes             |
| Other   | ❌ No              |

## What the Server Knows

Canari is end-to-end encrypted: **the server never holds a message body, a media file or a
reaction in clear.** All of it is MLS (RFC 9420) or Graine ciphertext, and media is sealed with a
content key the client generates before upload. No server-side key can open any of it.

That guarantee covers CONTENT. It does not cover everything, and the exposures below are accepted
deliberately rather than overlooked - each exists because a named feature cannot work without it.
They are listed here so that nobody has to rediscover them by reading the schema.

| The server holds, in clear | Why it cannot be encrypted |
|---|---|
| Account identity: first and last name, promo, formation | The directory people search to start a conversation |
| **Group names** (`dm_groups.name`) | The push notification title is composed server-side, and the server cannot decrypt to build it |
| Group membership and device membership | Routing: a frame is delivered to a recipient set the server must be able to enumerate |
| The time, size and sender device of every frame | Inherent to any store-and-forward transport |
| Community and channel names, and their membership | Server-authoritative by design: the server serves these objects to the UI |

**Storing a value in clear is not a licence to LOG it.** A log line copies the same text into
journald, where it outlives the row it came from, escapes every deletion the owner can ask for, and
is readable by anyone with shell access to the host. Group names were printed by `[CREATE_GROUP]`
and `[RENAME_GROUP]` until 2026-09-16; they are now printed as a byte count, the shape `[PUSH_SEND]`
already used for the identical value. **Any new log line touching a column in the table above owes
the same treatment.**

What the server does NOT have, and cannot obtain: message content, media content, reactions, the
MLS group secrets, or any key that would open them.

## Security Best Practices

### Dependencies
- We regularly update dependencies to patch known vulnerabilities
- Run `bun audit` regularly to check your local environment (this repository uses bun, never npm)
- Report any security issues found in dependencies separately

### Code Security
- Input validation is enforced across the application
- Authentication and authorization follow industry standards
- Sensitive data (keys, tokens) must not be committed to the repository

### Deployment
- Always use HTTPS in production
- Keep your deployment environment up-to-date
- Review and rotate security credentials regularly

## Additional Resources

- [Node Security Working Group](https://github.com/nodejs/security-wg)
- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [npm Security Best Practices](https://docs.npmjs.com/about-npm/security)
