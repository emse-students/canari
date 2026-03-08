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

## Security Best Practices

### Dependencies
- We regularly update dependencies to patch known vulnerabilities
- Run `npm audit` regularly to check your local environment
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
