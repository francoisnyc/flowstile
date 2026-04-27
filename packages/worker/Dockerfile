FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/sdk/package.json     ./packages/sdk/
COPY packages/worker/package.json  ./packages/worker/
COPY packages/server/package.json  ./packages/server/
COPY packages/ui/package.json      ./packages/ui/
RUN pnpm install --frozen-lockfile

# Build SDK first — worker imports from @flowstile/sdk/activities and /workflows
COPY packages/sdk ./packages/sdk
RUN pnpm --filter @flowstile/sdk build

COPY packages/worker ./packages/worker


FROM base AS dev
ENV NODE_ENV=development
WORKDIR /app/packages/worker
CMD ["pnpm", "dev"]


FROM base AS build
WORKDIR /app/packages/worker
RUN pnpm build

FROM node:22-alpine AS prod
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json     ./packages/sdk/
COPY packages/worker/package.json  ./packages/worker/
COPY packages/server/package.json  ./packages/server/
COPY packages/ui/package.json      ./packages/ui/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/sdk/dist    ./packages/sdk/dist
COPY --from=build /app/packages/worker/dist ./packages/worker/dist
ENV NODE_ENV=production
WORKDIR /app/packages/worker
CMD ["node", "dist/main.js"]
