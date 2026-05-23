# ATOP Auth Cookie Deployment Notes

## Recommended deployment mode

Prefer one of these two modes:

1. Same-origin reverse proxy
   Frontend serves `/` and proxies `/api` to backend.
   Recommended settings:
   - `VITE_API_BASE=/api`
   - `CORS_ALLOW_ORIGINS=` can stay empty if browser requests are same-origin
   - `COOKIE_SAME_SITE=lax`
   - `COOKIE_SECURE=auto`

2. Split frontend/backend origins
   Frontend and backend are deployed on different origins.
   Recommended settings:
   - `VITE_API_BASE=https://your-api-domain.com/api`
   - `CORS_ALLOW_ORIGINS=https://your-frontend-domain.com`
   - `CORS_ALLOW_CREDENTIALS=true`
   - `COOKIE_SAME_SITE=lax` for same-site subdomains, or `none` for true cross-site deployment
   - `COOKIE_SECURE=true` when `COOKIE_SAME_SITE=none`
   - `COOKIE_DOMAIN=` only set this when you intentionally need shared subdomain cookies

## Important rules

- Do not use `CORS_ALLOW_ORIGINS=*` in production unless you fully understand the credential risk.
- When `withCredentials=true`, browsers require `Access-Control-Allow-Credentials=true`.
- When `SameSite=None`, browsers require `Secure=true`.
- `EXTERNAL_URL` should point to the public backend URL so password-reset links and secure-cookie inference behave correctly.

## Example

```env
EXTERNAL_URL=https://api.example.com
CORS_ALLOW_ORIGINS=https://app.example.com
CORS_ALLOW_CREDENTIALS=true
COOKIE_DOMAIN=
COOKIE_SAME_SITE=none
COOKIE_SECURE=true
```
