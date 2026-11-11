FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.mts ./
COPY src ./src
COPY db ./db
COPY test ./test
RUN npm run build
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && node dist/server.js"]
