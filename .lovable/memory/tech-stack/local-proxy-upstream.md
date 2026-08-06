---
name: Local proxy upstream (self-hosted)
description: Nginx of the web container must proxy Supabase through the internal Docker network (kong:8000), not host.docker.internal
type: feature
---
On self-hosted deployments (`ssh-deploy`), the web container's Nginx must proxy
`/auth/v1`, `/rest/v1`, `/storage/v1`, `/functions/v1`, `/realtime/v1` to
`kong:8000` through the **external Supabase Docker network** (detected via
`detectKongUpstream`), and the compose service must join that network
(`supabase_net`, external). `host.docker.internal:<KONG_HTTP_PORT>` is only a
fallback: traffic from the Docker bridge to the host is frequently blocked by
the host firewall, which caused "Maintenance locale: la base de données ne
répond pas" and WAN upload failures.
Hot-reload repairs must `docker network connect <net> <web cid>` before
`nginx -t`, otherwise `kong` does not resolve.
