# Cinema backend: a single Node.js process, no dependencies.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
ENV PORT=3817 DATA_DIR=/data NODE_ENV=production
VOLUME /data
EXPOSE 3817
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3817/health || exit 1
CMD ["node", "server/index.js"]
