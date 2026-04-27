FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g pnpm

# Install dependencies via monorepo lockfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/server/package.json  ./packages/server/
COPY packages/sdk/package.json     ./packages/sdk/
COPY packages/worker/package.json  ./packages/worker/
COPY packages/ui/package.json      ./packages/ui/
RUN pnpm install --frozen-lockfile

COPY packages/server ./packages/server


FROM base AS dev
ENV NODE_ENV=development
WORKDIR /app/packages/server
CMD ["pnpm", "dev"]


FROM base AS build
WORKDIR /app/packages/server
RUN pnpm build

FROM node:22-alpine AS prod
WORKDIR /app
RUN npm install -g pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json  ./packages/server/
COPY packages/sdk/package.json     ./packages/sdk/
COPY packages/worker/package.json  ./packages/worker/
COPY packages/ui/package.json      ./packages/ui/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/packages/server/dist ./packages/server/dist
ENV NODE_ENV=production
WORKDIR /app/packages/server
CMD ["node", "dist/main.js"]
