# Space Context docs

The developer documentation at docs.spacecontext.finikos.it: Docusaurus, with the API reference rendered by Scalar from `../openapi/openapi.json` (copied to `static/` before every start and build).

```bash
npm install
npm start          # http://localhost:3000
npm run build      # static site in build/, fails on any broken link
```

Write facts only after checking them in the API (`../../spacecontext-backend/src/v1`) or the packages (`../packages`).
