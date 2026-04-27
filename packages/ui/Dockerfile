FROM node:22-alpine AS base
WORKDIR /app
RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/ui/package.json      ./packages/ui/
COPY packages/sdk/package.json     ./packages/sdk/
COPY packages/server/package.json  ./packages/server/
COPY packages/worker/package.json  ./packages/worker/
RUN pnpm install --frozen-lockfile

COPY packages/ui ./packages/ui


FROM base AS dev
ENV NODE_ENV=development
# Polling required for inotify inside Docker on macOS/Windows hosts
ENV CHOKIDAR_USEPOLLING=true
WORKDIR /app/packages/ui
CMD ["pnpm", "dev", "--host", "0.0.0.0"]


FROM base AS build
WORKDIR /app/packages/ui
RUN pnpm build

FROM nginx:alpine AS prod
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
COPY packages/ui/nginx.conf /etc/nginx/conf.d/default.conf
