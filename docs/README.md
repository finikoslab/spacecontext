# Space Context docs

The developer documentation, published at https://spacecontext.app/developers/docs (the website builds it from `docs/` and `../openapi/openapi.json`). This folder is also a standalone Docusaurus site, with the API reference rendered by Scalar from `../openapi/openapi.json` (copied to `static/` before every start and build).

```bash
npm install
npm start          # http://localhost:3000
npm run build      # static site in build/, fails on any broken link
```

Write facts only after checking them against the API (its behaviour and the [OpenAPI contract](../openapi/openapi.json)) or the packages (`../packages`).
