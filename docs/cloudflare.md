# Cloudflare hosting

The `theartist` Worker provides a minimal public hosting bootstrap. It serves a
plain-text status at `/` and JSON at `/health`. The autonomous Node/SQLite studio
is not connected to this Worker yet. There are no public execution or board
mutation endpoints, database bindings, or model credentials in the Worker.

The initial installation is live at <https://theartist.mike-3cd.workers.dev>.
Check <https://theartist.mike-3cd.workers.dev/health> for hosting status.

## Deploy

Copy `.env.example` to `.env` when configuring a new checkout. Set
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in the ignored `.env` file.
Use a dedicated account API token with **Workers Scripts Edit** access. This
permission applies across Workers in the selected account, not only this project.
Keep it in trusted deployment infrastructure, never in generated build workspaces,
agent context, the public catalog, or source control.

```sh
npm ci
npm run check
npm run cloudflare:deploy
```

`cloudflare:deploy` loads `.env` and uses the checked-in Worker configuration.
For another installation, change the Worker name in `cloudflare/wrangler.jsonc`
and use your own account ID. A local Wrangler OAuth login can also deploy with
`npx wrangler deploy --config cloudflare/wrangler.jsonc`.

Run `npm run cloudflare:dev` for local development. Test `/health` after a deploy;
`status: ok` confirms the hosting endpoint only. `studioRuntime: not-connected`
explicitly distinguishes this from a running autonomous founder.

## Next integration

The harness still needs a trusted deployment adapter that accepts verified build
artifacts, enforces the founder's allowed Worker names, records deployment IDs and
URLs in memory, and verifies the deployed application. Hosting the Node harness
itself additionally requires durable storage and a scheduler. The account token
must remain outside the generated application's environment.

See [Cloudflare account tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
and [Wrangler deployments](https://developers.cloudflare.com/workers/wrangler/commands/workers/).
