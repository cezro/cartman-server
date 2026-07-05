<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Database provisioning order

On a fresh database, apply `cartman-mobile/supabase/migrations/*.sql` first
(source of truth — creates `public.order_ref_seq` and the `orders.ref_no`
trigger, which `prisma db push` cannot create), then run `npx prisma db push`
second to sync `schema.prisma`. `prisma/seed.ts` also creates `order_ref_seq`
idempotently as a safety net if it's ever missing.

## Supabase Database Webhooks

`POST /webhooks/supabase` (`src/webhooks/webhooks.controller.ts`) receives
Supabase's Database Webhook payloads for the `orders` table and (today) logs
what push notification it would send — see "FCM push fan-out" below for the
exact current behavior.

To wire it up in the Supabase Dashboard:

1. **Settings → API** (or generate your own) — pick a long random secret and
   set it as `SUPABASE_WEBHOOK_SECRET` in this server's `.env`. There is no
   fallback default: if this var is unset, the endpoint rejects every request
   with 401 (see `.env.example`'s comment on the var).
2. **Database → Webhooks → Create a new hook**:
   - Table: `orders`
   - Events: `INSERT` and `UPDATE`
   - Type: HTTP Request → `POST`
   - URL: `https://<your-server-host>/webhooks/supabase` (use a tunnel like
     ngrok for local dev, since Supabase's hosted webhook dispatcher cannot
     reach `localhost`)
   - HTTP Headers: add `x-supabase-webhook-secret: <the same value as
     SUPABASE_WEBHOOK_SECRET>`
3. Save. Supabase will POST the changed row (plus the previous row, for
   `UPDATE`) as `{ type, table, record, old_record, schema }` on every insert
   or update to `orders`.

### FCM push fan-out — current state (C-4.2)

`WebhooksService.handleOrderWebhook` **only logs** what it would send today —
there is no `device_tokens` lookup, no FCM/firebase-admin SDK call, no
fan-out to on-duty riders when an order goes to `ready_for_pickup`, and no
wallet-lockout exclusion. On an `UPDATE` where `record.status !==
old_record.status`, it logs one line for the customer (`record.customer_id`)
and, if `record.assigned_rider_id` is set, one line for that rider. Real
push sending, `device_tokens` fan-out, and the lockout exclusion are still to
be built.

`FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY` (see
`.env.example`) are optional in Phase 1. If any are missing, the service logs
a warning and no-ops instead of attempting to send — it never crashes the
webhook (it always returns `{ success: true }` to Supabase so the dispatcher
doesn't retry indefinitely).

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
