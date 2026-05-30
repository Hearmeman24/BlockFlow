# Frontend Standalone Build

BlockFlow's distributable package ships a prebuilt Next.js frontend. End users
must not run `npm install`, `next build`, or `next dev` as part of startup.

The frontend uses Next's standalone output mode:

```bash
npm --prefix frontend run build
```

The build must produce:

- `frontend/.next/standalone/**/server.js`
- `frontend/.next/static/`
- `frontend/public/`

`npm run build` runs `frontend/scripts/verify-standalone-build.mjs` after
`next build` and fails if any required artifact is missing. The later npm
wrapper/package step should include the standalone directory, static assets,
and public assets in the published tarball.
