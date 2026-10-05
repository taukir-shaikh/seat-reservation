FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# install deps first so this layer is cached when only code changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
