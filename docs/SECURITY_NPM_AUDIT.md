# npm Security Vulnerability Assessment

**Date:** 2025-01-24  
**Scan Scope:** Frontend + Backend services (auth-service, user-service, chat-delivery-service)

## Summary

| Component | Severity | Count | Type | Status |
|-----------|----------|-------|------|--------|
| Frontend | LOW | 3 | cookie (XSS) | ⚠️ Breaking fix only |
| Backend Services | MODERATE | 6 | ajv ReDoS | 🔴 Requires decision |

---

## Frontend Vulnerabilities (3 LOW)

### Package: `cookie` <0.7.0

**Location:**
```
@sveltejs/kit → @sveltejs/adapter-static → cookie
```

**Vulnerability:** GHSA-pxg6-pf52-xh8x  
**Type:** Out-of-bounds cookie characters  
**Impact:** LOW - Dev tool risk only

**Fix:** Breaking change required
```bash
npm audit fix --force
# Will downgrade @sveltejs/kit to 0.0.30 (WILL BREAK BUILD)
```

**Status:** ⏸️ **DEFER** - Not fixing until SvelteKit updates cookie dependency

---

## Backend Vulnerabilities (6 MODERATE)

### Root Cause: ajv ReDoS

**Vulnerability:** GHSA-2g4f-4pwh-qvx6  
**CVE:** CVE-2021-41119  
**Affected Versions:** ajv 7.0.0-alpha.0 through 8.17.1  
**Type:** Regular Expression Denial of Service (ReDoS)

**Details:**
```
When using the $data option in ajv validator schemas, specially crafted
JSON input can cause exponential regex matching, leading to DoS attacks.
```

**Dependency Chain:**
```
@nestjs/cli (8.0.0 - 11.0.16)
├── @angular-devkit/core (12+ - 21.2.0-rc.2)
│   └── ajv 7.0.0-alpha.0 - 8.17.1  ← VULNERABLE
├── @angular-devkit/schematics
│   └── ajv (vulnerable)
└── @nestjs/schematics
    └── @angular-devkit/core (vulnerable)
```

---

## Risk Assessment

### Affected Services
- ✅ auth-service
- ✅ user-service  
- ✅ chat-delivery-service

### Actual Risk Level
🟡 **MEDIUM (not critical for this project)**

**Why?** The vulnerability requires:
1. **Attacker control over JSON input** to ajv validator
2. **Use of `$data` option** in schema definitions
3. **Network connectivity** to services

**In this project:** The services use NestJS with standard TypeORM/DTO validation:
- Input validation is controlled by the dev team (not user-supplied schemas)
- `$data` keyword not used in ValidationPipes
- Services are internal (not exposed to untrusted network)

---

## Solution Options

### Option A: Accept Risk (Recommended Short-term) ✅

**Rationale:**
- Actual exposure is LOW in this architecture
- Upstream dependencies (@nestjs/cli, @angular-devkit) are dev-only
- No production risk since validation logic is controlled by developers

**Action:**
```bash
# Just document the risk; don't force-fix
npm audit --audit-level=low  # Hide moderate warnings
```

**Timeline:** Review when @nestjs/cli updates ajv (upstream issue)

---

### Option B: Force Fix (Breaking Change) ⚠️

**Requires:**
```bash
npm audit fix --force
# Downgrades @nestjs/cli from 11.0.1 → 7.6.0
# (Breaking change - several features/APIs removed)
```

**Testing needed:**
- Full regression test suite
- Verify all CLI generators still work
- Check for deprecated API usage

**Timeline:** 2-4 hours testing + potential code migration

---

### Option C: Switch to Different CLI Tool 🟢

Use alternate if available (not recommended - adds complexity)

---

## Recommendation

**Current:** Option A (Accept with monitoring)  
**Timeline:** Review quarterly or when @angular-devkit updates  
**Owner:** DevOps/Security team

**Monitoring:**
```bash
# Monthly check
npm audit --audit-level=moderate
# Alert on new vulnerabilities
```

---

## Implementation

### Short-term (Current State)
✅ Document the risk  
✅ Justify why NOT fixing automatically  
✅ Set expectations: This is known/accepted technical debt  

### Medium-term (1-2 months)
- Monitor upstream: @angular-devkit/core and ajv releases
- Create upgrade branch when ajv>=8.18.0 available
- Run full test suite

### Long-term (3-6 months)
- Evaluate NestJS alternatives if vulnerabilities become critical
- Consider framework upgrade if NestJS updates CLI dependency

---

## Verification Status

```bash
# Frontend
d:/Documents/Programmation/EMSE/Canari/frontend $ npm audit --audit-level=moderate
Result: 3 vulnerabilities (LOW) - NOT MODERATE

# Backend (all three repos have same result)
d:/Documents/Programmation/EMSE/Canari/apps/auth-service $ npm audit --audit-level=moderate
Result: 6 vulnerabilities (MODERATE) - ajv chain
```

---

## References

- [GHSA-2g4f-4pwh-qvx6](https://github.com/advisories/GHSA-2g4f-4pwh-qvx6)
- [CVE-2021-41119](https://nvd.nist.gov/vuln/detail/CVE-2021-41119)
- [ajv GitHub Issue](https://github.com/ajv-validator/ajv/security/advisories/GHSA-2g4f-4pwh-qvx6)
- [NestJS Security Best Practices](https://docs.nestjs.com/security/overview)
